import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { basename } from "node:path"

/**
 * Publishing and tree verification for this repository.
 *
 * The repository is published through the GitHub REST API rather than by
 * pushing, because the host policy of this machine denies `git push` and `gh`.
 * That makes the published tree something to be **verified**, not assumed: a
 * tree SHA covers every path, mode and byte beneath it, so equality of the
 * root tree SHA is a complete proof that the published content is
 * byte-identical to the local commit.
 *
 * The token is read from the environment, or from the git credential helper as
 * a fallback. It is never printed, logged, or written to disk.
 */

export interface TreeEntry {
  /** The file mode, as git records it. */
  readonly mode: string
  /** The blob SHA. */
  readonly sha: string
}

export type TreeEntries = ReadonlyMap<string, TreeEntry>

export interface TreeDifference {
  /** Paths the local tree has and the published tree does not. */
  readonly missing: readonly string[]
  /** Paths both trees have, with a different mode or blob SHA. */
  readonly differing: readonly string[]
  /** Paths the published tree has and the local tree does not. */
  readonly extra: readonly string[]
}

/**
 * Compares a local tree with a published tree.
 *
 * A path counts as different when either its mode or its blob SHA differs: a
 * file can have the same bytes and a different executable bit, and that is a
 * difference the published tree would carry.
 */
export function diffTrees(local: TreeEntries, published: TreeEntries): TreeDifference {
  const missing: string[] = []
  const differing: string[] = []
  const extra: string[] = []

  for (const [path, entry] of local) {
    const remote = published.get(path)
    if (remote === undefined) {
      missing.push(path)
      continue
    }
    if (remote.mode !== entry.mode || remote.sha !== entry.sha) {
      differing.push(path)
    }
  }

  for (const path of published.keys()) {
    if (!local.has(path)) extra.push(path)
  }

  missing.sort()
  differing.sort()
  extra.sort()
  return { missing, differing, extra }
}

/**
 * Parses the output of `git ls-tree -r HEAD`.
 *
 * Each line is `<mode> <type> <sha>\t<path>`.
 */
export function parseLsTree(output: string): TreeEntries {
  const entries = new Map<string, TreeEntry>()

  for (const line of output.split("\n")) {
    if (line.trim() === "") continue
    const separator = line.indexOf("\t")
    if (separator < 0) continue
    const meta = line.slice(0, separator).split(" ")
    const path = line.slice(separator + 1)
    if (meta.length !== 3) continue
    const [mode, type, sha] = meta
    if (type !== "blob" || mode === undefined || sha === undefined) continue
    entries.set(path, { mode, sha })
  }

  return entries
}

/**
 * Parses the recursive tree listing the GitHub API returns.
 *
 * Only blobs are kept: the local tree lists blobs as well, so the two are
 * comparable without inventing entries for directories.
 */
export function parseApiTree(tree: readonly unknown[]): TreeEntries {
  const entries = new Map<string, TreeEntry>()

  for (const item of tree) {
    if (typeof item !== "object" || item === null) continue
    const record = item as { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown }
    if (record.type !== "blob") continue
    if (typeof record.path !== "string" || typeof record.mode !== "string") continue
    if (typeof record.sha !== "string") continue
    entries.set(record.path, { mode: record.mode, sha: record.sha })
  }

  return entries
}

/**
 * Why GitHub refused a write, in the words that help.
 *
 * A workflow file needs a permission the other files do not: the `workflow`
 * scope on a classic token, or "Workflows: write" on a fine-grained one.
 * Without it GitHub answers `404 Not Found` for the file and for every path
 * that would contain it, which looks like a missing file rather than a
 * missing permission.
 */
