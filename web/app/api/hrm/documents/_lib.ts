import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import {
  HrmDocumentsError,
  HrmOrgChartError,
  HrmSurveysError,
} from "@openbooks/engine/src/hrm/documents/errors.ts";

/**
 * Shared error mapping for /api/hrm/document-templates, /api/hrm/documents,
 * /api/hrm/retention-*, /api/hrm/data-subject-exports, /api/hrm/surveys,
 * /api/hrm/org-chart and the public /api/documents/sign + /api/surveys/respond
 * routes. Engine refusals reach the caller with their message intact (the
 * remedy lives in the message) and a status that names the failure shape —
 * never a success, never a bare 'internal error' for a computed refusal.
 * Error bodies are checked before they are parsed: clients must branch on
 * `res.ok` first (the refusal message lives in the error body).
 */
export function hrmDocumentsErrorResponse(e: unknown): NextResponse {
  if (
    e instanceof HrmDocumentsError ||
    e instanceof HrmSurveysError ||
    e instanceof HrmOrgChartError
  ) {
    const status =
      e.code === "VALIDATION"
        ? 400
        : e.code === "NOT_FOUND"
          ? 404
          : e.code === "FORBIDDEN"
            ? 403
            : 422;
    return NextResponse.json({ error: e.message }, { status });
  }
  if (e instanceof HrmAuthorizationError) {
    // Unknown/other-org subjects report uniformly not-found so existence
    // cannot be probed across tenants; missing grants are forbidden.
    const status = /not visible in this organization/.test(e.message) ? 404 : 403;
    return NextResponse.json({ error: e.message }, { status });
  }
  console.error("[hrm] documents endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
