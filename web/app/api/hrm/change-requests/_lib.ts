import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmChangeRequestError } from "@openbooks/engine/src/hrm/change-requests.ts";

/**
 * Shared error mapping for /api/hrm/change-requests/*. Engine refusals
 * reach the caller with their message intact (the remedy lives in the
 * message) and a status that names the failure shape — never a success,
 * never a bare 'internal error' for a computed refusal.
 */
export function changeRequestErrorResponse(e: unknown): NextResponse {
  if (e instanceof HrmChangeRequestError) {
    const status =
      e.code === "INVALID_PAYLOAD" || e.code === "UNKNOWN_KIND"
        ? 400
        : e.code === "NOT_FOUND"
          ? 404
          : e.code === "BAD_STATE" || e.code === "STALE_REVISION"
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
  console.error("[hrm] change-request endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
