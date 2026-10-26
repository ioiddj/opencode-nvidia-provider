import type { Plugin } from "@opencode/plugin"

import { resolveConfig } from "./src/config.ts"
import { createRetryPolicy } from "./src/retry-policy.ts"
import { isPrimaryRequest } from "./src/request-kind.ts"

const runtimeEnvironment =
  typeof process === "undefined" ? {} : (process.env as Record<string, string | undefined>)

/**
 * The plugin is a plain object rather than `Plugin.define({...})`.
 *
 * `Plugin.define` is an identity function, so the wrapper bought nothing but a
 * runtime import of `@opencode/plugin` — and that import drags the whole
 * OpenCode SDK dependency tree into every install. The type-only import below
 * is erased at runtime, so the published plugin has no runtime dependencies
 * at all.
 */
const plugin: Plugin.Plugin = {
  id: "opencode-nvidia-provider",
  async setup(ctx) {
    const config = resolveConfig(ctx.options, runtimeEnvironment)
    const policy = createRetryPolicy(config)

    for (const providerID of config.providers) {
      await ctx.session.hook(
        "http.response",
        (event) => {
          // A successful *housekeeping* request (the session title, a
          // compaction, a generated summary) must never restore the retry
          // budget of the request the user is actually waiting on. Only a
          // successful primary request clears the shared budget.
          if (event.response.status < 400 && isPrimaryRequest(event.kind)) {
            policy.clear(event)
          }
        },
        { providerID },
      )

      await ctx.session.hook(
        "retry",
        (event) => {
          event.decision = policy.decide(event, event.decision)
        },
        { providerID },
      )
    }
  },
}

export default plugin
