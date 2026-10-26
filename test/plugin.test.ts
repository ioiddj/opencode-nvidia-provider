import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../index.ts"

type HookName = "retry" | "http.response"
type HookCallback = (event: any) => void | Promise<void>

test("registers provider-scoped retry hooks without persistent storage", async () => {
  const hooks: Array<{ name: HookName; callback: HookCallback; providerID?: string }> = []

  const context = {
    options: {
      providers: ["nvidia"],
      rateLimit: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 2_000 },
    },
    session: {
      hook: async (name: HookName, callback: HookCallback, options?: { providerID?: string }) => {
        hooks.push({ name, callback, providerID: options?.providerID })
        return { dispose: async () => {} }
      },
    },
    storage: {
      get: async () => {
        throw new Error("storage must not be used")
      },
      set: async () => {
        throw new Error("storage must not be used")
      },
    },
  }

  await plugin.setup(context as never)

  assert.deepEqual(
    hooks.map((hook) => [hook.name, hook.providerID]),
    [
      ["http.response", "nvidia"],
      ["retry", "nvidia"],
    ],
  )

  const retryHook = hooks.find((hook) => hook.name === "retry")
  assert.ok(retryHook)

  const first: {
    sessionID: string
    agent: string
    model: { providerID: string; id: string }
    kind: string
    attempt: number
    error: { type: string; message: string; status: number }
    decision: { retry: boolean; delay?: number }
  } = {
    sessionID: "session-1",
    agent: "build",
    model: { providerID: "nvidia", id: "nemotron" },
    kind: "primary",
    attempt: 1,
    error: { type: "provider.rate-limit", message: "rate limited", status: 429 },
    decision: { retry: false },
  }
  const second = { ...first, attempt: 2 }

  await retryHook.callback(first)
  assert.equal(first.decision.retry, true)
  if (first.decision.retry) {
    assert.ok(first.decision.delay !== undefined)
    assert.ok(first.decision.delay >= 500)
    assert.ok(first.decision.delay <= 1_000)
  }

  await retryHook.callback(second)
  assert.deepEqual(second.decision, { retry: false })
})

test("a successful housekeeping request does not restore an exhausted budget", async () => {
  // OpenCode runs the session title, compactions and generated summaries with
  // the same session, agent and model as the user's turn. If one of those
  // succeeded and cleared the shared budget, a rate-limited primary request
  // would be handed a fresh budget and could retry forever.
  const hooks: Array<{ name: HookName; callback: HookCallback; providerID?: string }> = []

  const context = {
    options: {
      providers: ["nvidia"],
      rateLimit: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 2_000 },
    },
    session: {
      hook: async (name: HookName, callback: HookCallback, options?: { providerID?: string }) => {
        hooks.push({ name, callback, providerID: options?.providerID })
        return { dispose: async () => {} }
      },
    },
    storage: {
      get: async () => {
        throw new Error("storage must not be used")
      },
      set: async () => {
        throw new Error("storage must not be used")
      },
    },
  }

  await plugin.setup(context as never)

  const retryHook = hooks.find((hook) => hook.name === "retry")
  const responseHook = hooks.find((hook) => hook.name === "http.response")
  assert.ok(retryHook)
  assert.ok(responseHook)

  const identity = {
    sessionID: "session-1",
    agent: "build",
    model: { providerID: "nvidia", id: "nemotron" },
  }

  const first = {
    ...identity,
    attempt: 1,
    error: { type: "provider.rate-limit", message: "rate limited", status: 429 },
    decision: { retry: false },
  }
  const second = { ...first, attempt: 2 }

  await retryHook.callback(first)
  assert.equal(first.decision.retry, true)
  await retryHook.callback(second)
  assert.deepEqual(second.decision, { retry: false })

  // A housekeeping request succeeds. It must not restore the primary budget.
  await responseHook.callback({
    ...identity,
    kind: "title",
    response: { status: 200 },
  })

  const third = { ...first, attempt: 3 }
  await retryHook.callback(third)
  assert.deepEqual(third.decision, { retry: false })

  // A successful primary request does clear it.
  await responseHook.callback({
    ...identity,
    kind: "primary",
    response: { status: 200 },
  })

  const afterSuccess = { ...first, attempt: 1 }
  await retryHook.callback(afterSuccess)
  assert.equal(afterSuccess.decision.retry, true)
})
