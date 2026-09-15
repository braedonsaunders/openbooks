/**
 * Shared storage-identity mapping for the platform-connections [id] family.
 * Every handler resolves its connection through the same lookup, and a
 * malformed id (bad uuid text) or dangling reference surfaces as a Postgres
 * input error (22P02) or foreign-key error (23503) — both resolve through the
 * family's not-found contract, never as a raw 500. Anything else rethrows.
 */
export function storageIdentityError(error: unknown): boolean {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "22P02" || candidate.code === "23503") return true;
    current = candidate.cause;
  }
  return false;
}
