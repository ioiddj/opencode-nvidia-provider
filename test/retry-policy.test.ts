import assert from "node:assert/strict"
import test from "node:test"

import type { RetryConfig } from "../src/config.ts"
import { backoffDelay, createRetryPolicy, MAX_TRACKED_STATES, type RetryEvent } from "../src/retry-policy.ts"

const config: RetryConfig = {
  providers: ["nvidia", "nvidia-nim"],
  rateLimit: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  serverError: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 15_000 },
  respectRetryAfter: true,
  maxRetryAfterMs: 300_000,
}

function event(overrides: Partial<RetryEvent> = {}): RetryEvent {
  return {
    sessionID: "session-1",
    agent: "build",
    model: { providerID: "nvidia", id: "nemotron" },
    attempt: 1,
    error: { type: "provider.rate-limit", message: "rate limited", status: 429 },
    decision: { retry: false },
    ...overrides,
  }
}

test("leaves decisions for other providers unchanged", () => {
  const policy = createRetryPolicy(config, () => 0)
  const input = event({ model: { providerID: "openai", id: "gpt" } })

  const result = policy.decide(input, input.decision)

  assert.deepEqual(result, { retry: false })
})

test("leaves non-retryable statuses unchanged", () => {
  const policy = createRetryPolicy(config, () => 0)
  const input = event({ error: { type: "provider.invalid-request", message: "bad request", status: 400 } })

  const result = policy.decide(input, input.decision)

  assert.deepEqual(result, { retry: false })
})

test("retries rate limits with bounded exponential backoff", () => {
  const policy = createRetryPolicy(config, () => 1)
  const input = event()

  const result = policy.decide(input, input.decision)

  assert.deepEqual(result, { retry: true, delay: 1_000 })
})

test("vetoes a retry once the configured attempt budget is spent", () => {
  const policy = createRetryPolicy(config, () => 1)
  const first = event({ attempt: 1 })
  const second = event({ attempt: 2 })
  const third = event({ attempt: 3 })
  const fourth = event({ attempt: 4 })
  const fifth = event({ attempt: 5 })

  assert.equal(policy.decide(first, first.decision).retry, true)
  assert.equal(policy.decide(second, second.decision).retry, true)
  assert.equal(policy.decide(third, third.decision).retry, true)
  assert.equal(policy.decide(fourth, fourth.decision).retry, true)
  assert.deepEqual(policy.decide(fifth, fifth.decision), { retry: false })
})

test("keeps rate-limit and server-error budgets independent", () => {
  const policy = createRetryPolicy(config, () => 1)
  const rateLimitOne = event({ attempt: 1 })
  const serverOne = event({ attempt: 2, error: { type: "provider.internal", message: "server error", status: 503 } })
  const rateLimitTwo = event({ attempt: 3 })
  const rateLimitThree = event({ attempt: 4 })
  const rateLimitFour = event({ attempt: 5 })
  const rateLimitFive = event({ attempt: 6 })
  const serverTwo = event({ attempt: 7, error: { type: "provider.internal", message: "server error", status: 503 } })
  const serverThree = event({ attempt: 8, error: { type: "provider.internal", message: "server error", status: 503 } })

  assert.equal(policy.decide(rateLimitOne, rateLimitOne.decision).retry, true)
  assert.equal(policy.decide(serverOne, serverOne.decision).retry, true)
  assert.equal(policy.decide(rateLimitTwo, rateLimitTwo.decision).retry, true)
  assert.equal(policy.decide(rateLimitThree, rateLimitThree.decision).retry, true)
  assert.equal(policy.decide(rateLimitFour, rateLimitFour.decision).retry, true)
  assert.deepEqual(policy.decide(rateLimitFive, rateLimitFive.decision), { retry: false })
  assert.equal(policy.decide(serverTwo, serverTwo.decision).retry, true)
  assert.deepEqual(policy.decide(serverThree, serverThree.decision), { retry: false })
})

test("uses and caps a provider-supplied retry delay", () => {
  const policy = createRetryPolicy(config, () => 1)
  const input = event({ error: { type: "provider.rate-limit", message: "slow down", status: 429, retryAfterMs: 120_000 } })

  assert.deepEqual(policy.decide(input, input.decision), { retry: true, delay: 120_000 })

  const capped = createRetryPolicy({ ...config, maxRetryAfterMs: 60_000 }, () => 1)
  assert.deepEqual(capped.decide(input, input.decision), { retry: true, delay: 60_000 })
})

