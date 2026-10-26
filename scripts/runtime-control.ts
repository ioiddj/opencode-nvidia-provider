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
const completionMarkerPath = join(stateRoot, "control-loaded.json")

// The control fixture is a valid OpenCode plugin that never runs the production
// setup. The runtime gate MUST fail for it; a pass here would mean the gate can
// never fail.
const result = await runRuntimeSmoke({
  binaryPath,
  stateRoot,
  repositoryRoot,
  fixturePath: join(repositoryRoot, "test", "runtime", "control"),
  markerPath,
  completionMarkerPath,
  timeoutMs,
})

if (!result.fixtureLoaded) {
  console.error(
    "FAIL the control fixture never loaded, so the control did not exercise the runtime gate",
  )
  process.exit(1)
}

if (!result.error) {
  console.error(
    "FAIL the runtime gate accepted a fixture that never ran the production plugin setup",
  )
  process.exit(1)
}

console.log(`PASS the runtime gate rejected the control fixture (${result.error})`)
