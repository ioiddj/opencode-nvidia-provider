import { spawn } from "node:child_process"
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

import {
  assertSafeStateRoot,
  findOperatorHomeReferences,
  operatorConfigDirectories,
  redactServerSecrets,
  ServerOutput,
  stopChild,
} from "./smoke.ts"

/**
 * The published package this harness verifies.
 *
 * The default is the end-user path documented in the README: OpenCode installs
 * the plugin from the GitHub repository, not from a local checkout. A different
 * specifier can be supplied to check the same machinery against a fork.
 */
export const DEFAULT_PUBLISHED_SPEC = "github:ioiddj/opencode-nvidia-provider"

/** How long the harness waits for the password after the address arrives. */
const PASSWORD_WAIT_MS = 5_000

/** How often the harness polls the server log for the plugin load. */
const POLL_INTERVAL_MS = 100

/** Bounds on the package walk, so a huge cache cannot stall the run. */
const MAX_WALK_DEPTH = 8
const MAX_WALK_ENTRIES = 5_000

/**
 * The plugin specifiers a global configuration declares.
 *
 * An unreadable or unexpected configuration yields an empty list rather than
 * an exception: the caller decides whether the missing specifier is a failure.
 */
export function parsePluginSpecs(config: unknown): string[] {
  if (typeof config !== "object" || config === null) return []
  const plugins = (config as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return []
  return plugins.filter((entry): entry is string => typeof entry === "string")
}

export interface PackageLayout {
  /** Every file in the installed package, relative to its root. */
  readonly files: readonly string[]
  /** Installed dependency directories, which the published package must not have. */
  readonly dependencyDirectories: readonly string[]
}

/**
 * Lists the files of an installed package and any dependency directories.
 *
 * The walk is bounded in depth and in the number of entries it visits, so a
 * cache with an unexpected shape cannot turn this into an unbounded scan.
 */
export async function inspectPackageLayout(packageDir: string): Promise<PackageLayout> {
  const files: string[] = []
  const dependencyDirectories: string[] = []
  const stack: Array<{ dir: string; prefix: string; depth: number }> = [
    { dir: packageDir, prefix: "", depth: 0 },
  ]
  let visited = 0

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES) break
    visited += 1

    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const relativePath = current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`
      const absolutePath = join(current.dir, entry.name)

      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          dependencyDirectories.push(relativePath)
          continue
        }
        stack.push({ dir: absolutePath, prefix: relativePath, depth: current.depth + 1 })
        continue
      }

      files.push(relativePath)
    }
  }

  files.sort()
  dependencyDirectories.sort()
  return { files, dependencyDirectories }
}

/**
 * Finds the directories an installer unpacked the plugin into.
 *
 * A package is recognised by the shape the published repository has: an
 * entrypoint file and a source directory next to it.
 */
export async function findInstalledPackages(cacheRoot: string): Promise<string[]> {
  const candidates: Array<{ path: string; modified: number }> = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: cacheRoot, depth: 0 }]
  let visited = 0

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES) break
    visited += 1

    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const absolutePath = join(current.dir, entry.name)
      const hasEntrypoint = await exists(join(absolutePath, "index.ts"))
      const hasSources = await exists(join(absolutePath, "src"))
      if (hasEntrypoint && hasSources) {
        const info = await stat(absolutePath).catch(() => undefined)
        candidates.push({ path: absolutePath, modified: info?.mtimeMs ?? 0 })
        continue
      }
      stack.push({ dir: absolutePath, depth: current.depth + 1 })
    }
  }

  // The most recently written candidate is the one the installer just placed.
  candidates.sort((left, right) => right.modified - left.modified)
  return candidates.map((candidate) => candidate.path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export interface PluginLoad {
  /** The plugin identifier OpenCode reported. */
  readonly id: string
  /** The entrypoint OpenCode reported, without its `file://` prefix. */
  readonly entrypoint: string
}

/**
 * Reads the plugin loads OpenCode reported in its own debug log.
 *
 * The entrypoint is what proves *which* file was loaded, so it is kept:
 * a load of some other plugin cannot satisfy this gate.
 */
export function parsePluginLoads(log: string): PluginLoad[] {
  const loads: PluginLoad[] = []

  for (const line of log.split("\n")) {
    if (!line.includes('msg="loading plugin"')) continue
    const id = /\bid=(\S+)/.exec(line)?.[1]
    const rawEntrypoint = /\bentrypoint=(\S+)/.exec(line)?.[1]
    if (id === undefined || rawEntrypoint === undefined) continue
    const entrypoint = rawEntrypoint.startsWith("file://")
      ? rawEntrypoint.slice("file://".length)
      : rawEntrypoint
    loads.push({ id, entrypoint })
  }

  return loads
}

