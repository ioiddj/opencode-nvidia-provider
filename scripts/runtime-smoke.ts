import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseRuntimeTimeout, runRuntimeSmoke } from "./runtime/smoke.ts"

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

const stateRoot = join(repositoryRoot, ".runtime-state")
const markerPath = join(stateRoot, "plugin-loaded.json")

const result = await runRuntimeSmoke({
  binaryPath,
  stateRoot,
  repositoryRoot,
  fixturePath: join(repositoryRoot, "test", "runtime"),
  markerPath,
  timeoutMs,
})

if (result.error) {
  console.error(`FAIL ${result.error}\nLog: ${result.logPath}`)
  process.exit(1)
}

console.log(`PASS OpenCode loaded the production plugin and completed setup (marker: ${markerPath})`)
