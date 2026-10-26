import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export interface RuntimeSmokeOptions {
  /** OpenCode V2 executable supplied by the caller. */
  readonly binaryPath: string
  /** Repo-local scratch directory; removed and recreated on every run. */
  readonly stateRoot: string
  /** Repository root. The harness refuses to write or execute outside it. */
  readonly repositoryRoot: string
  /** Directory containing the plugin fixture OpenCode should load. */
  readonly fixturePath: string
  /** File the fixture writes after the production plugin setup completes. */
  readonly markerPath: string
  /** File the fixture writes when its own setup runs (used by the negative control). */
  readonly completionMarkerPath?: string
  /** Overall budget in milliseconds. */
  readonly timeoutMs: number
}

export interface RuntimeSmokeResult {
  /** Parsed production marker, when one was created. */
  readonly marker: unknown
  /** Why the positive gate failed, when it did. */
  readonly error?: string
  /** Whether the configured fixture's own setup ran. */
  readonly fixtureLoaded: boolean
  /** Where the redacted server output was preserved. */
  readonly logPath: string
}

export interface ServerEndpoint {
  readonly url: string
  readonly password?: string
}

const ENDPOINT_PATTERN = /server listening on (https?:\/\/\S+)/
/** Scans for a password in any of the shapes a server might print it. */
const PASSWORD_SCAN_PATTERN = /((?:server\s+)?password[\s:=]+)(\S+)/i
/** Redacts every password occurrence, whatever its case or separator. */
const PASSWORD_REDACT_PATTERN = /((?:server\s+)?password[\s:=]+)(\S+)/gi
/** Redacts a Basic credential, which encodes the password rather than naming it. */
const BASIC_REDACT_PATTERN = /(\bBasic\s+)([A-Za-z0-9+/=]{8,})/g

/** Maximum amount of server output retained in memory and on disk. */
export const MAX_CAPTURE_BYTES = 1_000_000
/** Maximum time the harness will wait for the server. */
export const MAX_RUNTIME_TIMEOUT_MS = 300_000
/** How long the harness waits for the password after the URL has arrived. */
const PASSWORD_WAIT_MS = 5_000
/** Longest unfinished output line kept while waiting for its newline. */
const MAX_PARTIAL_LINE = 8_192

/**
 * The runtime budget, in milliseconds.
 *
 * The upper bound keeps a verification run from filling the disk with server
 * output or holding a port open for hours.
 */
export function parseRuntimeTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "30000", 10)
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > MAX_RUNTIME_TIMEOUT_MS) {
    throw new Error(
      `the runtime timeout must be an integer between 1000 and ${MAX_RUNTIME_TIMEOUT_MS} milliseconds`,
    )
  }
  return parsed
}

/**
 * Bounded, incrementally parsed capture of the server's stdout and stderr.
 *
 * The server is started at DEBUG log level and may be chatty, so the capture
 * keeps only the most recent bytes and scans each line once instead of
 * re-scanning the whole buffer on every poll.
 */
export class ServerOutput {
  readonly limit: number
  #partial = ""
  #lines: string[] = []
  #size = 0
  #truncated = false
  #url: string | undefined
  #password: string | undefined

  constructor(limit: number = MAX_CAPTURE_BYTES) {
    this.limit = limit
  }

  append(chunk: string): void {
    this.#partial += chunk

    // The server may print its address without a trailing newline, so the
    // unfinished line is scanned too.
    this.#scan(this.#partial)

    let index = this.#partial.indexOf("\n")
    while (index >= 0) {
      const line = this.#partial.slice(0, index)
      this.#partial = this.#partial.slice(index + 1)
      this.#record(line)
      this.#scan(line)
      index = this.#partial.indexOf("\n")
    }

    if (this.#partial.length > MAX_PARTIAL_LINE) {
      this.#record(this.#partial)
      this.#partial = ""
    }
  }

  /** The address the server reported, once it has reported one. */
  get url(): string | undefined {
    return this.#url
  }

  /** The password the server reported, once it has reported one. */
  get password(): string | undefined {
    return this.#password
  }

