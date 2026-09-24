import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { UnrestrictedScopeError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Shared error mapping for /api/hrm/enrollment-windows, /api/hrm/enrollments,
 * /api/hrm/dependents, and /api/hrm/benefits/* — mirrors the leave shape
 * beside it. Engine refusals reach the caller with their message intact
 * (the remedy lives in the message) and a status that names the failure
 * shape — never a success, never a bare 'internal error' for a computed
 * refusal. Error bodies are checked before they are parsed: every route
 * below returns non-2xx here, so clients must branch on !res.ok first.
 */
export function benefitsErrorResponse(e: unknown): NextResponse {
  if (e instanceof BenefitsError) {
    const status =
      e.code === "INVALID_INPUT" ? 400 : e.code === "NOT_FOUND" ? 404 : e.code === "BAD_STATE" ? 409 : 422;
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
  console.error("[hrm] benefits endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
