/**
 * Renderable cause for a failed approval stage (the shared flows
 * contract boundary).
 *
 * Storage failures carry driver internals — the statement, bound
 * parameters, constraint and table detail — that must never render to a
 * decider: they name schema objects and echo operands. Anything shaped
 * like that is logged server-side and replaced with one stable message;
 * curated domain and adapter refusals (plain messages with their remedy)
 * render intact, so existing cause-text contracts hold.
 *
 * Pure leaf (no server imports) so the boundary is unit-tested without a
 * database.
 */
export function sanitizeDecisionCause(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    ("query" in error ||
      "params" in error ||
      "constraint" in error ||
      "detail" in error ||
      "table" in error)
  ) {
    console.error("[flows] approval stage failed on a storage error:", error);
    return "the change could not be recorded because of a storage failure";
  }
  return error instanceof Error ? error.message : String(error);
}