  /** Whether output was dropped to keep the capture bounded. */
  get truncated(): boolean {
    return this.#truncated
  }

  /** The retained output, with a marker where older output was dropped. */
  get text(): string {
    const body = this.#lines.join("\n")
    const tail = this.#partial ? `${body ? "\n" : ""}${this.#partial}` : ""
    const marker = this.#truncated ? "[...earlier output truncated...]\n" : ""
    return `${marker}${body}${tail}`
  }

  #record(line: string): void {
    this.#lines.push(line)
    this.#size += line.length + 1

    while (this.#size > this.limit && this.#lines.length > 1) {
      const removed = this.#lines.shift()
      if (removed === undefined) break
      this.#size -= removed.length + 1
      this.#truncated = true
    }
  }

  #scan(text: string): void {
    if (this.#url === undefined) {
      this.#url = text.match(ENDPOINT_PATTERN)?.[1]
    }
    if (this.#password === undefined) {
      this.#password = text.match(PASSWORD_SCAN_PATTERN)?.[2]
    }
  }
}

/** The address the server reported, if any. */
export function parseServerEndpoint(output: string): ServerEndpoint | undefined {
  const url = output.match(ENDPOINT_PATTERN)?.[1]
  if (!url) return undefined

  return { url, password: parseServerPassword(output) }
}

/** The password the server reported, if any. */
export function parseServerPassword(output: string): string | undefined {
  return output.match(PASSWORD_SCAN_PATTERN)?.[2]
}

/**
 * Whether an address is on the loopback interface.
 *
 * The harness sends the server's password to the address the server reported,
 * so that address must never point off the machine.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "::1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Removes the ephemeral server password before any output is written to disk.
 *
 * Three shapes are covered: the literal token, the token in any "password"
 * phrasing, and the Basic credential the harness itself sends (which encodes
 * the token rather than naming it).
 */
export function redactServerSecrets(output: string, knownSecret?: string): string {
  let redacted = output

  if (knownSecret && knownSecret.length > 0) {
    redacted = redacted.split(knownSecret).join("[redacted]")

    const basic = Buffer.from(`opencode:${knownSecret}`).toString("base64")
    if (basic.length > 0) redacted = redacted.split(basic).join("[redacted]")
  }

  redacted = redacted.replace(
    PASSWORD_REDACT_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted]`,
  )
  redacted = redacted.replace(
    BASIC_REDACT_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted]`,
  )

  return redacted
}

export interface ProductionMarker {
  readonly pluginID: string
  readonly location: string
  readonly setupCompleted: boolean
  readonly providers: string[]
  readonly hooks: Array<{ readonly name: string; readonly providerID?: string }>
}

/**
 * Plugin ids OpenCode reports as loaded, read from its own debug log.
 *
 * The gate uses this to prove isolation: OpenCode discovers plugins in every
 * `.opencode/plugins` directory above the activated location, so the operator's
 * own `~/.opencode/plugins` would otherwise be loaded during a verification run.
 */
export function parseLoadedPluginIds(log: string): string[] {
  const ids: string[] = []
  for (const match of log.matchAll(/msg="loading plugin"\s+id=(\S+)/g)) {
    ids.push(match[1])
  }
  return ids
}

/**
 * The operator's real configuration directories. A verification run must never
 * read them: the plugin under test must be proven in isolation.
 *
 * The XDG directories are included because OpenCode reads its data from
 * `<XDG_DATA_HOME>/opencode`, which is not under the home directory by default
 * on every system.
 */
export function operatorConfigDirectories(
  operatorHome: string,
  environment: Record<string, string | undefined> = {},
): string[] {
  if (!operatorHome) return []

  const directories = new Set<string>()
  directories.add(join(operatorHome, ".opencode"))
  directories.add(join(operatorHome, ".config", "opencode"))
  directories.add(join(operatorHome, ".local", "share", "opencode"))

  if (environment.XDG_CONFIG_HOME) directories.add(join(environment.XDG_CONFIG_HOME, "opencode"))
  if (environment.XDG_DATA_HOME) directories.add(join(environment.XDG_DATA_HOME, "opencode"))
  if (environment.XDG_STATE_HOME) directories.add(join(environment.XDG_STATE_HOME, "opencode"))

  return [...directories]
}

