import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Production source files. The runtime harness under `scripts/` is deliberately
 * NOT scanned: it is allowed to talk to a local server. Only the shipped
 * plugin code is bound by the privacy contract.
 */
const PRODUCTION_FILES = ["index.ts", "src/config.ts", "src/retry-policy.ts", "src/request-kind.ts"]

interface Rule {
  readonly name: string
  readonly pattern: RegExp
}

/**
 * Property accesses and calls that would mean the plugin is reading, logging,
 * persisting, or transmitting material it promises not to touch.
 */
const FORBIDDEN_RULES: Rule[] = [
  { name: "response body", pattern: /\.body\b/ },
  { name: "prompt", pattern: /\.prompt\b/ },
  { name: "messages", pattern: /\.messages\b/ },
  { name: "headers", pattern: /\.headers\b/ },
  { name: "authorization", pattern: /\.authorization\b/ },
  { name: "API key", pattern: /\.api_?key\b/i },
  { name: "credential", pattern: /\.credential\b/i },
  { name: "plugin storage", pattern: /\bctx\.storage\b/ },
  { name: "outbound HTTP", pattern: /\b(?:fetch|axios|got|undici|request)\s*\(/ },
  { name: "node HTTP request", pattern: /\b(?:http|https)\.request\s*\(/ },
  { name: "file write", pattern: /\b(?:writeFile|appendFile|createWriteStream)\s*\(/ },
  { name: "browser storage", pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b/ },
  { name: "logging", pattern: /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/ },
]

/**
 * Removes comments and string literal contents, so the rules below match code
 * rather than prose. A comment that says "request (" is not an outbound HTTP
 * call; a call that says `fetch(` is.
 */
export function stripCommentsAndStrings(source: string): string {
  let result = ""
  let index = 0

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1
      }
      index += 2
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      result += " "
      continue
    }

    result += char
    index += 1
  }

  return result
}

/** Reports which forbidden accesses appear in a piece of source. */
export function findForbiddenAccesses(source: string): string[] {
  const code = stripCommentsAndStrings(source)
  return FORBIDDEN_RULES.filter((rule) => rule.pattern.test(code)).map((rule) => rule.name)
}

test("the privacy scanner rejects source that reads a response body", () => {
  // The scanner has to be able to fail, otherwise the contract test below is
  // decoration rather than a gate.
  assert.deepEqual(findForbiddenAccesses("const text = event.error.response.body"), [
    "response body",
  ])
})

test("the privacy scanner rejects source that calls fetch", () => {
  assert.deepEqual(findForbiddenAccesses("await fetch('https://example.test')"), [
    "outbound HTTP",
  ])
})

test("the privacy scanner accepts source that only reads failure metadata", () => {
  const source = [
    "const status = event.error.status",
    "const delay = event.error.retryAfterMs",
    "event.decision = policy.decide(event, event.decision)",
  ].join("\n")

  assert.deepEqual(findForbiddenAccesses(source), [])
})

test("the privacy scanner ignores prose in comments", () => {
  // A comment describing a request is not a request.
  const source = [
    "// The request (the user's turn) is not read here.",
    "/* fetch() would be an outbound HTTP call. */",
    "const status = event.error.status",
  ].join("\n")

  assert.deepEqual(findForbiddenAccesses(source), [])
})

test("the privacy scanner still sees a call hidden behind a string literal", () => {
  const source = ['const label = "fetch("', "await fetch(url)"].join("\n")

  assert.deepEqual(findForbiddenAccesses(source), ["outbound HTTP"])
})

test("the production plugin never references secret-bearing material", async () => {
  for (const file of PRODUCTION_FILES) {
    const source = await readFile(join(repositoryRoot, file), "utf8")

    assert.deepEqual(
      findForbiddenAccesses(source),
      [],
      `${file} references material the plugin promises not to touch`,
    )
  }
})

test("the production plugin does read the failure signal it claims to read", async () => {
  // A scanner that matched nothing because the plugin stopped reading anything
  // would be a vacuous pass.
  const source = await readFile(join(repositoryRoot, "src/retry-policy.ts"), "utf8")

  assert.match(source, /error\.status/)
  assert.match(source, /error\.retryAfterMs/)
})

test("the production plugin reads the response status it claims to read", async () => {
  const source = await readFile(join(repositoryRoot, "index.ts"), "utf8")

  assert.match(source, /response\.status/)
})
