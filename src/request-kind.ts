/**
 * Request kinds OpenCode reports on the `http.response` hook event.
 *
 * See `SessionRequestKind` in the OpenCode SDK. A "primary" request is the
 * user's own turn; the others are OpenCode's own bookkeeping.
 */
export type RequestKind = "primary" | "compaction" | "title" | "generate"

/**
 * Whether a response belongs to the request the user is waiting on.
 *
 * Only a primary request may restore a retry budget. A housekeeping request
 * (the session title, a compaction, a generated summary) runs with the same
 * session, agent and model as the primary request, so a housekeeping success
 * would otherwise hand an exhausted primary request a fresh budget.
 *
 * A response without a kind is treated as primary: the plugin cannot prove it
 * is housekeeping, and refusing to clear would leak retry state instead.
 */
export function isPrimaryRequest(kind: string | undefined): boolean {
  return kind === undefined || kind === "primary"
}
