/**
 * House UUID check shared by every engine module: the 8-4-4-4-12 hex
 * shape. A bare 36-character hex-and-dashes length check is NOT a UUID
 * check — 36 dashes pass it — so actor attribution, idempotency keys, and
 * audit fallbacks must go through this instead. A repo-wide check
 * (scripts/check-uuid-shapes.mjs) refuses new 36-char-shape patterns.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
