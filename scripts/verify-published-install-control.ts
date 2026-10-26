import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseRuntimeTimeout } from "./runtime/smoke.ts"
import { runPublishedInstallCheck } from "./runtime/published-install.ts"

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

// The control is a repository that does not exist. The published-install gate
// MUST fail for it: a pass here would mean the gate accepts anything, and the
// positive result would prove nothing.
const controlSpec = "github:ioiddj/opencode-nvidia-provider-nonexistent-control"

const result = await runPublishedInstallCheck({
  binaryPath,
  stateRoot: join(repositoryRoot, ".runtime-state", "published-install-control"),
  repositoryRoot,
  spec: controlSpec,
  timeoutMs,
})

if (result.ok) {
  console.error(
    "FAIL the published-install gate accepted a package that cannot be installed",
  )
  process.exit(1)
}

if (!result.error?.includes("installer")) {
  console.error(
    `FAIL the control failed for the wrong reason, so it did not exercise the gate: ${result.error}`,
  )
  process.exit(1)
}

console.log(`PASS the published-install gate rejected a package that cannot be installed (${result.error})`)