/**
 * Whether a reported plugin load refers to a file inside the package.
 *
 * The comparison is made on resolved paths, so a load of an unrelated plugin
 * that merely mentions the package name cannot pass.
 */
export function loadTargetsPackage(load: PluginLoad, packageDir: string): boolean {
  const relation = relative(resolve(packageDir), resolve(load.entrypoint))
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation)
}

export interface PublishedInstallOptions {
  /** OpenCode V2 executable supplied by the caller. */
  readonly binaryPath: string
  /** Repo-local scratch directory; removed and recreated on every run. */
  readonly stateRoot: string
  /** Repository root. The harness refuses to write outside it. */
  readonly repositoryRoot: string
  /** The plugin specifier to install. */
  readonly spec: string
  /** Overall budget in milliseconds. */
  readonly timeoutMs: number
}

export interface PublishedInstallResult {
  /** Whether every gate passed. */
  readonly ok: boolean
  /** Why the gate failed, when it did. */
  readonly error?: string
  /** The directory the installer unpacked the plugin into. */
  readonly packageDir?: string
  /** The files that were installed. */
  readonly layout?: PackageLayout
  /** Where the redacted diagnostics were preserved. */
  readonly logPath: string
}

/**
 * The environment the OpenCode children receive.
 *
 * The operator's environment, their home directory and their provider
 * credentials are deliberately not inherited: the run must not be able to read
 * a secret, and must not load the operator's own plugins.
 */
function childEnvironment(stateRoot: string): NodeJS.ProcessEnv {
  const inherited = ["PATH", "LANG", "LC_ALL", "SHELL"]
  const env: NodeJS.ProcessEnv = {}

  for (const key of inherited) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  env.HOME = stateRoot
  env.OPENCODE_TEST_HOME = stateRoot
  env.XDG_CONFIG_HOME = join(stateRoot, "config")
  env.XDG_DATA_HOME = join(stateRoot, "data")
  env.XDG_STATE_HOME = join(stateRoot, "state")
  env.XDG_CACHE_HOME = join(stateRoot, "cache")
  env.OPENCODE_CONFIG_DIR = join(stateRoot, "config", "opencode")
  env.TMPDIR = join(stateRoot, "tmp")
  env.OPENCODE_LOG_LEVEL = "DEBUG"

  return env
}

/**
 * Runs the documented install path and proves the installed package loads.
 *
 * The sequence is the one a user performs:
 *
 *   1. `opencode plugin add <spec>` in an isolated home,
 *   2. the global configuration records the specifier,
 *   3. the installer unpacked the package, without runtime dependencies,
 *   4. a real server loads that package from the cache.
 *
 * The server's password is read from its own output and used only against the
 * loopback address the server reported. It is never printed.
 */
