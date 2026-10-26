import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  collectTokens,
  diffTrees,
  encodeContentPath,
  explainRefusal,
  parseApiTree,
  parseLsTree,
  pathsLostByRebasing,
  planTreeCreation,
  releaseCommitMessage,
  releaseMessage,
  tokenFromEnvFile,
} from "../scripts/publish/tree.ts"

test("reports the paths the published tree is missing", () => {
  const local = new Map([
    ["README.md", { mode: "100644", sha: "aaa" }],
    ["src/index.ts", { mode: "100644", sha: "bbb" }],
  ])
  const published = new Map([["README.md", { mode: "100644", sha: "aaa" }]])

  const difference = diffTrees(local, published)

  assert.deepEqual(difference.missing, ["src/index.ts"])
  assert.deepEqual(difference.differing, [])
  assert.deepEqual(difference.extra, [])
})

test("reports a changed blob as a difference", () => {
  const local = new Map([["README.md", { mode: "100644", sha: "aaa" }]])
  const published = new Map([["README.md", { mode: "100644", sha: "ccc" }]])

  const difference = diffTrees(local, published)

  assert.deepEqual(difference.differing, ["README.md"])
  assert.deepEqual(difference.missing, [])
})

test("reports a changed mode as a difference", () => {
  const local = new Map([["run.sh", { mode: "100755", sha: "aaa" }]])
  const published = new Map([["run.sh", { mode: "100644", sha: "aaa" }]])

  assert.deepEqual(diffTrees(local, published).differing, ["run.sh"])
})

test("reports a published file the local tree does not have", () => {
  const local = new Map([["README.md", { mode: "100644", sha: "aaa" }]])
  const published = new Map([
    ["README.md", { mode: "100644", sha: "aaa" }],
    ["NOTES.md", { mode: "100644", sha: "ddd" }],
  ])

  assert.deepEqual(diffTrees(local, published).extra, ["NOTES.md"])
})

test("two identical trees have no difference", () => {
  const entries = new Map([
    ["README.md", { mode: "100644", sha: "aaa" }],
    ["src/index.ts", { mode: "100644", sha: "bbb" }],
  ])

  const difference = diffTrees(entries, new Map(entries))

  assert.deepEqual(difference.missing, [])
  assert.deepEqual(difference.differing, [])
  assert.deepEqual(difference.extra, [])
})

test("parses the output of git ls-tree", () => {
  const output = [
    "100644 blob aaa\tREADME.md",
    "100755 blob bbb\tscripts/run.sh",
    "040000 tree ccc\tsrc",
  ].join("\n")

  const entries = parseLsTree(output)

  assert.equal(entries.size, 2)
  assert.deepEqual(entries.get("README.md"), { mode: "100644", sha: "aaa" })
  assert.deepEqual(entries.get("scripts/run.sh"), { mode: "100755", sha: "bbb" })
})

test("ignores malformed lines in git ls-tree output", () => {
  assert.equal(parseLsTree("").size, 0)
  assert.equal(parseLsTree("not a tree line").size, 0)
  assert.equal(parseLsTree("100644 blob\tshort-sha").size, 0)
})

test("parses the recursive tree listing of the GitHub API", () => {
  const entries = parseApiTree([
    { path: "README.md", mode: "100644", type: "blob", sha: "aaa" },
    { path: "src", mode: "040000", type: "tree", sha: "bbb" },
    { path: "src/index.ts", mode: "100644", type: "blob", sha: "ccc" },
    { path: "broken" },
  ])

  assert.equal(entries.size, 2)
  assert.deepEqual(entries.get("src/index.ts"), { mode: "100644", sha: "ccc" })
})

test("encodes a content path without encoding its separators", () => {
  assert.equal(
    encodeContentPath(".github/workflows/ci.yml"),
    ".github%2Fworkflows%2Fci.yml".replace(/%2F/g, "/"),
  )
  assert.equal(encodeContentPath("README.md"), "README.md")
  assert.equal(encodeContentPath("a b/c#d.ts"), "a%20b/c%23d.ts")
})