/** Operator configuration directories referenced by the server log. */
export function findOperatorHomeReferences(
  log: string,
  directories: readonly string[],
): string[] {
  return directories.filter((directory) => log.includes(directory))
}

/** Compares the loaded plugin ids against the one plugin the gate expects. */
export function comparePluginIds(
  loaded: readonly string[],
  expected: readonly string[],
): { unexpected: string[]; missing: string[] } {
  const loadedSet = new Set(loaded)
  const expectedSet = new Set(expected)
  return {
    unexpected: [...loadedSet].filter((id) => !expectedSet.has(id)),
    missing: [...expectedSet].filter((id) => !loadedSet.has(id)),
  }
}

/** Validates the marker and the hook registrations the production setup performed. */
export function validateProductionMarker(marker: unknown): { ok: true; marker: ProductionMarker } | { ok: false; reason: string } {
  if (typeof marker !== "object" || marker === null) {
    return { ok: false, reason: "the setup marker is not an object" }
  }

  const candidate = marker as Partial<ProductionMarker>

  if (candidate.pluginID !== "opencode-nvidia-provider") {
    return { ok: false, reason: `unexpected plugin id: ${JSON.stringify(candidate.pluginID)}` }
  }

  if (candidate.setupCompleted !== true) {
    return { ok: false, reason: "the production setup did not complete" }
  }

  if (!Array.isArray(candidate.providers) || candidate.providers.length === 0) {
    return { ok: false, reason: "the plugin registered no providers" }
  }

  if (!Array.isArray(candidate.hooks)) {
    return { ok: false, reason: "the plugin recorded no hook registrations" }
  }

  for (const provider of candidate.providers) {
    for (const hookName of ["http.response", "retry"]) {
      const matching = candidate.hooks.filter(
        (hook) => hook.name === hookName && hook.providerID === provider,
      )
      if (matching.length !== 1) {
        return {
          ok: false,
          reason: `expected exactly one "${hookName}" hook for provider "${provider}", found ${matching.length}`,
        }
      }
    }
  }

  if (candidate.hooks.length !== candidate.providers.length * 2) {
    return {
      ok: false,
      reason: `expected ${candidate.providers.length * 2} hook registrations, found ${candidate.hooks.length}`,
    }
  }

  return { ok: true, marker: candidate as ProductionMarker }
}

/** Whether `child` is inside `parent`. */
function isInside(child: string, parent: string): boolean {
  const relation = relative(parent, child)
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation)
}

export interface StateRootGuard {
  /** Repository root the harness is allowed to write inside. */
  readonly repositoryRoot: string
  /** The operator's real home directory, when it is known. */
  readonly homeDirectory?: string
}

/**
 * Refuses a state directory the harness must not delete.
 *
 * The harness removes this directory before every run, so the path has to be
 * provably a scratch directory inside the repository: not the filesystem root,
 * not a top-level directory, not the home directory, not an ancestor of the
 * home directory, and not the repository root itself.
 */
export function assertSafeStateRoot(stateRoot: string, guard: StateRootGuard): void {
  const resolved = resolve(stateRoot)
  const repositoryRoot = resolve(guard.repositoryRoot)
  const reasons: string[] = []

  if (resolved === "/") reasons.push("it is the filesystem root")
  if (dirname(resolved) === "/") reasons.push("it is a top-level directory")
  if (resolved === repositoryRoot) reasons.push("it is the repository root")
  if (!isInside(resolved, repositoryRoot)) reasons.push("it is not inside the repository root")

  if (guard.homeDirectory) {
    const home = resolve(guard.homeDirectory)
    if (resolved === home) reasons.push("it is the home directory")
    if (isInside(home, resolved)) reasons.push("it contains the home directory")
  }

  if (reasons.length > 0) {
    throw new Error(
      `refusing to use an unsafe runtime state directory (${resolved}): ${reasons.join("; ")}`,
    )
  }
}