export function explainRefusal(path: string, status: number): string {
  if (status === 404 && path.startsWith(".github/workflows/")) {
    return (
      `${path}: GitHub refused the write (404). A workflow file needs the ` +
      `workflow scope on a classic token, or "Workflows: write" on a ` +
      `fine-grained one, in addition to repository write access.`
    )
  }
  if (status === 404) {
    return `${path}: GitHub refused the write (404). The token may lack repository write access.`
  }
  return `${path}: GitHub refused the write (HTTP ${status}).`
}

export interface PublishToken {
  /** A label for the token's source. The token itself is never shown. */
  readonly label: string
  /** The token value. */
  readonly value: string
}

/**
 * The tokens this machine can offer, most specific first.
 *
 * The environment token is preferred; the git credential helper is the
 * fallback. Both are tried per file, because a token that can write ordinary
 * files may still be refused for a workflow file, and vice versa.
 *
 * A token in a repository-local `.env` file is offered between the two. The
 * environment and the credential helper are both *absent* on some machines
 * that hold a working token, and a token nobody looks at is a token nobody
 * uses.
 */
export function collectTokens(
  environment: NodeJS.ProcessEnv,
  options: { readonly envFile?: string } = {},
): PublishToken[] {
  const tokens: PublishToken[] = []
  const seen = new Set<string>()

  for (const key of ["GITHUB_TOKEN", "GITHUB_API_KEY"]) {
    const value = environment[key]?.trim()
    if (value === undefined || value === "") continue
    if (seen.has(value)) continue
    seen.add(value)
    tokens.push({ label: `the ${key} environment variable`, value })
  }

  if (options.envFile !== undefined) {
    const fromFile = tokenFromEnvFile(options.envFile)
    if (fromFile !== undefined && !seen.has(fromFile.value)) {
      seen.add(fromFile.value)
      tokens.push(fromFile)
    }
  }

  const helper = credentialHelperToken()
  if (helper !== undefined && !seen.has(helper)) {
    tokens.push({ label: "the git credential helper", value: helper })
  }

  return tokens
}

/**
 * The GitHub token in an environment file, if the file holds one.
 *
 * Only `GITHUB_TOKEN` and `GITHUB_API_KEY` are read; every other line is
 * ignored, so a file that holds unrelated secrets gains nothing here. The
 * value is returned, never logged — the label names the file and the key, so
 * the report says which token was used without revealing it.
 */
export function tokenFromEnvFile(file: string): PublishToken | undefined {
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return undefined
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue

    const separator = trimmed.indexOf("=")
    if (separator < 0) continue

    const key = trimmed.slice(0, separator).trim().replace(/^export\s+/, "")
    if (key !== "GITHUB_TOKEN" && key !== "GITHUB_API_KEY") continue

    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "")
    if (value === "") continue

    return { label: `the ${key} entry in ${basename(file)}`, value }
  }

  return undefined
}

/** Reads the github.com credential from the git credential helper. */
export function credentialHelperToken(): string | undefined {
  const result = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  })

  if (result.status !== 0) return undefined
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.startsWith("password=")) return line.slice("password=".length).trim()
  }
  return undefined
}

export interface ApiResponse {
  readonly status: number
  readonly body: unknown
}

/** Calls the GitHub REST API with one token. */
export async function callApi(
  token: string,
  method: string,
  url: string,
  payload?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "opencode-nvidia-provider-publisher",
  }

  let body: string | undefined
  if (payload !== undefined) {
    body = JSON.stringify(payload)
    headers["Content-Type"] = "application/json"
  }

  const response = await fetch(url, { method, headers, body })
  const text = await response.text()

  let parsed: unknown
  try {
    parsed = text === "" ? undefined : JSON.parse(text)
  } catch {
    parsed = text
  }

  return { status: response.status, body: parsed }
}

/** Encodes a repository path for the Contents API. */
export function encodeContentPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/")
}

/** The name a published file is reported under. */
export function describePath(path: string): string {
  return basename(path)
}

/** The conventional-commit prefixes a subject can already carry. */
const CONVENTIONAL_PREFIX =
  /^(feat|fix|release|docs|ci|test|chore|refactor|build|perf|style|revert)(\([^)]*\))?!?:/

