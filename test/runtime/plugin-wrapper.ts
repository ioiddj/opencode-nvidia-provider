import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { Plugin } from "@opencode/plugin"

import productionPlugin from "../../index.ts"
import { resolveConfig } from "../../src/config.ts"

const markerPath = process.env.OPENCODE_NVIDIA_RUNTIME_MARKER

if (!markerPath) {
  throw new Error("OPENCODE_NVIDIA_RUNTIME_MARKER is required")
}

interface HookRegistration {
  readonly name: string
  readonly providerID?: string
}

// A plain object rather than `Plugin.define({...})`: `define` is an identity
// function, and the type-only import above is erased at runtime, so the
// fixture needs no installed packages to run.
const fixture: Plugin.Plugin = {
  id: "opencode-nvidia-provider.runtime-smoke",
  async setup(ctx) {
    const registrations: HookRegistration[] = []

    // Observe the hook registrations the production plugin performs, then hand
    // the production setup the same context. The runtime gate asserts the
    // registrations, so a renamed hook or a missing provider filter fails it.
    const observedSession = new Proxy(ctx.session, {
      get(target, property, receiver) {
        if (property === "hook") {
          return async (
            name: string,
            callback: unknown,
            options?: { providerID?: string },
          ) => {
            registrations.push({ name, providerID: options?.providerID })
            return target.hook(name as never, callback as never, options as never)
          }
        }

        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })

    const observedContext = { ...ctx, session: observedSession }

    await productionPlugin.setup(observedContext as typeof ctx)

    const config = resolveConfig(ctx.options, process.env as Record<string, string | undefined>)

    await mkdir(dirname(markerPath), { recursive: true })
    await writeFile(
      markerPath,
      JSON.stringify({
        pluginID: productionPlugin.id,
        location: ctx.location.directory,
        setupCompleted: true,
        providers: config.providers,
        hooks: registrations,
      }),
      "utf8",
    )
  },
}

export default fixture