export async function runPublishedInstallCheck(
  options: PublishedInstallOptions,
): Promise<PublishedInstallResult> {
  const configDirectory = join(options.stateRoot, "config", "opencode")
  const cacheRoot = join(options.stateRoot, "cache", "opencode")
  const logPath = join(options.stateRoot, "published-install.log")
  const serverLogPath = join(options.stateRoot, "data", "opencode", "log", "opencode.log")
  const diagnostics: string[] = []

  const fail = (error: string): PublishedInstallResult => ({ ok: false, error, logPath })

  try {
    assertSafeStateRoot(options.stateRoot, {
      repositoryRoot: options.repositoryRoot,
      homeDirectory: process.env.HOME,
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }

  try {
    await access(options.binaryPath, constants.X_OK)
  } catch {
    return fail(`the OpenCode executable is not executable: ${options.binaryPath}`)
  }

  await rm(options.stateRoot, { recursive: true, force: true })
  await mkdir(configDirectory, { recursive: true })
  await mkdir(join(options.stateRoot, "tmp"), { recursive: true })

  // Step 1: install the package through the documented command.
  const install = await runCommand(options.binaryPath, ["plugin", "add", options.spec], {
    cwd: configDirectory,
    env: childEnvironment(options.stateRoot),
    timeoutMs: options.timeoutMs,
  })
  diagnostics.push("--- opencode plugin add ---", install.output)

  if (install.timedOut) {
    return fail(`the installer did not finish within ${options.timeoutMs}ms`)
  }
  if (install.exitCode !== 0) {
    return fail(`the installer exited with code ${install.exitCode ?? "unknown"}`)
  }

  // Step 2: the global configuration records the specifier.
  const configPath = join(configDirectory, "opencode.json")
  const configText = await readFile(configPath, "utf8").catch(() => "")
  let config: unknown
  try {
    config = JSON.parse(configText)
  } catch {
    config = undefined
  }
  const specs = parsePluginSpecs(config)
  if (!specs.includes(options.spec)) {
    return fail(`the global configuration does not record ${options.spec}`)
  }

  // Step 3: the installer unpacked the package, with no runtime dependencies.
  const packages = await findInstalledPackages(cacheRoot)
  if (packages.length === 0) {
    return fail(`the installer did not unpack ${options.spec} into the cache`)
  }
  const packageDir = packages[0] as string
  const layout = await inspectPackageLayout(packageDir)
  if (layout.dependencyDirectories.length > 0) {
    return fail(
      `the installed package carries runtime dependencies: ${layout.dependencyDirectories.join(", ")}`,
    )
  }

  // Step 4: a real server loads the installed package.
  const server = spawn(options.binaryPath, ["serve", "--port", "0"], {
    cwd: configDirectory,
    env: childEnvironment(options.stateRoot),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  const output = new ServerOutput()
  server.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")))
  server.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")))

  let password: string | undefined
  let url: string | undefined
  let failure: string | undefined

  try {
    const deadline = Date.now() + options.timeoutMs
    while (Date.now() < deadline && url === undefined) {
      if (output.url !== undefined) {
        url = output.url
        break
      }
      if (server.exitCode !== null) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS))
    }

    if (url === undefined) {
      failure = `OpenCode did not report a listening server within ${options.timeoutMs}ms`
    } else {
      const passwordDeadline = Math.min(deadline, Date.now() + PASSWORD_WAIT_MS)
      while (Date.now() < passwordDeadline && output.password === undefined) {
        if (server.exitCode !== null) break
        await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS))
      }
      password = output.password
    }

    if (failure === undefined && url !== undefined) {
      try {
        await activateLocation(url, password, configDirectory)
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }

    let loaded = false
    if (failure === undefined) {
      const deadline = Date.now() + options.timeoutMs
      while (Date.now() < deadline && !loaded) {
        const log = await readFile(serverLogPath, "utf8").catch(() => "")
        loaded = parsePluginLoads(log).some((load) => loadTargetsPackage(load, packageDir))
        if (loaded) break
        await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS))
      }
      if (!loaded) {
        failure = `OpenCode did not load the installed package within ${options.timeoutMs}ms`
      }
    }

    if (failure === undefined) {
      const operatorHome = process.env.HOME?.trim()
      const operatorDirectories = operatorConfigDirectories(operatorHome ?? "", process.env)
      const log = await readFile(serverLogPath, "utf8").catch(() => "")
      const references = findOperatorHomeReferences(log, operatorDirectories)
      if (references.length > 0) {
        failure = `the OpenCode server read the operator's own configuration: ${references.join(", ")}`
      }
    }
  } finally {
    await stopChild(server)
    diagnostics.push("--- opencode serve ---", output.text)
    const secret = password ?? output.password
    await writeFile(logPath, redactServerSecrets(diagnostics.join("\n"), secret), "utf8")
  }

  if (failure !== undefined) return fail(failure)

  return { ok: true, packageDir, layout, logPath }
}

interface CommandResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly output: string
}

/** Runs a command to completion, bounded in time and in captured output. */
async function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const output = new ServerOutput()
  child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")))
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")))

  const deadline = Date.now() + options.timeoutMs
  let timedOut = false

  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) {
      timedOut = true
      child.kill("SIGKILL")
      break
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS))
  }

  return { exitCode: child.exitCode, timedOut, output: output.text }
}

/**
 * Asks the local server to activate the isolated configuration directory.
 *
 * Starting `serve` alone does not initialise a location, and therefore does
 * not load its plugins. The password is sent only to the loopback address the
 * server reported.
 */
async function activateLocation(
  url: string,
  password: string | undefined,
  directory: string,
): Promise<void> {
  if (!/^https?:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?\b/.test(url)) {
    throw new Error(`refusing to send the server password to a non-loopback address (${url})`)
  }

  const target = new URL("/api/location", url)
  target.searchParams.set("location[directory]", directory)

  const headers: Record<string, string> = {}
  if (password !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  }

  const response = await fetch(target, { headers })
  await response.body?.cancel()

  if (!response.ok) {
    throw new Error(`OpenCode location activation failed with HTTP ${response.status}`)
  }
}
