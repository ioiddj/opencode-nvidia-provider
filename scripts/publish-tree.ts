import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  callApi,
  collectTokens,
  diffTrees,
  encodeContentPath,
  explainRefusal,
  parseApiTree,
  parseLsTree,
  type TreeEntries,
} from "./publish/tree.ts"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repository = process.env.GITHUB_REPOSITORY?.trim() || "ioiddj/opencode-nvidia-provider"
const branch = process.env.GITHUB_REF_NAME?.trim() || "main"
const api = `https://api.github.com/repos/${repository}`

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

interface PublishedState {
  readonly head: string
  readonly tree: string
  readonly entries: TreeEntries
}

/** Reads the published branch through whichever token can read it. */
async function readPublished(): Promise<PublishedState> {
  let lastFailure = ""

  for (const token of tokens) {
    const ref = await callApi(token.value, "GET", `${api}/git/ref/heads/${branch}`)
    if (ref.status !== 200) {
      lastFailure = `HTTP ${ref.status} while reading the branch`
      continue
    }

    const head = (ref.body as { object?: { sha?: string } }).object?.sha
    if (head === undefined) {
      lastFailure = "the branch response carried no commit SHA"
      continue
    }

    const commit = await callApi(token.value, "GET", `${api}/git/commits/${head}`)
    if (commit.status !== 200) {
      lastFailure = `HTTP ${commit.status} while reading the commit`
      continue
    }

    const tree = (commit.body as { tree?: { sha?: string } }).tree?.sha
    if (tree === undefined) {
      lastFailure = "the commit response carried no tree SHA"
      continue
    }

    const listing = await callApi(token.value, "GET", `${api}/git/trees/${tree}?recursive=1`)
    if (listing.status !== 200) {
      lastFailure = `HTTP ${listing.status} while reading the tree`
      continue
    }

    const items = (listing.body as { tree?: unknown[] }).tree ?? []
    return { head, tree, entries: parseApiTree(items) }
  }

  throw new Error(`could not read the published branch: ${lastFailure}`)
}

const localTree = git("rev-parse", "HEAD^{tree}").trim()
const localEntries = parseLsTree(git("ls-tree", "-r", "HEAD"))

// `--check` verifies the published tree without writing anything. It is the
// mode to use when the question is "does the published repository match this
// commit", because the publishing mode changes the repository it measures.
const checkOnly = process.argv.includes("--check")

console.log(`repository      ${repository}`)
console.log(`branch          ${branch}`)
console.log(`local tree      ${localTree} (${localEntries.size} files)`)

const before = await readPublished()
console.log(`published head  ${before.head}`)
console.log(`published tree  ${before.tree}`)

const difference = diffTrees(localEntries, before.entries)
console.log(
  `to publish      ${difference.missing.length} missing, ${difference.differing.length} differing, ` +
    `${difference.extra.length} unexpected`,
)

if (difference.extra.length > 0) {
  console.error(`the published tree has files the local tree does not: ${difference.extra.join(", ")}`)
  process.exit(1)
}

const refusals = new Map<string, string>()

if (checkOnly) {
  for (const path of [...difference.missing, ...difference.differing]) {
    console.error(`  ${explainRefusal(path, 404)}`)
  }
  console.error(
    "the published tree does not match the local commit; run `npm run publish:tree` to publish it",
  )
  process.exit(1)
}

for (const path of [...difference.missing, ...difference.differing]) {
  const content = await readFile(join(repositoryRoot, path))
  const encoded = Buffer.from(content).toString("base64")

  let published = false
  let lastRefusal = ""

  for (const token of tokens) {
    const url = `${api}/contents/${encodeContentPath(path)}`
    const payload: Record<string, string> = {
      message: `Publish: ${path}`,
      content: encoded,
      branch,
    }

    const existing = await callApi(token.value, "GET", `${url}?ref=${branch}`)
    if (existing.status === 200) {
      const sha = (existing.body as { sha?: string }).sha
      if (sha !== undefined) payload.sha = sha
    }

    const response = await callApi(token.value, "PUT", url, payload)
    if (response.status === 200 || response.status === 201) {
      const commit = (response.body as { commit?: { sha?: string } }).commit?.sha
      console.log(`  published ${path} (${commit ?? "unknown commit"}, with ${token.label})`)
      published = true
      break
    }

    lastRefusal = explainRefusal(path, response.status)
  }

  if (!published) {
    refusals.set(path, lastRefusal)
    console.error(`  refused  ${lastRefusal}`)
  }
}

const after = await readPublished()
const remaining = diffTrees(localEntries, after.entries)

console.log(`published head  ${after.head}`)
console.log(`published tree  ${after.tree}`)

if (remaining.missing.length === 0 && remaining.differing.length === 0 && remaining.extra.length === 0) {
  if (after.tree !== localTree) {
    console.error(
      `the published tree SHA ${after.tree} differs from the local tree SHA ${localTree}, ` +
        `although their contents match`,
    )
    process.exit(1)
  }
  console.log(`PASS the published tree is byte-identical to the local commit (${after.tree})`)
  process.exit(0)
}

console.error(
  `the published tree still differs: ${remaining.missing.length} missing, ` +
    `${remaining.differing.length} differing, ${remaining.extra.length} unexpected`,
)
for (const path of [...remaining.missing, ...remaining.differing]) {
  console.error(`  ${refusals.get(path) ?? `${path}: not published`}`)
}
process.exit(1)
