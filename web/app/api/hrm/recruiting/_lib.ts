import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmChangeRequestError } from "@openbooks/engine/src/hrm/change-requests.ts";
import { CompensationError } from "@openbooks/engine/src/hrm/compensation/errors.ts";
import { HrmPositionError } from "@openbooks/engine/src/hrm/positions.ts";
import { RecruitingError } from "@openbooks/engine/src/hrm/recruiting/errors.ts";

/**
 * Shared error mapping for /api/hrm/recruiting/*. Engine refusals reach the
 * caller with their message intact (the remedy lives in the message) and a
 * status that names the failure shape — never a success, never a bare
 * 'internal error' for a computed refusal.
 */
export function recruitingErrorResponse(e: unknown): NextResponse {
  if (e instanceof RecruitingError) {
    const status =
      e.code === "INVALID_INPUT"
        ? 400
        : e.code === "NOT_FOUND"
          ? 404
          : e.code === "BAD_STATE" || e.code === "STALE_REVISION"
            ? 409
            : 422;
    return NextResponse.json({ error: e.message }, { status });
  }
  // acceptOfferAsHire files the hire through the change-request service
  // inside the hire transaction: a missing approval flow (NO_FLOW), a
  // vacancy refusal, or a headcount-plan refusal is a computed 4xx with
  // the remedy intact — never a 500 — and the throw still rolls the hire
  // back before this mapping runs.
  if (e instanceof HrmChangeRequestError) {
    const status =
      e.code === "INVALID_PAYLOAD"
        ? 400
        : e.code === "NOT_FOUND"
          ? 404
          : e.code === "BAD_STATE" || e.code === "STALE_REVISION"
            ? 409
            : 422;
    return NextResponse.json({ error: e.message }, { status });
  }
  if (e instanceof HrmPositionError) {
    const status =
      e.code === "INVALID_INPUT"
        ? 400
        : e.code === "NOT_FOUND"
          ? 404
          : e.code === "BAD_STATE" || e.code === "STALE_REVISION"
            ? 409
            : 422;
    return NextResponse.json({ error: e.message }, { status });
  }
  if (e instanceof CompensationError) {
    const status =
      e.code === "INVALID_INPUT"
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
  console.error("[hrm] recruiting endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
