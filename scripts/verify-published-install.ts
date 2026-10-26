import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseRuntimeTimeout } from "./runtime/smoke.ts"
import {
  DEFAULT_PUBLISHED_SPEC,
  runPublishedInstallCheck,
} from "./runtime/published-install.ts"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const binaryPath = process.env.OPENCODE_BIN?.trim()

if (!binaryPath) {
  console.error("OPENCODE_BIN must point to an OpenCode V2 executable")
  process.exit(2)
}

let timeoutMs: number
try {
  timeoutMs = parseRuntimeTimeout(process.env.OPENCODE_RUNTIME_TIMEOUT_MS)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const spec = process.env.OPENCODE_PUBLISHED_SPEC?.trim() || DEFAULT_PUBLISHED_SPEC
const stateRoot = join(repositoryRoot, ".runtime-state", "published-install")

const result = await runPublishedInstallCheck({
  binaryPath,
  stateRoot,
  repositoryRoot,
  spec,
  timeoutMs,
})

if (!result.ok) {
  console.error(`FAIL ${result.error}\nLog: ${result.logPath}`)
  process.exit(1)
}

const files = result.layout?.files.length ?? 0
console.log(
  `PASS OpenCode loaded the plugin installed from ${spec} ` +
    `(${files} files, no runtime dependencies: ${result.packageDir})`,
)
