import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  callApi,
  collectTokens,
  createBlob,
  createCommit,
  createRef,
  createTree,
  deleteRef,
  diffTrees,
  parseApiTree,
  parseLsTree,
  pathsLostByRebasing,
  planTreeCreation,
  readCommit,
  readRef,
  releaseCommitMessage,
  releaseMessage,
  updateDefaultBranch,
  updateRef,
  type LocalFile,
  type TreeEntries,
} from "./publish/tree.ts"

/**
 * Rebuilds the published branch as a single commit that carries this
 * repository's current tree.
 *
 * The branch is published through the API rather than by pushing, so the
 * history it accumulated is a sequence of API commits — one per file. When
 * something unwanted lands in that history, the honest repair is a clean
 * commit that carries exactly the current tree, not a pile of deletions that
 * leave the unwanted content visible in the log.
 *
 * The commit is parented on the newest ancestor whose tree is contained in the
 * local tree, so the release history is preserved and only the commits after
 * it are replaced.
 *
 * ## Every token is tried, not just the first
 *
 * A token is a permission set, and the permissions differ between them. The
 * token in the environment may be a classic token with the `repo` scope; the
 * token in the repository's `.env` file may be a fine-grained token whose
 * permissions include "Workflows: write"; the git credential helper may
 * serve a third. A classic token's permission for a workflow file is the
 * `workflow` **scope**, while a fine-grained token's is a **permission** —
 * and a fine-grained token reports no OAuth scopes at all, so the scope
 * header cannot tell the two apart.
 *
 * So the rebuild tries every token it can find, and the first one that can
 * move the branch wins. Stopping at the first token would make the result
 * depend on which credential happened to be found first.
 *
 * ## The workflow-file boundary
 *
 * A workflow file needs a permission no other file needs: the `workflow`
 * scope on a classic token, or "Workflows: write" on a fine-grained one.
 * GitHub enforces that boundary in **two** places, and only one of them
 * fails loudly:
 *
 * - the Contents API refuses the file itself with `404 Not Found`;
 * - the git data API accepts the blob and the tree, and then **refuses every
 *   ref update that would introduce the file**, also with `404 Not Found`.
 *
 * The second one is the trap: the objects are created, the commit exists and
 * reads back, and only the move of the branch fails. So the move is tried
 * first with the complete tree, and when it is refused the tree is rebuilt
 * without the workflow files and the move is tried again. The first success
 * wins, and the report says which tree was published.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repository = process.env.GITHUB_REPOSITORY?.trim() || "ioiddj/opencode-nvidia-provider"
const branch = process.env.GITHUB_REF_NAME?.trim() || "main"
const api = `https://api.github.com/repos/${repository}`

/**
 * The command-line options.
 *
 * `--base <sha>` parents the rebuilt commit on a **chosen** commit instead of
 * the newest published ancestor. Everything that came after the base is
 * replaced by one commit that carries the complete local tree, so the base's
 * tree has to be contained in the local tree — otherwise content would be
 * lost, and the command refuses rather than publish a surprise.
 *
 * `--message <text>` overrides the commit message.
 */
function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    console.error(`${name} needs a value`)
    process.exit(2)
  }
  return value
}

const requestedBase = optionValue("--base")
const requestedMessage = optionValue("--message")

const tokens = collectTokens(process.env, { envFile: resolve(repositoryRoot, ".env") })
if (tokens.length === 0) {
  console.error(
    "no GitHub token available: set GITHUB_TOKEN, put one in the repository's .env file, " +
      "or configure the git credential helper for github.com",
  )
  process.exit(2)
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" })
}

const localEntries = parseLsTree(git("ls-tree", "-r", "HEAD"))
const localFiles: LocalFile[] = [...localEntries.entries()].map(([path, entry]) => ({
  path,
  mode: entry.mode,
  sha: entry.sha,
}))
const localTree = git("rev-parse", "HEAD^{tree}").trim()

console.log(`repository      ${repository}`)
console.log(`branch          ${branch}`)
console.log(`local tree      ${localTree} (${localFiles.length} files)`)
console.log(`tokens          ${tokens.map((token) => token.label).join(", ")}`)

/** The newest ancestor of the published head whose tree is contained in the local tree. */
async function findBaseCommit(token: string): Promise<string | undefined> {
  const head = await readRef(token, api, `heads/${branch}`)
  if (head.status !== 200 || head.sha === undefined) return undefined

  let current: string | undefined = head.sha
  while (current !== undefined) {
    const commit = await readCommit(token, api, current)
    if (commit.status !== 200 || commit.tree === undefined) return undefined

    const listing = await callApi(token, "GET", `${api}/git/trees/${commit.tree}?recursive=1`)
    if (listing.status === 200) {
      const published = parseApiTree((listing.body as { tree?: unknown[] }).tree ?? [])
      const unexpected = [...published.keys()].filter((path) => !localEntries.has(path))
      if (unexpected.length === 0) return current
    }

    current = commit.parents[0]
  }

  return undefined
}

