import type { ParsedSessionToken } from "./auth-token-format";

/**
 * Bounded session verification for the request proxy (Edge-safe: no `node:`
 * imports at module load; the database lookup is dynamically imported only on
 * the production path).
 *
 * The proxy runs before routing on EVERY request carrying a session cookie,
 * so an unbounded session-record lookup turns one database stall into a
 * wedged process: every request parks behind the pool timeout and Next
 * answers each with a bare 500 that carries no request id and reaches no
 * error boundary. Bounding the lookup keeps the failure per request — the
 * caller fails this request closed (503 + request id + retry) while the
 * process keeps serving everything else the moment the database returns.
 */

export type SessionLiveness = "active" | "inactive" | "unavailable";

export type SessionLookup = (token: string, parsed: ParsedSessionToken) => Promise<boolean>;

/** A stall longer than this is an outage, not a slow query: fail the request. */
export const SESSION_LOOKUP_TIMEOUT_MS = 5_000;

async function defaultLookup(token: string, parsed: ParsedSessionToken): Promise<boolean> {
  const { isSessionRecordActive } = await import("./auth-session-store");
  return isSessionRecordActive(token, parsed);
}

export async function checkSessionLiveness(
  token: string,
  parsed: ParsedSessionToken,
  opts?: { lookup?: SessionLookup; timeoutMs?: number },
): Promise<SessionLiveness> {
  const lookup = opts?.lookup ?? defaultLookup;
  const timeoutMs = opts?.timeoutMs ?? SESSION_LOOKUP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = lookup(token, parsed);
  // A lookup that settles after the race is still a settlement: swallow it
  // here so the late rejection never surfaces as an unhandled rejection.
  pending.then(undefined, () => {});
  try {
    const outcome = await Promise.race([
      pending,
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), timeoutMs);
      }),
    ]);
    if (outcome === "timed-out") return "unavailable";
    return outcome ? "active" : "inactive";
  } catch {
    // The session store rejects (connection refused, timeout, auth): the
    // session is unverifiable, which is neither active nor provably revoked.
    return "unavailable";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
