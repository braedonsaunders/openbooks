import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmQualificationError } from "@openbooks/engine/src/hrm/qualifications/errors.ts";

/**
 * Shared error mapping for /api/hrm qualification routes. Engine
 * refusals reach the caller with their message intact (the remedy lives
 * in the message) and a status that names the failure shape — never a
 * success, never a bare 'internal error' for a computed refusal.
 */
export function qualificationErrorResponse(e: unknown): NextResponse {
  if (e instanceof HrmQualificationError) {
    const message = e.message;
    const status = /must be|Unknown|needs|blank|at least|requires evidence/i.test(message)
      ? 400
      : /does not exist|no longer|not exist here|not found|cannot be read back|no row was written/i.test(message)
        ? 404
        : 422;
    return NextResponse.json({ error: message }, { status });
  }
  if (e instanceof HrmAuthorizationError) {
    return NextResponse.json({ error: e.message }, { status: 403 });
  }
  console.error("[hrm] qualifications endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