/**
 * Checks that a chosen base commit carries nothing the local tree lacks.
 *
 * Replacing everything after a base loses whatever those commits carried, so
 * the base's own content has to survive in the local tree. A base whose tree
 * holds a path the local tree does not have would lose that path.
 */
async function checkBaseIsContained(token: string, base: string): Promise<string | undefined> {
  const commit = await readCommit(token, api, base)
  if (commit.status !== 200 || commit.tree === undefined) {
    return `the base commit ${base} could not be read (HTTP ${commit.status})`
  }

  const listing = await callApi(token, "GET", `${api}/git/trees/${commit.tree}?recursive=1`)
  if (listing.status !== 200) {
    return `the base commit's tree could not be read (HTTP ${listing.status})`
  }

  const published = parseApiTree((listing.body as { tree?: unknown[] }).tree ?? [])
  const lost = pathsLostByRebasing(published, localEntries)
  if (lost.length > 0) {
    return (
      `the base commit ${base} carries ${lost.length} path(s) the local tree does not have, ` +
      `so rebuilding on it would lose them: ${lost.join(", ")}`
    )
  }

  return undefined
}

/**
 * Creates the tree objects a set of files needs, deepest directory first.
 *
 * GitHub's tree API refuses paths that contain a separator, so every
 * directory becomes a tree object of its own and they are built bottom up.
 */
async function buildTree(
  token: string,
  files: readonly LocalFile[],
  blobShas: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  const treeShas = new Map<string, string | undefined>()

  for (const step of planTreeCreation(files)) {
    const entries: Array<{
      path: string
      mode: string
      type: "blob" | "tree"
      sha: string
    }> = step.blobs.map((file) => ({
      path: file.name,
      mode: file.mode,
      type: "blob",
      sha: blobShas.get(file.path) as string,
    }))

    for (const child of step.children) {
      const childSha = treeShas.get(child)
      if (childSha === undefined) continue
      entries.push({
        path: child.split("/").pop() as string,
        mode: "040000",
        type: "tree",
        sha: childSha,
      })
    }

    if (entries.length === 0) {
      treeShas.set(step.dir, undefined)
      continue
    }

    const created = await createTree(token, api, entries)
    if (created.status !== 201 || created.sha === undefined) {
      console.error(
        `could not create the tree for ${step.dir || "the repository root"} (HTTP ${created.status})`,
      )
      return undefined
    }
    treeShas.set(step.dir, created.sha)
  }

  return treeShas.get("")
}

/** The files that need a permission the other files do not. */
const workflowFiles = localFiles.filter((file) => file.path.startsWith(".github/workflows/"))

/** The package this repository publishes. */
async function packageIdentity(): Promise<{ name: string; version: string }> {
  try {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown }
    return {
      name: typeof manifest.name === "string" ? manifest.name : "the package",
      version: typeof manifest.version === "string" ? manifest.version : "",
    }
  } catch {
    return { name: "the package", version: "" }
  }
}

/** Creates the commit that carries a tree. */
async function createReleaseCommit(token: string, tree: string, base: string | undefined): Promise<string | undefined> {
  const subject = git("log", "-1", "--pretty=%s", "HEAD").trim()
  const identity = await packageIdentity()

  // A commit built on a chosen base replaces everything that came after it,
  // so it describes the release. A commit built on the newest published
  // ancestor only adds the local change, so the local subject is the truth.
  const message =
    requestedMessage ??
    (requestedBase === undefined
      ? releaseMessage(subject)
      : releaseCommitMessage(identity.name, identity.version))

  const created = await createCommit(token, api, {
    message,
    tree,
    parents: base === undefined ? [] : [base],
  })

  if (created.status !== 201 || created.sha === undefined) {
    console.error(`could not create the commit (HTTP ${created.status})`)
    return undefined
  }
  return created.sha
}

/** GitHub's own words for a refusal, without the response body dumped raw. */
function refusalMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "no detail"
  const message = (body as { message?: unknown }).message
  return typeof message === "string" ? message : "no detail"
}

/** The outcome of one attempt to move the branch. */
interface MoveResult {
  readonly moved: boolean
  readonly status: number
  readonly detail: string
}

/**
 * Moves the branch to a commit.
 *
 * The direct update is tried first. The parking sequence is the fallback for
 * the case where the API refuses to move a branch in place; it parks the new
 * commit on a temporary branch, makes that the default, deletes the old
 * branch, recreates it, and puts the default back.
 */
