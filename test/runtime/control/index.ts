import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { Plugin } from "@opencode/plugin"

const controlMarkerPath = process.env.OPENCODE_NVIDIA_RUNTIME_CONTROL_MARKER

if (!controlMarkerPath) {
  throw new Error("OPENCODE_NVIDIA_RUNTIME_CONTROL_MARKER is required")
}

// A deliberately minimal plugin: it proves OpenCode loaded the configured plugin
// directory, but it never invokes the production setup and never writes the
// production marker.
//
// A plain object rather than `Plugin.define({...})`: `define` is an identity
// function, and the type-only import above is erased at runtime.
const control: Plugin.Plugin = {
  id: "opencode-nvidia-provider.runtime-control",
  async setup() {
    await mkdir(dirname(controlMarkerPath), { recursive: true })
    await writeFile(
      controlMarkerPath,
      JSON.stringify({ controlLoaded: true, setupCompleted: false }),
      "utf8",
    )
  },
}

export default control
