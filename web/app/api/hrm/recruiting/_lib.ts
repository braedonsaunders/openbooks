import { NextResponse } from "next/server";
import { UnrestrictedScopeError } from "@openbooks/engine/organization/scope";
import { HrmAuthorizationError } from "@openbooks/engine/hrm/authorization";
import { hrmAuthorizationResponse } from "../../../../lib/api/record-not-found";
import { HrmChangeRequestError } from "@openbooks/engine/hrm/change-requests/operations";
import { CompensationError } from "@openbooks/engine/hrm/compensation/errors";
import { HrmPositionError } from "@openbooks/engine/hrm/positions";
import { RecruitingError } from "@openbooks/engine/hrm/recruiting/errors";
import { DuplicateProspectError } from "@openbooks/engine/hrm/recruiting/candidates";

/**
 * Shared error mapping for /api/hrm/recruiting/*. Engine refusals reach the
 * caller with their message intact (the remedy lives in the message) and a
 * status that names the failure shape — never a success, never a bare
 * 'internal error' for a computed refusal.
 */
export function recruitingErrorResponse(e: unknown): NextResponse {
  // The merge-retry island acts on the survivor structurally: a 409 whose
  // candidate names the existing record, never a parsed message.
  if (e instanceof DuplicateProspectError) {
    return NextResponse.json(
      { error: "duplicate-email", candidate: { id: e.candidateId, displayName: e.survivorName } },
      { status: 409 },
    );
  }
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
    return hrmAuthorizationResponse(e);
  }
  if (e instanceof UnrestrictedScopeError) {
    // Org-wide configuration writes by subsidiary-restricted callers: the
    // record is visible and only the scope is lacking, so the refusal names
    // its remedy with the canonical 403 body — never a 500.
    return NextResponse.json({ error: e.message }, { status: 403 });
  }
  console.error("[hrm] recruiting endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