async function moveBranch(token: string, sha: string): Promise<MoveResult> {
  const moved = await updateRef(token, api, `heads/${branch}`, sha)
  if (moved.status === 200) {
    return { moved: true, status: 200, detail: "" }
  }

  const detail = refusalMessage(moved.body)
  console.log(`moving the branch in place was refused (HTTP ${moved.status}: ${detail})`)

  const parking = `publishing-${Date.now()}`
  const create = await createRef(token, api, `refs/heads/${parking}`, sha)
  if (create.status !== 201) {
    return {
      moved: false,
      status: create.status,
      detail: `the parking branch could not be created (${refusalMessage(create.body)})`,
    }
  }

  const parked = await updateDefaultBranch(token, api, parking)
  if (parked.status !== 200) {
    return {
      moved: false,
      status: parked.status,
      detail: `the default branch could not be moved (${refusalMessage(parked.body)}); ` +
        `the parking branch ${parking} holds the rebuilt commit`,
    }
  }

  const deleted = await deleteRef(token, api, `heads/${branch}`)
  if (deleted.status !== 204) {
    // The old branch is still there, so the repository is intact. Put the
    // default back where it belongs rather than leaving it on the parking
    // branch, and say what still has to be cleaned up.
    const restored = await updateDefaultBranch(token, api, branch)
    return {
      moved: false,
      status: deleted.status,
      detail:
        `the old branch could not be deleted (${refusalMessage(deleted.body)}); ` +
        (restored.status === 200
          ? `the default branch was restored; delete the parking branch ${parking}`
          : `the default branch could not be restored either; set it back to ${branch}`),
    }
  }

  const recreated = await createRef(token, api, `refs/heads/${branch}`, sha)
  if (recreated.status !== 201) {
    return {
      moved: false,
      status: recreated.status,
      detail:
        `the branch could not be recreated (${refusalMessage(recreated.body)}); ` +
        `the rebuilt commit is on ${parking}, which is the default branch`,
    }
  }

  const restored = await updateDefaultBranch(token, api, branch)
  if (restored.status !== 200) {
    return {
      moved: false,
      status: restored.status,
      detail: `the default branch could not be restored (${refusalMessage(restored.body)})`,
    }
  }

  await deleteRef(token, api, `refs/heads/${parking}`)
  return { moved: true, status: 200, detail: "" }
}

/** The outcome of one token's attempt to publish the branch. */
interface Attempt {
  readonly moved: boolean
  readonly status: number
  readonly detail: string
  readonly tree?: string
  readonly commit?: string
  readonly base?: string
  readonly omitted: string[]
  readonly label: string
  readonly token: string
}

/**
 * Publishes the branch with one token.
 *
 * The complete tree is tried first. When the move is refused and the tree
 * holds workflow files, the tree is rebuilt without them and the move is
 * tried again, so a token without the workflow permission still publishes
 * everything else instead of leaving the branch where it was.
 */
async function attemptWithToken(token: string, label: string): Promise<Attempt> {
  const base = requestedBase ?? (await findBaseCommit(token))

  if (requestedBase !== undefined) {
    const problem = await checkBaseIsContained(token, requestedBase)
    if (problem !== undefined) {
      return { moved: false, status: 0, detail: problem, omitted: [], label, token }
    }
  }

  // Every blob is uploaded, so the tree can reference content the repository
  // does not carry yet. GitHub returns the same SHA for content it already has.
  const blobShas = new Map<string, string>()
  for (const file of localFiles) {
    const content = execFileSync("git", ["cat-file", "blob", file.sha], {
      cwd: repositoryRoot,
      maxBuffer: 16 * 1024 * 1024,
    })
    const blob = await createBlob(token, api, content)
    if (blob.status !== 201 || blob.sha === undefined) {
      return {
        moved: false,
        status: blob.status,
        detail: `could not upload ${file.path} (HTTP ${blob.status})`,
        omitted: [],
        label,
        token,
      }
    }
    if (blob.sha !== file.sha) {
      return {
        moved: false,
        status: blob.status,
        detail: `the uploaded blob for ${file.path} has a different SHA than the local one`,
        omitted: [],
        label,
        token,
      }
    }
    blobShas.set(file.path, blob.sha)
  }

  const completeTree = await buildTree(token, localFiles, blobShas)
  if (completeTree === undefined) {
    return {
      moved: false,
      status: 0,
      detail: "the repository root tree could not be created",
      omitted: [],
      label,
      token,
    }
  }

  const completeCommit = await createReleaseCommit(token, completeTree, base)
  if (completeCommit === undefined) {
    return {
      moved: false,
      status: 0,
      detail: "the release commit could not be created",
      omitted: [],
      label,
      token,
    }
  }
  console.log(`rebuilt commit  ${completeCommit} (tree ${completeTree})`)

  let move = await moveBranch(token, completeCommit)
  if (move.moved) {
    return {
      moved: true,
      status: 200,
      detail: "",
      tree: completeTree,
      commit: completeCommit,
      base,
      omitted: [],
      label,
      token,
    }
  }

  if (workflowFiles.length === 0) {
    return { moved: false, status: move.status, detail: move.detail, omitted: [], label, token }
  }

  // The refusal is the workflow-file boundary. Publish the tree without the
  // workflow files rather than leaving the branch on its old history.
  const reduced = localFiles.filter(
    (file) => !workflowFiles.some((workflow) => workflow.path === file.path),
  )
  const reducedTree = await buildTree(token, reduced, blobShas)
  if (reducedTree === undefined) {
    return {
      moved: false,
      status: move.status,
      detail: `${move.detail}; the tree without the workflow files could not be created`,
      omitted: [],
      label,
      token,
    }
  }

  const reducedCommit = await createReleaseCommit(token, reducedTree, base)
  if (reducedCommit === undefined) {
    return {
      moved: false,
      status: move.status,
      detail: `${move.detail}; the commit without the workflow files could not be created`,
      omitted: [],
      label,
      token,
    }
  }
  console.log(`rebuilt commit  ${reducedCommit} (tree ${reducedTree}, without the workflow files)`)

  move = await moveBranch(token, reducedCommit)
  if (!move.moved) {
    return { moved: false, status: move.status, detail: move.detail, omitted: [], label, token }
  }

  return {
    moved: true,
    status: 200,
    detail: "",
    tree: reducedTree,
    commit: reducedCommit,
    base,
    omitted: workflowFiles.map((file) => file.path),
    label,
    token,
  }
}

