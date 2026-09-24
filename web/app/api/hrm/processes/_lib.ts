import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { UnrestrictedScopeError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { HrmProcessError } from "@openbooks/engine/src/hrm/processes.ts";

/**
 * Shared error mapping for /api/hrm/processes/*. Engine refusals reach the
 * caller with their message intact (the remedy lives in the message) and a
 * status that names the failure shape — never a success, never a bare
 * 'internal error' for a computed refusal.
 */
export function processErrorResponse(e: unknown): NextResponse {
  if (e instanceof HrmProcessError) {
    const status =
      e.code === "NOT_FOUND" || e.code === "FEATURE_OFF"
        ? 404
        : e.code === "FORBIDDEN"
          ? 403
          : e.code === "BAD_STATE" || e.code === "DUPLICATE_OPEN"
            ? 409
            : 422;
    return NextResponse.json({ error: e.message }, { status });
  }
  if (e instanceof HrmAuthorizationError) {
    // Unknown/other-org subjects report uniformly not-found so existence
    // cannot be probed across tenants; missing grants are forbidden.
    const status = /not visible in this organization/.test(e.message) ? 404 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }
  if (e instanceof UnrestrictedScopeError) {
    // Org-wide policy/config writes by subsidiary-restricted callers: the
    // record itself is visible, so the refusal names its remedy as a 403.
    return NextResponse.json({ error: e.message }, { status: 403 });
  }
  console.error("[hrm] process endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
