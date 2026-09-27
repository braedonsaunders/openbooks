/**
 * House UUID check shared by every engine module: the 8-4-4-4-12 hex
 * shape. A bare 36-character hex-and-dashes length check is NOT a UUID
 * check — 36 dashes pass it — so actor attribution, idempotency keys, and
 * audit fallbacks must go through this instead. A repo-wide check
 * (scripts/check-uuid-shapes.mjs) refuses new 36-char-shape patterns.
 *
 * Written with an explicit A-F class and NO case-insensitive flag: JSON
 * Schema patterns carry no flags, so the assistant's tool schemas emit this
 * same source and a provider validates exactly the values zod does.
 */
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
