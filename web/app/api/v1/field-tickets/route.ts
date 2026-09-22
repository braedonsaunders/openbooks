import { NextResponse } from "next/server";
import { v1ListRecords } from "../../../../lib/api/v1-records";
import { readV1JsonObject, requireV1IdempotencyKey, withV1Request } from "../../../../lib/api/v1-request";
import { invalidInput } from "../../../../lib/application/errors";
import { createApplicationFieldTicket } from "../../../../lib/application/field-tickets";

export const runtime = "nodejs";

/** GET /api/v1/field-tickets — list field-ticket documents. */
export async function GET(request: Request): Promise<NextResponse> {
  return v1ListRecords(request, "field-tickets", "api/v1/field-tickets");
}

/**
 * POST /api/v1/field-tickets — draft a field ticket on a project.
 * Same writer as POST /api/field-tickets. Feature-off is a 404.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/field-tickets", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    if (typeof body.projectId !== "string" || body.projectId.trim() === "") {
      throw invalidInput("projectId is required; list projects from GET /api/v1/projects");
    }
    const outcome = await createApplicationFieldTicket(context, {
      projectId: body.projectId,
      date: typeof body.date === "string" ? body.date : undefined,
      period: typeof body.period === "string" ? body.period : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}
