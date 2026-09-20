import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmConstructionError } from "@openbooks/engine/src/hrm/construction/errors.ts";

/**
 * Shared error mapping for /api/hrm/compliance-adjacent routes. Engine
 * refusals reach the caller with their message intact (the remedy lives
 * in the message) and a status that names the failure shape — never a
 * success, never a bare 'internal error' for a computed refusal.
 */
export function constructionErrorResponse(e: unknown): NextResponse {
  if (e instanceof HrmConstructionError) {
    const message = e.message;
    const status = /must be|Unknown|needs|at least|shape|blank/i.test(message)
      ? 400
      : /does not exist|no longer|not exist here|no .* policy|cannot be read back/i.test(message)
        ? 404
        : 422;
    return NextResponse.json({ error: message }, { status });
  }
  if (e instanceof HrmAuthorizationError) {
    const status = /not visible in this organization/.test(e.message) ? 404 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }
  console.error("[hrm] construction endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
