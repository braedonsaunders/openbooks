import { timingSafeEqual } from "node:crypto";
import { isUuid } from "./list-params";

/**
 * Shared authentication helpers for the worker-to-web seam (`/api/internal/*`).
 *
 * These routes are public (no session) and CSRF-exempt, so the ONLY control is
 * the shared `OPENBOOKS_INTERNAL_TOKEN` header. Every comparison must be
 * constant-time and fail closed when the server has no token configured, and
 * every org id must be validated before it reaches an RLS scope (`withOrg`)
 * so an unparsable id surfaces as a 4xx instead of a Postgres 22P02.
 */

/**
 * Constant-time comparison of a provided internal token against the expected
 * one. Returns false when either side is empty (an unconfigured server never
 * matches) or when the lengths differ; never throws on attacker-shaped input.
 */
export function internalTokenMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read the expected internal token from the environment and compare it with
 * the request's `x-internal-token` header. Convenience wrapper so routes share
 * one header name and one fail-closed rule.
 */
export function requestHasInternalToken(req: Request): boolean {
  return internalTokenMatches(
    req.headers.get("x-internal-token"),
    process.env.OPENBOOKS_INTERNAL_TOKEN,
  );
}

/**
 * Validate an org id supplied by an internal caller. Returns the canonical
 * lowercase uuid, or null when the value is missing, not a string, or not a
 * uuid — callers must reject with a 4xx before opening an org scope.
 */
export function parseInternalOrgId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isUuid(trimmed)) return null;
  return trimmed.toLowerCase();
}
