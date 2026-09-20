import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmChangeRequestError } from "@openbooks/engine/src/hrm/change-requests.ts";
import { SelfServiceError } from "@openbooks/engine/src/hrm/self-service/actor.ts";
import { changeRequestErrorResponse } from "../change-requests/_lib.ts";

/**
 * Shared error mapping for /api/hrm/me/*. Engine refusals reach the caller
 * with their message intact (the remedy lives in the message) and a status
 * that names the failure shape — never a success, never a bare 'internal
 * error' for a computed refusal. Self-service refusals map by code: a
 * missing person link or an empty team is forbidden (the login is valid
 * but the workspace cannot open), an unreadable row is not-found, and a
 * malformed proposal is bad-request. Nested change-request and
 * authorization refusals delegate to the shared change-request mapping so
 * the two surfaces never describe the same failure differently.
 */
export function meErrorResponse(e: unknown): NextResponse {
  if (e instanceof SelfServiceError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "REFUSED" ? 400 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }
  if (e instanceof HrmChangeRequestError || e instanceof HrmAuthorizationError) {
    return changeRequestErrorResponse(e);
  }
  console.error("[hrm] self-service endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