test("starts a fresh budget when a new request restarts physical attempts", () => {
  const policy = createRetryPolicy({ ...config, rateLimit: { ...config.rateLimit, maxAttempts: 2 } }, () => 1)
  const firstRequestOne = event({ attempt: 1 })
  const firstRequestTwo = event({ attempt: 2 })
  const secondRequestOne = event({ attempt: 1 })

  assert.equal(policy.decide(firstRequestOne, firstRequestOne.decision).retry, true)
  assert.deepEqual(policy.decide(firstRequestTwo, firstRequestTwo.decision), { retry: false })
  assert.equal(policy.decide(secondRequestOne, secondRequestOne.decision).retry, true)
})

test("clears tracked state after a successful response", () => {
  const policy = createRetryPolicy({ ...config, rateLimit: { ...config.rateLimit, maxAttempts: 2 } }, () => 1)
  const failure = event({ attempt: 1 })
  const success = event({ attempt: 2, error: { type: "provider.internal", message: "ok", status: 200 } })
  const nextFailure = event({ attempt: 1 })

  assert.equal(policy.decide(failure, failure.decision).retry, true)
  policy.clear(success)
  assert.equal(policy.decide(nextFailure, nextFailure.decision).retry, true)
})

test("a successful response clears the budget of the matching request tuple", () => {
  // OpenCode's `retry` event carries no `kind`, while `http.response` does. The
  // state key must therefore be built from fields both events share, otherwise
  // the success handler can never clear the retry counters.
  const policy = createRetryPolicy({ ...config, rateLimit: { ...config.rateLimit, maxAttempts: 2 } }, () => 1)

  const first = event({ attempt: 1 })
  const second = event({ attempt: 2 })
  assert.equal(policy.decide(first, first.decision).retry, true)
  assert.deepEqual(policy.decide(second, second.decision), { retry: false })
  assert.equal(policy.trackedStates, 1)

  // The real http.response event shape: same tuple, plus a `kind` field.
  policy.clear({
    sessionID: "session-1",
    agent: "build",
    model: { providerID: "nvidia", id: "nemotron" },
    kind: "primary",
  } as never)

  // The tracked state must be gone, not merely reset by the next attempt number.
  assert.equal(policy.trackedStates, 0)

  const afterSuccess = event({ attempt: 1 })
  assert.equal(policy.decide(afterSuccess, afterSuccess.decision).retry, true)
})

test("bounds the number of tracked request tuples", () => {
  const policy = createRetryPolicy(config, () => 1)

  for (let index = 0; index < MAX_TRACKED_STATES + 250; index += 1) {
    const input = event({ sessionID: `session-${index}` })
    policy.decide(input, input.decision)
  }

  assert.equal(policy.trackedStates, MAX_TRACKED_STATES)
})

test("evicts the least recently used tuple, not the oldest one", () => {
  // A request tuple that is still failing must keep its budget even when
  // other tuples are created, so the eviction has to follow recency.
  const policy = createRetryPolicy(
    { ...config, rateLimit: { ...config.rateLimit, maxAttempts: 2 } },
    () => 1,
  )

  const hot = event({ sessionID: "hot", attempt: 1 })
  assert.equal(policy.decide(hot, hot.decision).retry, true)

  // Fill the map to its bound without evicting anything yet.
  for (let index = 0; index < MAX_TRACKED_STATES - 1; index += 1) {
    const cold = event({ sessionID: `cold-${index}` })
    policy.decide(cold, cold.decision)
  }
  assert.equal(policy.trackedStates, MAX_TRACKED_STATES)

  // Touch the hot tuple: it is now the most recently used one, and its budget
  // is spent.
  const hotSecond = event({ sessionID: "hot", attempt: 2 })
  assert.deepEqual(policy.decide(hotSecond, hotSecond.decision), { retry: false })

  // One more tuple pushes the map past its bound and forces an eviction.
  const overflow = event({ sessionID: "overflow" })
  policy.decide(overflow, overflow.decision)
  assert.equal(policy.trackedStates, MAX_TRACKED_STATES)

  // The hot tuple kept its exhausted budget: it was not the eviction victim.
  const hotThird = event({ sessionID: "hot", attempt: 3 })
  assert.deepEqual(policy.decide(hotThird, hotThird.decision), { retry: false })
})

test("backoff is capped and always stays within the jitter envelope", () => {
  assert.equal(backoffDelay(1, 1_000, 30_000, () => 0), 500)
  assert.equal(backoffDelay(1, 1_000, 30_000, () => 1), 1_000)
  assert.equal(backoffDelay(20, 1_000, 30_000, () => 1), 30_000)
})
