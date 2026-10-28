import { NextResponse } from "next/server";
import { apiErrorResponse } from "./api/error-response";
import { ApplicationError } from "./application/errors";

/** Preserve the schedule routes' established refusal payloads after service extraction. */
export function reportScheduleRouteError(
  error: unknown,
  request?: Request,
  rethrowUnknown = false,
): NextResponse {
  if (!(error instanceof ApplicationError)) {
    if (rethrowUnknown) throw error;
    return apiErrorResponse(error, { safeStatus: 422, request });
  }
  const message =
    error.code === "not_found"
      ? "not_found"
      : error.code === "forbidden" && error.message === "forbidden"
        ? "forbidden"
        : error.message;
  return NextResponse.json({ error: message }, { status: error.status });
}