// Every token is tried, in order, and the first one that can move the branch
// wins. A token that cannot even upload a blob is not a failure of the
// publication — it is a credential that lacks the permission.
const attempts: Attempt[] = []
let succeeded: Attempt | undefined

for (const candidate of tokens) {
  console.log(`trying ${candidate.label}`)
  const attempt = await attemptWithToken(candidate.value, candidate.label)
  attempts.push(attempt)

  if (attempt.moved) {
    succeeded = attempt
    break
  }

  console.log(`  ${candidate.label} could not publish the branch: ${attempt.detail}`)
}

if (succeeded === undefined) {
  console.error("no available token could move the branch:")
  for (const attempt of attempts) {
    console.error(`  ${attempt.label}: ${attempt.detail}`)
  }
  process.exit(1)
}

console.log(`base commit     ${succeeded.base ?? "(none: the rebuilt commit starts the history)"}`)
console.log(`published head  ${succeeded.commit}`)
console.log(`published tree  ${succeeded.tree}`)
console.log(`published with  ${succeeded.label}`)

// Verify what the branch now carries, using the token that published it.
const head = await readRef(succeeded.token, api, `heads/${branch}`)
if (head.status !== 200 || head.sha === undefined) {
  console.error("the branch could not be read back")
  process.exit(1)
}

const commit = await readCommit(succeeded.token, api, head.sha)
if (commit.status !== 200 || commit.tree === undefined) {
  console.error("the rebuilt commit could not be read back")
  process.exit(1)
}

const listing = await callApi(
  succeeded.token,
  "GET",
  `${api}/git/trees/${commit.tree}?recursive=1`,
)
if (listing.status !== 200) {
  console.error(`the rebuilt tree could not be read back (HTTP ${listing.status})`)
  process.exit(1)
}

const published = parseApiTree((listing.body as { tree?: unknown[] }).tree ?? [])
const expected: TreeEntries = new Map(
  [...localEntries.entries()].filter(([path]) => !succeeded.omitted.includes(path)),
)
const difference = diffTrees(expected, published)

if (difference.missing.length > 0 || difference.differing.length > 0 || difference.extra.length > 0) {
  console.error(
    `the rebuilt tree differs from the local tree: ${difference.missing.length} missing, ` +
      `${difference.differing.length} differing, ${difference.extra.length} unexpected`,
  )
  process.exit(1)
}

if (succeeded.omitted.length > 0) {
  console.error(
    `the published tree omits ${succeeded.omitted.length} file(s) that need a token permission: ` +
      `${succeeded.omitted.join(", ")}`,
  )
  console.error(
    "A workflow file needs the workflow scope on a classic token, or \"Workflows: write\" " +
      "on a fine-grained one. Re-run `npm run publish:rebuild` once a token carries it.",
  )
  process.exit(1)
}

console.log(`PASS the published tree is byte-identical to the local commit (${commit.tree})`)
console.log(`     published with ${succeeded.label}`)
