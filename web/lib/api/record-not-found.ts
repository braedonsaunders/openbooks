import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";

/**
 * Uniform response for a record that is absent, belongs to another
 * organization, or is outside the caller's subsidiary scope. Keep the body
 * independent of which case occurred so callers cannot probe hidden rows.
 */
export function recordNotFoundResponse(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/** Hide HRM subjects uniformly while retaining named 403s for missing grants. */
export function hrmAuthorizationResponse(error: HrmAuthorizationError): NextResponse {
  if (/not visible in this organization/i.test(error.message)) return recordNotFoundResponse();
  return NextResponse.json({ error: error.message }, { status: 403 });
}