/**
 * Refuses a fixture outside the repository.
 *
 * The harness asks OpenCode to load the fixture, which means executing it, so
 * the path must stay inside the repository the harness is testing.
 */
export function assertFixtureInsideRepository(
  fixturePath: string,
  repositoryRoot: string,
): void {
  if (!isAbsolute(fixturePath)) {
    throw new Error(`the fixture path must be absolute (got ${fixturePath})`)
  }

  const resolved = resolve(fixturePath)
  if (!isInside(resolved, resolve(repositoryRoot))) {
    throw new Error(
      `refusing to load a fixture outside the repository (${resolved})`,
    )
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Stops the server and everything it started.
 *
 * The child owns its own process group, so the whole group is signalled. The
 * group is signalled unconditionally: a descendant can outlive the leader it
 * was spawned with, and skipping the signal in that case leaves the
 * descendant running, holding the port, the database and the state tree.
 *
 * Returns whether the group is gone.
 */
export async function stopChild(child: ChildProcess): Promise<boolean> {
  const pid = child.pid
  if (pid === undefined) return true

  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }

  if (child.exitCode === null && child.signalCode === null) {
    // The child owns its own process group, so the whole group is signalled.
    if (!signalGroup("SIGTERM")) child.kill("SIGTERM")

    await Promise.race([
      new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      new Promise<void>((resolveExit) => setTimeout(resolveExit, 2_000)),
    ])
  }

  // Give the group a chance to go away on its own after SIGTERM.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processGroupExists(pid)) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }

  // The group is signalled unconditionally, even when the leader has already
  // exited: a descendant can outlive the leader it was spawned with, and
  // skipping the signal would leave it running, holding the port, the database
  // and the state tree.
  if (processGroupExists(pid)) signalGroup("SIGKILL")

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processGroupExists(pid)) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }

  return !processGroupExists(pid)
}