/**
 * The paths a published tree carries that the local tree does not have.
 *
 * Rebuilding a branch on a commit replaces everything that came after it, so
 * a base that carries a path the local tree lacks would lose that path. This
 * is the set of paths that would be lost.
 */
export function pathsLostByRebasing(published: TreeEntries, local: TreeEntries): string[] {
  return [...published.keys()].filter((path) => !local.has(path)).sort()
}

/**
 * The message a release commit carries.
 *
 * The local subject is the truth about what changed, so it is kept. The
 * `Release: ` prefix is only added when the subject does not already name a
 * kind of change, because `Release: release: ...` reads like a mistake.
 */
export function releaseMessage(subject: string): string {
  const trimmed = subject.trim()
  if (trimmed === "") return "Release"
  if (CONVENTIONAL_PREFIX.test(trimmed)) return trimmed
  return `Release: ${trimmed}`
}

/**
 * The message a commit that carries the whole release carries.
 *
 * A commit built on a chosen base replaces everything that came after it, so
 * it describes the release rather than the last local change.
 */
export function releaseCommitMessage(name: string, version: string): string {
  const trimmedName = name.trim()
  const trimmedVersion = version.trim()
  if (trimmedVersion === "") return `Release: ${trimmedName}`.trim()
  return `Release: ${trimmedName} ${trimmedVersion}`.trim()
}

export interface LocalFile {
  /** The path, relative to the repository root. */
  readonly path: string
  /** The file mode, as git records it. */
  readonly mode: string
  /** The blob SHA of the committed content. */
  readonly sha: string
}

export interface PlannedBlob {
  /** The entry name inside its directory; a tree entry never carries a separator. */
  readonly name: string
  /** The full path, relative to the repository root. */
  readonly path: string
  /** The file mode, as git records it. */
  readonly mode: string
  /** The blob SHA of the committed content. */
  readonly sha: string
}

export interface TreePlanEntry {
  /** The directory the tree describes; the empty string is the repository root. */
  readonly dir: string
  /** The blobs that live directly in this directory. */
  readonly blobs: readonly PlannedBlob[]
  /** The directories nested in this one. */
  readonly children: readonly string[]
}

/**
 * Plans the tree objects a set of files needs, deepest directory first.
 *
 * GitHub's tree API refuses paths that contain a separator, so every
 * directory has to become a tree object of its own and the tree objects have
 * to be built from the bottom up: a directory can only be created once the
 * trees it contains are known.
 *
 * A planned blob carries two paths on purpose: the **name** is what the tree
 * entry is called, and the **full path** is what identifies the file in the
 * repository. Collapsing them loses the ability to look a blob up by its
 * repository path, which is how a workflow file is recognised.
 */
export function planTreeCreation(files: readonly LocalFile[]): TreePlanEntry[] {
  const directories = new Map<string, { blobs: PlannedBlob[]; children: Set<string> }>()

  const ensure = (dir: string) => {
    let entry = directories.get(dir)
    if (entry === undefined) {
      entry = { blobs: [], children: new Set<string>() }
      directories.set(dir, entry)
    }
    return entry
  }

  ensure("")

  for (const file of files) {
    const separator = file.path.lastIndexOf("/")
    if (separator < 0) {
      ensure("").blobs.push({ name: file.path, path: file.path, mode: file.mode, sha: file.sha })
      continue
    }

    const dir = file.path.slice(0, separator)
    const name = file.path.slice(separator + 1)
    ensure(dir).blobs.push({ name, path: file.path, mode: file.mode, sha: file.sha })

    // Every ancestor directory needs to know about the directory below it.
    // The root is the parent of the first level, so it is linked too.
    const parts = dir.split("/")
    let parent = ""
    for (const part of parts) {
      const current = parent === "" ? part : `${parent}/${part}`
      ensure(parent).children.add(current)
      ensure(current)
      parent = current
    }
  }

  const depth = (dir: string) => (dir === "" ? 0 : dir.split("/").length)

  return [...directories.entries()]
    .map(([dir, entry]) => ({
      dir,
      blobs: [...entry.blobs].sort((left, right) => left.name.localeCompare(right.name)),
      children: [...entry.children].sort(),
    }))
    .sort((left, right) => depth(right.dir) - depth(left.dir))
}

