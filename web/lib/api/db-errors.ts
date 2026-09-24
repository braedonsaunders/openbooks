import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { pgErrorCode, pgErrorConstraint } from "../setup/coerce";

/**
 * Map a write-path storage failure to its HTTP response.
 *
 * A unique violation on a KNOWN constraint becomes a 409 with a stable,
 * operator-readable message. Anything else becomes a generic 500 carrying
 * only a correlation id: the Drizzle wrapper's message embeds the full SQL
 * text plus bound params, and even the raw driver text names internal
 * objects — neither may reach the client. The driver error is logged
 * server-side under the correlation id.
 *
 * Never match on message text: any driver message mentioning 'unique'
 * (including a wrapped query echoing the index name) is not a name conflict,
 * and echoing it leaks storage internals.
 */
export function dbWriteErrorResponse(
  error: unknown,
  opts: { route: string; uniqueConflicts: Record<string, string> },
): NextResponse {
  if (pgErrorCode(error) === "23505") {
    const message = opts.uniqueConflicts[pgErrorConstraint(error) ?? ""];
    if (message !== undefined) return NextResponse.json({ error: message }, { status: 409 });
  }
  const correlationId = randomUUID();
  console.error(`[${opts.route}] write failed (${correlationId}):`, error);
  return NextResponse.json({ error: "save failed", correlationId }, { status: 500 });
}
