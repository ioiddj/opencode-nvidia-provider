import assert from "node:assert/strict"
import test from "node:test"

import { MAX_PROVIDER_ID_LENGTH, MAX_PROVIDERS, resolveConfig } from "../src/config.ts"

test("uses safe defaults when no options or environment are provided", () => {
  const config = resolveConfig({}, {})

  assert.deepEqual(config.providers, ["nvidia", "nvidia-nim"])
  assert.deepEqual(config.rateLimit, {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
  })
  assert.deepEqual(config.serverError, {
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
  })
  assert.equal(config.respectRetryAfter, true)
  assert.equal(config.maxRetryAfterMs, 300_000)
})

test("accepts nested plugin options", () => {
  const config = resolveConfig(
    {
      providers: ["nvidia", "custom-nvidia"],
      rateLimit: { maxAttempts: 7, baseDelayMs: 2_000, maxDelayMs: 45_000 },
      serverError: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 10_000 },
      respectRetryAfter: false,
      maxRetryAfterMs: 120_000,
    },
    {},
  )

  assert.deepEqual(config.providers, ["nvidia", "custom-nvidia"])
  assert.equal(config.rateLimit.maxAttempts, 7)
  assert.equal(config.rateLimit.baseDelayMs, 2_000)
  assert.equal(config.rateLimit.maxDelayMs, 45_000)
  assert.equal(config.serverError.maxAttempts, 4)
  assert.equal(config.serverError.baseDelayMs, 500)
  assert.equal(config.serverError.maxDelayMs, 10_000)
  assert.equal(config.respectRetryAfter, false)
  assert.equal(config.maxRetryAfterMs, 120_000)
})

test("valid environment variables override plugin options", () => {
  const config = resolveConfig(
    {
      providers: ["nvidia"],
      rateLimit: { maxAttempts: 7, baseDelayMs: 2_000, maxDelayMs: 45_000 },
    },
    {
      NVIDIA_PROVIDERS: "nvidia,nvidia-nim,custom-nvidia",
      NVIDIA_MAX_429_ATTEMPTS: "9",
      NVIDIA_429_BASE_MS: "2500",
      NVIDIA_429_CAP_MS: "60000",
      NVIDIA_MAX_5XX_ATTEMPTS: "6",
      NVIDIA_5XX_BASE_MS: "750",
      NVIDIA_5XX_CAP_MS: "20000",
      NVIDIA_RESPECT_RETRY_AFTER: "false",
      NVIDIA_MAX_RETRY_AFTER_MS: "90000",
    },
  )

  assert.deepEqual(config.providers, ["nvidia", "nvidia-nim", "custom-nvidia"])
  assert.equal(config.rateLimit.maxAttempts, 9)
  assert.equal(config.rateLimit.baseDelayMs, 2_500)
  assert.equal(config.rateLimit.maxDelayMs, 60_000)
  assert.equal(config.serverError.maxAttempts, 6)
  assert.equal(config.serverError.baseDelayMs, 750)
  assert.equal(config.serverError.maxDelayMs, 20_000)
  assert.equal(config.respectRetryAfter, false)
  assert.equal(config.maxRetryAfterMs, 90_000)
})

test("ignores malformed values instead of disabling retry protection", () => {
  const config = resolveConfig(
    {
      rateLimit: { maxAttempts: 7, baseDelayMs: 2_000 },
      respectRetryAfter: false,
    },
    {
      NVIDIA_MAX_429_ATTEMPTS: "not-a-number",
      NVIDIA_429_BASE_MS: "-1",
      NVIDIA_5XX_CAP_MS: "Infinity",
      NVIDIA_RESPECT_RETRY_AFTER: "perhaps",
    },
  )

  assert.equal(config.rateLimit.maxAttempts, 7)
  assert.equal(config.rateLimit.baseDelayMs, 2_000)
  assert.equal(config.serverError.maxDelayMs, 15_000)
  assert.equal(config.respectRetryAfter, false)
})

test("treats an empty environment variable as unset rather than zero", () => {
  // Deployment templates routinely render an unset variable as "". Number("")
  // is 0, which would silently disable every backoff delay.
  const config = resolveConfig(
    {
      rateLimit: { baseDelayMs: 2_000, maxDelayMs: 20_000 },
      serverError: { baseDelayMs: 750, maxDelayMs: 10_000 },
    },
    {
      NVIDIA_429_BASE_MS: "",
      NVIDIA_429_CAP_MS: "   ",
      NVIDIA_5XX_BASE_MS: "",
      NVIDIA_5XX_CAP_MS: "",
    },
  )

  assert.equal(config.rateLimit.baseDelayMs, 2_000)
  assert.equal(config.rateLimit.maxDelayMs, 20_000)
  assert.equal(config.serverError.baseDelayMs, 750)
  assert.equal(config.serverError.maxDelayMs, 10_000)
})

test("rejects non-decimal numeric strings", () => {
  const config = resolveConfig(
    { rateLimit: { baseDelayMs: 2_000 } },
    {
      NVIDIA_429_BASE_MS: "1e3",
      NVIDIA_429_CAP_MS: "0x10",
    },
  )

  assert.equal(config.rateLimit.baseDelayMs, 2_000)
  assert.equal(config.rateLimit.maxDelayMs, 30_000)
})

test("deduplicates providers and rejects empty provider lists", () => {
  const config = resolveConfig({ providers: ["nvidia", "nvidia", "", "  "] }, {})
  assert.deepEqual(config.providers, ["nvidia"])

  const fallback = resolveConfig({ providers: [] }, {})
  assert.deepEqual(fallback.providers, ["nvidia", "nvidia-nim"])
})

test("raises an effective maximum delay that is below the base delay", () => {
  // A cap under the base delay would make every computed delay exceed its own
  // cap, so the effective maximum is raised to the base delay.
  const config = resolveConfig(
    {
      rateLimit: { baseDelayMs: 5_000, maxDelayMs: 1_000 },
      serverError: { baseDelayMs: 750, maxDelayMs: 100 },
    },
    {},
  )

  assert.equal(config.rateLimit.baseDelayMs, 5_000)
  assert.equal(config.rateLimit.maxDelayMs, 5_000)
  assert.equal(config.serverError.baseDelayMs, 750)
  assert.equal(config.serverError.maxDelayMs, 750)
})

test("caps the number of providers the plugin will act on", () => {
  // Every provider costs two hook registrations at setup time, so the list
  // needs a ceiling like every other knob.
  const providers = Array.from({ length: MAX_PROVIDERS + 50 }, (_, index) => `provider-${index}`)

  const config = resolveConfig({ providers }, {})

  assert.equal(config.providers.length, MAX_PROVIDERS)
  assert.equal(config.providers[0], "provider-0")
  assert.equal(config.providers[MAX_PROVIDERS - 1], `provider-${MAX_PROVIDERS - 1}`)
})

test("caps the number of providers read from the environment", () => {
  const providers = Array.from({ length: MAX_PROVIDERS + 10 }, (_, index) => `provider-${index}`)

  const config = resolveConfig({}, { NVIDIA_PROVIDERS: providers.join(",") })

  assert.equal(config.providers.length, MAX_PROVIDERS)
})

test("drops a provider id that is longer than the allowed length", () => {
  const config = resolveConfig(
    { providers: ["nvidia", "x".repeat(MAX_PROVIDER_ID_LENGTH + 1)] },
    {},
  )

  assert.deepEqual(config.providers, ["nvidia"])
})