test("explains a refused workflow write as a permission problem", () => {
  const explanation = explainRefusal(".github/workflows/ci.yml", 404)

  assert.match(explanation, /workflow scope/)
  assert.match(explanation, /Workflows: write/)
})

test("explains any other refusal without guessing", () => {
  assert.match(explainRefusal("README.md", 404), /repository write access/)
  assert.match(explainRefusal("README.md", 422), /HTTP 422/)
})

const SAMPLE_FILES = [
  { path: "README.md", mode: "100644", sha: "aaa" },
  { path: "src/index.ts", mode: "100644", sha: "bbb" },
  { path: "src/runtime/smoke.ts", mode: "100644", sha: "ccc" },
  { path: ".github/workflows/ci.yml", mode: "100644", sha: "ddd" },
]

test("plans the deepest directory first, so a subtree is ready before its parent", () => {
  const plan = planTreeCreation(SAMPLE_FILES)

  assert.deepEqual(
    plan.map((step) => step.dir),
    ["src/runtime", ".github/workflows", "src", ".github", ""],
  )
})

test("a planned blob carries both its entry name and its repository path", () => {
  const plan = planTreeCreation(SAMPLE_FILES)
  const runtime = plan.find((step) => step.dir === "src/runtime")

  assert.ok(runtime !== undefined)
  assert.deepEqual(runtime.blobs, [
    { name: "smoke.ts", path: "src/runtime/smoke.ts", mode: "100644", sha: "ccc" },
  ])
})

test("a directory lists the directories nested in it", () => {
  const plan = planTreeCreation(SAMPLE_FILES)
  const src = plan.find((step) => step.dir === "src")
  const github = plan.find((step) => step.dir === ".github")
  const root = plan.find((step) => step.dir === "")

  assert.ok(src !== undefined && github !== undefined && root !== undefined)
  assert.deepEqual(src.children, ["src/runtime"])
  assert.deepEqual(github.children, [".github/workflows"])
  assert.deepEqual(root.children, [".github", "src"])
})

test("a directory does not claim its parent as a child", () => {
  const plan = planTreeCreation(SAMPLE_FILES)
  const runtime = plan.find((step) => step.dir === "src/runtime")

  assert.ok(runtime !== undefined)
  assert.deepEqual(runtime.children, [])
})

test("the plan describes every file exactly once", () => {
  const plan = planTreeCreation(SAMPLE_FILES)
  const described = plan.flatMap((step) =>
    step.blobs.map((blob) => (step.dir === "" ? blob.name : `${step.dir}/${blob.name}`)),
  )

  assert.deepEqual(described.sort(), SAMPLE_FILES.map((file) => file.path).sort())
})

test("the plan loses no file and invents none", () => {
  const plan = planTreeCreation(SAMPLE_FILES)
  const planned = new Set(
    plan.flatMap((step) => step.blobs.map((blob) => blob.path)),
  )

  for (const file of SAMPLE_FILES) {
    assert.ok(planned.has(file.path), `${file.path} is missing from the plan`)
  }
  assert.equal(planned.size, SAMPLE_FILES.length)
})

test("a release message does not repeat the prefix it already carries", () => {
  assert.equal(
    releaseMessage("release: make the branch rebuild recover from a partial move"),
    "release: make the branch rebuild recover from a partial move",
  )
  assert.equal(releaseMessage("fix: keep the retry budget bounded"), "fix: keep the retry budget bounded")
  assert.equal(releaseMessage("feat(config): add a provider list"), "feat(config): add a provider list")
})

test("a release message names the change when the subject does not", () => {
  assert.equal(releaseMessage("document the publishing procedure"), "Release: document the publishing procedure")
  assert.equal(releaseMessage("  spaced  "), "Release: spaced")
  assert.equal(releaseMessage(""), "Release")
})

