import { randomUUID } from "node:crypto";

/**
 * Add an Idempotency-Key to a mutating request unless the caller set one.
 *
 * The write surfaces these specs drive require the header and refuse without
 * it — `POST /api/admin/setup/[entity]` answers 400 "Idempotency-Key header is
 * required" before it does anything else. Every workflow spec built its own
 * `api()` helper and none of them supplied a key, so as soon as the first
 * setup POST ran, six suites died on their first write and reported as a
 * Playwright failure rather than as the missing header it was.
 *
 * A caller that passes its own key keeps it: the retry and replay assertions
 * depend on sending the SAME key twice, and generating one per call would
 * quietly turn a replay test into two distinct writes that both succeed.
 *
 * GET and HEAD are left alone — they are not claims and the routes do not ask.
 */
export function withIdempotencyKey(
  method: string,
  headers?: Record<string, string>,
): Record<string, string> {
  const merged = { ...(headers ?? {}) };
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return merged;
  const present = Object.keys(merged).some(
    (name) => name.toLowerCase() === "idempotency-key",
  );
  if (!present) merged["Idempotency-Key"] = randomUUID();
  return merged;
}
