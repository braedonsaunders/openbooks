import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmPerformanceError } from "@openbooks/engine/src/hrm/performance/errors.ts";

/**
 * Shared error mapping for /api/hrm/review-cycles/*, /api/hrm/reviews/*,
 * /api/hrm/goals/*, /api/hrm/exit-records/* and /api/hrm/retention.
 * Engine refusals reach the caller with their message intact (the remedy
 * lives in the message) and a status that names the failure shape — never
 * a success, never a bare 'internal error' for a computed refusal.
 */
export function performanceErrorResponse(e: unknown): NextResponse {
  if (e instanceof HrmPerformanceError) {
    const status =
      e.code === "INVALID_INPUT"
        ? 400
        : e.code === "NOT_FOUND" || e.code === "TEMPLATE_NOT_FOUND"
          ? 404
          : e.code === "FORBIDDEN"
            ? 403
            : e.code === "BAD_STATE" || e.code === "DUPLICATE" || e.code === "STALE_REVISION"
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
  console.error("[hrm] performance endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