async function readFileIfPresent(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Waits for the production marker. When a completion marker is configured, the
 * fixture also reports when its own setup ran, so a negative control can finish
 * early instead of burning the whole timeout.
 */
async function waitForProductionMarker(
  markerPath: string,
  completionMarkerPath: string | undefined,
  deadline: number,
): Promise<{ marker: unknown; fixtureLoaded: boolean }> {
  while (Date.now() < deadline) {
    const marker = await readFileIfPresent(markerPath)
    if (marker !== undefined) return { marker, fixtureLoaded: true }

    if (completionMarkerPath) {
      const completed = await readFileIfPresent(completionMarkerPath)
      if (completed !== undefined) {
        // The fixture loaded. Give a late production marker a short grace window
        // so the absence check cannot pass because of a race.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
        const lateMarker = await readFileIfPresent(markerPath)
        return { marker: lateMarker, fixtureLoaded: true }
      }
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }

  return { marker: undefined, fixtureLoaded: false }
}

/**
 * Refuses an address that is not on the loopback interface.
 *
 * The harness sends the server's password to the address the server reported,
 * so that address must never point off the machine.
 */
export function assertLoopbackEndpoint(url: string): void {
  if (!isLoopbackUrl(url)) {
    throw new Error(`refusing to send the server password to a non-loopback address (${url})`)
  }
}

/**
 * Asks the local server to activate a project location. Starting `serve` alone
 * does not initialise a location, and therefore does not load its plugins.
 */
async function activateLocation(endpoint: ServerEndpoint, directory: string): Promise<void> {
  assertLoopbackEndpoint(endpoint.url)

  const url = new URL("/api/location", endpoint.url)
  url.searchParams.set("location[directory]", directory)

  const headers: Record<string, string> = {}
  if (endpoint.password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`
  }

  const response = await fetch(url, { headers })
  await response.body?.cancel()

  if (!response.ok) {
    throw new Error(`OpenCode location activation failed with HTTP ${response.status}`)
  }
}

/**
 * The environment the OpenCode child receives. Provider credentials and the
 * operator's own environment are deliberately not inherited: the verification
 * run must not be able to read a secret, and must not load operator plugins.
 */
function childEnvironment(options: RuntimeSmokeOptions): NodeJS.ProcessEnv {
  const inherited = ["PATH", "LANG", "LC_ALL", "SHELL"]
  const env: NodeJS.ProcessEnv = {}

  for (const key of inherited) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  env.HOME = options.stateRoot
  // OpenCode resolves its home directory through this variable; without it the
  // server reads the operator's real ~/.opencode tree and loads their plugins.
  env.OPENCODE_TEST_HOME = options.stateRoot
  env.XDG_CONFIG_HOME = join(options.stateRoot, "config")
  env.XDG_DATA_HOME = join(options.stateRoot, "data")
  env.XDG_STATE_HOME = join(options.stateRoot, "state")
  env.XDG_CACHE_HOME = join(options.stateRoot, "cache")
  env.OPENCODE_CONFIG_DIR = join(options.stateRoot, "config", "opencode")
  // Keep OpenCode's scratch files inside the repo-local state directory.
  env.TMPDIR = join(options.stateRoot, "tmp")
  env.OPENCODE_NVIDIA_RUNTIME_MARKER = options.markerPath
  env.OPENCODE_NVIDIA_RUNTIME_CONTROL_MARKER = options.completionMarkerPath ?? ""
  env.OPENCODE_LOG_LEVEL = "DEBUG"

  return env
}

export async function runRuntimeSmoke(options: RuntimeSmokeOptions): Promise<RuntimeSmokeResult> {
  const configDirectory = join(options.stateRoot, "config", "opencode")
  const configPath = join(configDirectory, "opencode.json")
  const tempDirectory = join(options.stateRoot, "tmp")
  const logPath = join(options.stateRoot, "opencode.log")
  const serverLogPath = join(options.stateRoot, "data", "opencode", "log", "opencode.log")

  // The activated location IS the isolated global config directory, on purpose.
  // OpenCode discovers `.opencode/` configuration in every ancestor directory of
  // the activated location, so a location inside the operator's home would load
  // the operator's own `~/.opencode/plugins`. Activating the global config
  // directory itself makes OpenCode skip that ancestor walk.
  const locationDirectory = configDirectory

  // The operator's real home, captured before the child environment is built.
  // `homedir()` is the fallback for environments where HOME is not set, so the
  // isolation check never passes vacuously.
  const operatorHome = process.env.HOME?.trim() || homedir()
  const operatorDirectories = operatorConfigDirectories(operatorHome, process.env)

  // The resolved fixture path is what OpenCode is told to load and what the
  // isolation check compares against: one value, not two.
  assertFixtureInsideRepository(options.fixturePath, options.repositoryRoot)
  const fixturePath = await realpath(options.fixturePath).catch(() => {
    throw new Error(`the fixture path does not exist: ${options.fixturePath}`)
  })

  // A repository cloned inside the operator's own config directory cannot be
  // distinguished from the operator's files in the log; skip that one check.
  const fixtureInsideOperatorConfig = operatorDirectories.some(
    (directory) => fixturePath === directory || fixturePath.startsWith(`${directory}/`),
  )

  await access(options.binaryPath, constants.X_OK)
  assertSafeStateRoot(options.stateRoot, {
    repositoryRoot: options.repositoryRoot,
    homeDirectory: process.env.HOME,
  })
  await rm(options.stateRoot, { recursive: true, force: true })
  await mkdir(configDirectory, { recursive: true })
  await mkdir(tempDirectory, { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugins: [fixturePath],
    }),
    "utf8",
  )

  const spawned = spawn(options.binaryPath, ["serve", "--port", "0"], {
    cwd: locationDirectory,
    detached: true,
    env: childEnvironment(options),
    stdio: ["ignore", "pipe", "pipe"],
  })

  const output = new ServerOutput()
  const capture = (chunk: Buffer) => {
    output.append(chunk.toString("utf8"))
  }
  spawned.stdout.on("data", capture)
  spawned.stderr.on("data", capture)

  let endpoint: ServerEndpoint | undefined
  let failure: string | undefined
  let fixtureLoaded = false
  let marker: unknown

  try {
    const deadline = Date.now() + options.timeoutMs
    while (Date.now() < deadline && !endpoint) {
      if (output.url) {
        endpoint = { url: output.url, password: output.password }
        break
      }
      if (spawned.exitCode !== null) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }

    if (endpoint && !endpoint.password) {
      // The password may arrive after the address. Wait for it briefly, because
      // the activation request authenticates with it.
      const passwordDeadline = Math.min(deadline, Date.now() + PASSWORD_WAIT_MS)
      while (Date.now() < passwordDeadline && !output.password) {
        if (spawned.exitCode !== null) break
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
      }
      endpoint = { url: endpoint.url, password: output.password }
    }

    if (!endpoint) {
      failure = `OpenCode did not report a listening server within ${options.timeoutMs}ms`
    } else {
      try {
        await activateLocation(endpoint, locationDirectory)
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }

    if (!failure) {
      const result = await waitForProductionMarker(
        options.markerPath,
        options.completionMarkerPath,
        deadline,
      )
      fixtureLoaded = result.fixtureLoaded
      marker = result.marker

      if (result.marker === undefined) {
        failure = fixtureLoaded
          ? "the plugin fixture loaded, but the production setup marker was never created"
          : `Plugin setup marker was not created within ${options.timeoutMs}ms`
      } else {
        const validation = validateProductionMarker(result.marker)
        if (!validation.ok) {
          failure = `Plugin setup marker is invalid: ${validation.reason}`
        }
      }
    }
  } finally {
    const stopped = await stopChild(spawned)
    if (!stopped && !failure) {
      failure = "the OpenCode process group did not exit; a descendant may still be running"
    }

    // The password may have arrived after the endpoint was parsed, so the
    // final redaction uses whatever the complete capture knows.
    const secret = output.password ?? endpoint?.password
    const redacted = redactServerSecrets(output.text, secret)
    await writeFile(logPath, redacted, "utf8")

    // OpenCode writes its own debug log. Redact the known password in it too,
    // so the retained diagnostics cannot contain the credential.
    const serverLog = await readFile(serverLogPath, "utf8").catch(() => undefined)
    if (serverLog === undefined) {
      // Without the server's own log there is no evidence of what was loaded.
      // An absent log is not evidence of a clean run, so the gate fails closed.
      failure =
        failure ??
        "the OpenCode server log was not found; plugin isolation could not be verified"
    } else {
      const redactedServerLog = redactServerSecrets(serverLog, secret)
      await writeFile(serverLogPath, redactedServerLog, "utf8")

      // Isolation proof: the run must have loaded exactly the fixture plugin,
      // and must not have read the operator's own configuration.
      const loadedIds = await Promise.all(
        parseLoadedPluginIds(redactedServerLog).map(async (id) =>
          (await realpath(id).catch(() => id)),
        ),
      )
      const comparison = comparePluginIds(loadedIds, [fixturePath])
      if (comparison.unexpected.length > 0 || comparison.missing.length > 0) {
        failure = failure ?? isolationFailure(comparison.unexpected, comparison.missing)
      }

      if (!fixtureInsideOperatorConfig) {
        const references = findOperatorHomeReferences(redactedServerLog, operatorDirectories)
        if (references.length > 0) {
          failure = failure ?? `the OpenCode server read the operator's own configuration: ${references.join(", ")}`
        }
      }
    }
  }

  return { marker, error: failure, fixtureLoaded, logPath }
}

function isolationFailure(unexpected: readonly string[], missing: readonly string[]): string {
  const parts: string[] = []
  if (unexpected.length > 0) parts.push(`unexpected plugins loaded: ${unexpected.join(", ")}`)
  if (missing.length > 0) parts.push(`expected plugin not loaded: ${missing.join(", ")}`)
  return `runtime isolation check failed (${parts.join("; ")})`
}
