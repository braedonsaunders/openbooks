import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { LeaveError } from "@openbooks/engine/src/hrm/leave-errors.ts";

/**
 * Shared error mapping for /api/hrm/leave-* — mirrors the change-request
 * shape beside it. Engine refusals reach the caller with their message
 * intact (the remedy lives in the message) and a status that names the
 * failure shape — never a success, never a bare 'internal error' for a
 * computed refusal. Error bodies are checked before they are parsed: every
 * route below returns non-2xx here, so clients must branch on !res.ok first.
 */
export function leaveErrorResponse(e: unknown): NextResponse {
  if (e instanceof LeaveError) {
    const status =
      e.code === "INVALID_INPUT"
        ? 400
        : e.code === "NOT_FOUND"
          ? 404
          : e.code === "BAD_STATE" || e.code === "STALE_RUN"
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
  console.error("[hrm] leave endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
