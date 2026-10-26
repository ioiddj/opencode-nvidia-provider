export interface RetryBudget {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface RetryConfig {
  providers: string[]
  rateLimit: RetryBudget
  serverError: RetryBudget
  respectRetryAfter: boolean
  maxRetryAfterMs: number
}

export type Environment = Record<string, string | undefined>

const DEFAULT_PROVIDERS = ["nvidia", "nvidia-nim"]
const DEFAULT_RATE_LIMIT: RetryBudget = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
}
const DEFAULT_SERVER_ERROR: RetryBudget = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const INTEGER_PATTERN = /^[+-]?\d+$/

function integerInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  let parsed: number
  if (typeof value === "number") {
    parsed = value
  } else if (typeof value === "string") {
    const trimmed = value.trim()
    // An empty or non-decimal value is not a number. `Number("")` is 0 and
    // `Number("1e3")` is 1000; accepting either would silently change behaviour.
    if (!INTEGER_PATTERN.test(trimmed)) return undefined
    parsed = Number(trimmed)
  } else {
    return undefined
  }

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return undefined
  }
  return parsed
}

function firstInteger(
  environmentValue: string | undefined,
  optionValue: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return (
    integerInRange(environmentValue, minimum, maximum) ??
    integerInRange(optionValue, minimum, maximum) ??
    fallback
  )
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return undefined

  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
      return true
    case "false":
    case "0":
    case "no":
      return false
    default:
      return undefined
  }
}

/**
 * Maximum number of provider ids the plugin will act on.
 *
 * Every provider costs two hook registrations at setup time, and the list can
 * come from an environment variable, so it needs a ceiling like every other
 * knob in this file.
 */
export const MAX_PROVIDERS = 64

/** Maximum length of a single provider id. */
export const MAX_PROVIDER_ID_LENGTH = 128

function providerList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const providers = value
    .filter((provider): provider is string => typeof provider === "string")
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0 && provider.length <= MAX_PROVIDER_ID_LENGTH)

  if (providers.length === 0) return undefined
  // Extra ids are dropped rather than rejected, so an over-long list still
  // configures the providers an operator listed first.
  return [...new Set(providers)].slice(0, MAX_PROVIDERS)
}

function environmentProviders(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return providerList(value.split(","))
}

export function resolveConfig(options: unknown, environment: Environment = {}): RetryConfig {
  const root = isRecord(options) ? options : {}
  const rateLimitOptions = isRecord(root.rateLimit) ? root.rateLimit : {}
  const serverErrorOptions = isRecord(root.serverError) ? root.serverError : {}

  const rateLimitBaseDelayMs = firstInteger(
    environment.NVIDIA_429_BASE_MS,
    rateLimitOptions.baseDelayMs,
    DEFAULT_RATE_LIMIT.baseDelayMs,
    0,
    3_600_000,
  )
  const serverErrorBaseDelayMs = firstInteger(
    environment.NVIDIA_5XX_BASE_MS,
    serverErrorOptions.baseDelayMs,
    DEFAULT_SERVER_ERROR.baseDelayMs,
    0,
    3_600_000,
  )

  const rateLimitMaxDelayMs = Math.max(
    rateLimitBaseDelayMs,
    firstInteger(
      environment.NVIDIA_429_CAP_MS,
      rateLimitOptions.maxDelayMs,
      DEFAULT_RATE_LIMIT.maxDelayMs,
      0,
      3_600_000,
    ),
  )
  const serverErrorMaxDelayMs = Math.max(
    serverErrorBaseDelayMs,
    firstInteger(
      environment.NVIDIA_5XX_CAP_MS,
      serverErrorOptions.maxDelayMs,
      DEFAULT_SERVER_ERROR.maxDelayMs,
      0,
      3_600_000,
    ),
  )

  return {
    providers:
      environmentProviders(environment.NVIDIA_PROVIDERS) ??
      providerList(root.providers) ??
      [...DEFAULT_PROVIDERS],
    rateLimit: {
      maxAttempts: firstInteger(
        environment.NVIDIA_MAX_429_ATTEMPTS,
        rateLimitOptions.maxAttempts,
        DEFAULT_RATE_LIMIT.maxAttempts,
        1,
        20,
      ),
      baseDelayMs: rateLimitBaseDelayMs,
      maxDelayMs: rateLimitMaxDelayMs,
    },
    serverError: {
      maxAttempts: firstInteger(
        environment.NVIDIA_MAX_5XX_ATTEMPTS,
        serverErrorOptions.maxAttempts,
        DEFAULT_SERVER_ERROR.maxAttempts,
        1,
        20,
      ),
      baseDelayMs: serverErrorBaseDelayMs,
      maxDelayMs: serverErrorMaxDelayMs,
    },
    respectRetryAfter:
      booleanValue(environment.NVIDIA_RESPECT_RETRY_AFTER) ??
      booleanValue(root.respectRetryAfter) ??
      true,
    maxRetryAfterMs: firstInteger(
      environment.NVIDIA_MAX_RETRY_AFTER_MS,
      root.maxRetryAfterMs,
      300_000,
      0,
      86_400_000,
    ),
  }
}