test("a commit that carries the whole release names the release", () => {
  assert.equal(
    releaseCommitMessage("opencode-nvidia-provider", "0.1.0"),
    "Release: opencode-nvidia-provider 0.1.0",
  )
  assert.equal(releaseCommitMessage("opencode-nvidia-provider", ""), "Release: opencode-nvidia-provider")
})

test("a base commit that carries a path the local tree lacks would lose it", () => {
  const local = new Map([
    ["README.md", { mode: "100644", sha: "aaa" }],
    ["src/index.ts", { mode: "100644", sha: "bbb" }],
  ])
  const published = new Map([
    ["README.md", { mode: "100644", sha: "aaa" }],
    ["src/index.ts", { mode: "100644", sha: "bbb" }],
    [".probe-junk/database.bin", { mode: "100644", sha: "ccc" }],
  ])

  assert.deepEqual(pathsLostByRebasing(published, local), [".probe-junk/database.bin"])
})

test("a base commit contained in the local tree loses nothing", () => {
  const local = new Map([["README.md", { mode: "100644", sha: "aaa" }]])
  const published = new Map([["README.md", { mode: "100644", sha: "aaa" }]])

  assert.deepEqual(pathsLostByRebasing(published, local), [])
})

/** Writes an environment file in a scratch directory and returns its path. */
function scratchEnvFile(content: string): string {
  const directory = mkdtempSync("/tmp/opencode/publish-tree-test-")
  const file = join(directory, ".env")
  writeFileSync(file, content, "utf8")
  return file
}

test("a token in an environment file is found", () => {
  const file = scratchEnvFile("GITHUB_API_KEY=ghp_example\n")

  try {
    const token = tokenFromEnvFile(file)

    assert.ok(token !== undefined)
    assert.equal(token.value, "ghp_example")
    assert.match(token.label, /GITHUB_API_KEY/)
    assert.match(token.label, /\.env/)
  } finally {
    rmSync(file, { force: true })
  }
})

test("an environment file that holds no token yields nothing", () => {
  const file = scratchEnvFile("SOME_OTHER_KEY=value\n# GITHUB_TOKEN=commented\n\n")

  try {
    assert.equal(tokenFromEnvFile(file), undefined)
  } finally {
    rmSync(file, { force: true })
  }
})

test("a missing environment file yields nothing rather than throwing", () => {
  assert.equal(tokenFromEnvFile("/tmp/opencode/no-such-env-file-9f3a"), undefined)
})

test("an environment file's value is unquoted and trimmed", () => {
  const file = scratchEnvFile('  GITHUB_TOKEN="ghp_quoted"  \n')

  try {
    assert.equal(tokenFromEnvFile(file)?.value, "ghp_quoted")
  } finally {
    rmSync(file, { force: true })
  }
})

test("the environment file's token is offered, and the environment comes first", () => {
  const file = scratchEnvFile("GITHUB_API_KEY=ghp_from_file\n")

  try {
    const tokens = collectTokens({ GITHUB_TOKEN: "ghp_from_environment" }, { envFile: file })
    const labels = tokens.map((token) => token.label)

    assert.ok(labels.some((label) => label.includes("GITHUB_TOKEN environment variable")))
    assert.ok(labels.some((label) => label.includes("GITHUB_API_KEY entry in")))
    assert.equal(tokens[0]?.value, "ghp_from_environment")
  } finally {
    rmSync(file, { force: true })
  }
})

test("a token that appears twice is offered once", () => {
  const file = scratchEnvFile("GITHUB_API_KEY=ghp_same\n")

  try {
    const tokens = collectTokens({ GITHUB_TOKEN: "ghp_same" }, { envFile: file })
    const values = tokens.map((token) => token.value)

    assert.equal(values.filter((value) => value === "ghp_same").length, 1)
  } finally {
    rmSync(file, { force: true })
  }
})
