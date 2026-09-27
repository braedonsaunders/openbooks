import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { notFound } from "./responses.ts";

/** Hide HRM subjects uniformly while retaining named 403s for missing grants. */
export function hrmAuthorizationResponse(error: HrmAuthorizationError): NextResponse {
  if (/not visible in this organization/i.test(error.message)) return notFound("HRM subject");
  return NextResponse.json({ error: error.message }, { status: 403 });
}