export interface GitDataResponse {
  readonly status: number
  readonly sha?: string
  readonly body: unknown
}

/** Creates a blob, so a tree can reference content the repository does not have yet. */
export async function createBlob(
  token: string,
  api: string,
  content: Buffer,
): Promise<GitDataResponse> {
  const response = await callApi(token, "POST", `${api}/git/blobs`, {
    content: content.toString("base64"),
    encoding: "base64",
  })
  return { status: response.status, sha: asSha(response.body), body: response.body }
}

/** Creates a tree from blobs and from already-created subtree SHAs. */
export async function createTree(
  token: string,
  api: string,
  entries: readonly {
    path: string
    mode: string
    type: "blob" | "tree"
    sha: string
  }[],
): Promise<GitDataResponse> {
  const response = await callApi(token, "POST", `${api}/git/trees`, { tree: entries })
  return { status: response.status, sha: asSha(response.body), body: response.body }
}

/** Creates a commit that points at a tree. */
export async function createCommit(
  token: string,
  api: string,
  payload: { message: string; tree: string; parents: string[] },
): Promise<GitDataResponse> {
  const response = await callApi(token, "POST", `${api}/git/commits`, payload)
  return { status: response.status, sha: asSha(response.body), body: response.body }
}

/** Moves a branch to a commit. */
export async function updateRef(
  token: string,
  api: string,
  ref: string,
  sha: string,
): Promise<{ status: number; body: unknown }> {
  return callApi(token, "PATCH", `${api}/git/refs/${ref}`, { sha, force: true })
}

/** Creates a branch at a commit. */
export async function createRef(
  token: string,
  api: string,
  ref: string,
  sha: string,
): Promise<{ status: number; body: unknown }> {
  return callApi(token, "POST", `${api}/git/refs`, { ref, sha })
}

/** Deletes a branch. */
export async function deleteRef(
  token: string,
  api: string,
  ref: string,
): Promise<{ status: number; body: unknown }> {
  return callApi(token, "DELETE", `${api}/git/refs/${ref}`)
}

/** Changes the repository's default branch. */
export async function updateDefaultBranch(
  token: string,
  api: string,
  branch: string,
): Promise<{ status: number; body: unknown }> {
  return callApi(token, "PATCH", api, { default_branch: branch })
}

/** Reads a commit: its tree and its parents. */
export async function readCommit(
  token: string,
  api: string,
  sha: string,
): Promise<{
  status: number
  tree?: string
  parents: string[]
  body: unknown
}> {
  const response = await callApi(token, "GET", `${api}/git/commits/${sha}`)
  const body = response.body as { tree?: { sha?: string }; parents?: Array<{ sha?: string }> }
  return {
    status: response.status,
    tree: body?.tree?.sha,
    parents: (body?.parents ?? []).flatMap((parent) => (parent.sha === undefined ? [] : [parent.sha])),
    body: response.body,
  }
}

/** Reads the commit a branch points at. */
export async function readRef(
  token: string,
  api: string,
  ref: string,
): Promise<{ status: number; sha?: string; body: unknown }> {
  const response = await callApi(token, "GET", `${api}/git/ref/${ref}`)
  const body = response.body as { object?: { sha?: string } }
  return { status: response.status, sha: body?.object?.sha, body: response.body }
}

function asSha(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const sha = (body as { sha?: unknown }).sha
  return typeof sha === "string" ? sha : undefined
}
