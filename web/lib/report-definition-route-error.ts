import { NextResponse } from "next/server";
import { ApplicationError } from "./application/errors";

/** Keep the report builder's established HTTP error payload while commands use typed refusals. */
export function reportDefinitionRouteError(
  error: unknown,
  options: { idempotencyConflict?: boolean } = {},
): NextResponse {
  if (!(error instanceof ApplicationError)) {
    throw error;
  }

  const detailError = error.details?.error;
  if (typeof detailError === "string") {
    return NextResponse.json(error.details, { status: error.status });
  }

  let message = error.message;
  if (error.code === "not_found") message = "not_found";
  if (error.code === "forbidden") message = "report access denied";
  if (error.code === "conflict" && options.idempotencyConflict) {
    message = "invalid_idempotency_key";
  } else if (error.code === "conflict") {
    message = message.charAt(0).toLowerCase() + message.slice(1);
  }
  if (error.code === "invalid_input" && message.startsWith("Built-in reports cannot be deleted")) {
    message = "Built-in reports cannot be deleted — clone it instead.";
  }
  return NextResponse.json({ error: message }, { status: error.status });
}
