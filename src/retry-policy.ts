import type { RetryConfig } from "./config.ts"

export type FailureKind = "rate-limit" | "server-error"

export type RetryDecision = { retry: false } | { retry: true; delay: number }

export interface RetryIdentity {
  readonly sessionID: string
  readonly agent: string
  readonly model: {
    readonly providerID: string
    readonly id: string
  }
}

export interface RetryEvent extends RetryIdentity {
  readonly attempt: number
  readonly error: {
    readonly type?: string
    readonly message?: string
    readonly status?: number
    readonly retryAfterMs?: number
  }
  readonly decision: RetryDecision
}

export interface RetryPolicy {
  decide(event: RetryEvent, currentDecision: RetryDecision): RetryDecision
  clear(event: RetryIdentity): void
  /** Number of request tuples currently tracked in memory. */
  readonly trackedStates: number
}

interface FailureState {
  lastAttempt: number
  rateLimit: number
  serverError: number
}

/**
 * Upper bound on tracked request tuples. State is held in memory only, but a
 * long-lived server must not grow it without limit.
 *
 * The map evicts the least recently used tuple, so a request that is still
 * failing keeps its budget even when other tuples are created.
 */
export const MAX_TRACKED_STATES = 1_000

export function failureKind(status: number | undefined): FailureKind | undefined {
  if (status === 429) return "rate-limit"
  if (status === 408 || (status !== undefined && status >= 500 && status < 600)) {
    return "server-error"
  }
  return undefined
}

export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)))
  const sample = Math.min(1, Math.max(0, random()))
  return Math.round(exponent * (0.5 + sample * 0.5))
}

/**
 * Key for the in-memory failure counters.
 *
 * Only fields that exist on BOTH hook events may take part: OpenCode's `retry`
 * event carries no `kind`, while `http.response` does. Keying on `kind` would
 * make the success handler unable to clear the retry counters, which would leak
 * state and exhaust the budget of later, unrelated failures.
 */
function stateKey(event: RetryIdentity): string {
  return JSON.stringify([
    event.sessionID,
    event.agent,
    event.model.providerID,
    event.model.id,
  ])
}

export function createRetryPolicy(
  config: RetryConfig,
  random: () => number = Math.random,
): RetryPolicy {
  const providers = new Set(config.providers)
  const states = new Map<string, FailureState>()

  return {
    get trackedStates() {
      return states.size
    },

    decide(event, currentDecision) {
      if (!providers.has(event.model.providerID)) return currentDecision

      const kind = failureKind(event.error.status)
      if (!kind) return currentDecision

      const key = stateKey(event)
      let state = states.get(key)

      if (!state) {
        state = { lastAttempt: event.attempt, rateLimit: 0, serverError: 0 }
      } else {
        // Least-recently-used eviction: a request tuple that is still in use
        // must not be dropped just because newer tuples arrived. Re-inserting
        // the key moves it to the end of the Map's insertion order.
        states.delete(key)

        if (event.attempt <= state.lastAttempt) {
          // A new request restarts the physical attempt counter: start a fresh budget.
          state.lastAttempt = event.attempt
          state.rateLimit = 0
          state.serverError = 0
        } else {
          state.lastAttempt = event.attempt
        }
      }

      states.set(key, state)
      if (states.size > MAX_TRACKED_STATES) {
        const oldest = states.keys().next().value
        if (oldest !== undefined) states.delete(oldest)
      }

      if (kind === "rate-limit") state.rateLimit += 1
      else state.serverError += 1

      const count = kind === "rate-limit" ? state.rateLimit : state.serverError
      const budget = kind === "rate-limit" ? config.rateLimit : config.serverError

      if (count >= budget.maxAttempts) return { retry: false }

      const providerDelay = event.error.retryAfterMs
      if (
        config.respectRetryAfter &&
        providerDelay !== undefined &&
        Number.isFinite(providerDelay) &&
        providerDelay >= 0
      ) {
        return {
          retry: true,
          delay: Math.min(providerDelay, config.maxRetryAfterMs),
        }
      }

      return {
        retry: true,
        delay: backoffDelay(count, budget.baseDelayMs, budget.maxDelayMs, random),
      }
    },

    clear(event) {
      states.delete(stateKey(event))
    },
  }
}
