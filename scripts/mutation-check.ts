/**
 * Mutation check for the gates this repository relies on.
 *
 * A gate that cannot fail is not a gate. Each mutation below removes or
 * weakens one specific protection; the named test suite must then FAIL. A
 * mutation that is not caught is a finding, not a pass.
 *
 * Usage: npm run test:mutations
 */
import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface Mutation {
  /** What the mutation breaks. */
  readonly name: string
  /** File the mutation is applied to, relative to the repository root. */
  readonly file: string
  /** The exact source text to replace. Must occur exactly once. */
  readonly find: string
  /** The replacement source text. */
  readonly replace: string
  /** The test suite that must catch the mutation. */
  readonly test: string
}

const MUTATIONS: Mutation[] = [
  {
    name: "the state directory is no longer confined to the repository",
    file: "scripts/runtime/smoke.ts",
    find: `  if (!isInside(resolved, repositoryRoot)) reasons.push("it is not inside the repository root")`,
    replace: `  // mutation: the repository containment check was removed`,
    test: "test/runtime-harness.test.ts",
  },
  {
    name: "the fixture may be loaded from outside the repository",
    file: "scripts/runtime/smoke.ts",
    find: `  if (!isInside(resolved, resolve(repositoryRoot))) {`,
    replace: `  if (false) {`,
    test: "test/runtime-harness.test.ts",
  },
  {
    name: "the harness authenticates against a non-loopback address",
    file: "scripts/runtime/smoke.ts",
    find: `  if (!isLoopbackUrl(url)) {`,
    replace: `  if (false) {`,
    test: "test/runtime-harness.test.ts",
  },
  {
    name: "only the first password occurrence is redacted",
    file: "scripts/runtime/smoke.ts",
    find: `const PASSWORD_REDACT_PATTERN = /((?:server\\s+)?password[\\s:=]+)(\\S+)/gi`,
    replace: `const PASSWORD_REDACT_PATTERN = /((?:server\\s+)?password[\\s:=]+)(\\S+)/i`,
    test: "test/runtime-harness.test.ts",
  },
  {
    name: "the base64 Basic credential is no longer redacted",
    file: "scripts/runtime/smoke.ts",
    find: `    const basic = Buffer.from(\`opencode:\${knownSecret}\`).toString("base64")
    if (basic.length > 0) redacted = redacted.split(basic).join("[redacted]")`,
    replace: `    // mutation: the base64 credential redaction was removed`,
    test: "test/runtime-harness.test.ts",
  },
  {
    name: "the server output capture is unbounded",
    file: "scripts/runtime/smoke.ts",
    find: `    while (this.#size > this.limit && this.#lines.length > 1) {`,
    replace: `    while (false) {`,
    test: "test/runtime-harness.test.ts",
  },
  {
    name: "the process group is not signalled after the leader exits",
    file: "scripts/runtime/smoke.ts",
    find: `  if (processGroupExists(pid)) signalGroup("SIGKILL")`,
    replace: `  // mutation: the unconditional group kill was removed`,
    test: "test/runtime-harness.test.ts",
  },
  {
    name: "the retry budget is evicted by age instead of by recency",
    file: "src/retry-policy.ts",
    find: `        states.delete(key)
`,
    replace: `        // mutation: the recency refresh was removed
`,
    test: "test/retry-policy.test.ts",
  },
  {
    name: "a successful housekeeping request restores the retry budget",
    file: "index.ts",
    find: `if (event.response.status < 400 && isPrimaryRequest(event.kind))`,
    replace: `if (event.response.status < 400)`,
    test: "test/plugin.test.ts",
  },
  {
    name: "the provider list is unbounded",
    file: "src/config.ts",
    find: `  return [...new Set(providers)].slice(0, MAX_PROVIDERS)`,
    replace: `  return [...new Set(providers)]`,
    test: "test/config.test.ts",
  },
  {
    name: "the production plugin reads a response body",
    file: "index.ts",
    find: `if (event.response.status < 400 && isPrimaryRequest(event.kind))`,
    replace: `if (event.response.status < 400 && isPrimaryRequest(event.kind) && !event.error.response.body)`,
    test: "test/privacy.test.ts",
  },
]

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const backupDirectory = join(repositoryRoot, ".runtime-state", "mutations")

interface MutationResult {
  readonly name: string
  readonly caught: boolean
  readonly detail: string
}

async function runMutation(mutation: Mutation): Promise<MutationResult> {
  const filePath = join(repositoryRoot, mutation.file)
  const original = await readFile(filePath, "utf8")

  const occurrences = original.split(mutation.find).length - 1
  if (occurrences !== 1) {
    return {
      name: mutation.name,
      caught: false,
      detail: `the mutation anchor matched ${occurrences} times in ${mutation.file}; the source moved`,
    }
  }

  await mkdir(backupDirectory, { recursive: true })
  const backupPath = join(backupDirectory, `${mutation.file.replaceAll("/", "_")}.original`)
  await writeFile(backupPath, original, "utf8")

  try {
    await writeFile(filePath, original.replace(mutation.find, mutation.replace), "utf8")

    const environment = { ...process.env }
    // A nested test run must not inherit the parent's TAP context.
    delete environment.NODE_TEST_CONTEXT

    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--test", mutation.test],
      { cwd: repositoryRoot, encoding: "utf8", env: environment },
    )

    if (result.status === 0) {
      return {
        name: mutation.name,
        caught: false,
        detail: `${mutation.test} still passed; the gate cannot fail`,
      }
    }

    return {
      name: mutation.name,
      caught: true,
      detail: `${mutation.test} failed as expected`,
    }
  } finally {
    await writeFile(filePath, original, "utf8")
  }
}

const results: MutationResult[] = []
for (const mutation of MUTATIONS) {
  const result = await runMutation(mutation)
  results.push(result)
  console.log(`${result.caught ? "caught  " : "SURVIVED"} ${result.name} (${result.detail})`)
}

const survivors = results.filter((result) => !result.caught)

console.log(
  `\n${results.length - survivors.length}/${results.length} mutations caught`,
)

if (survivors.length > 0) {
  console.error(`\n${survivors.length} mutation(s) survived; the gates they target are not real gates.`)
  process.exit(1)
}
