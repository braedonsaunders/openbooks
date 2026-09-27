import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { v1ListRecords } from "../../../../lib/api/v1-records";
import { readV1JsonObject, requireV1IdempotencyKey, withV1Request } from "../../../../lib/api/v1-request";
import { invalidInput } from "../../../../lib/application/errors";
import { createApplicationFieldTicket } from "../../../../lib/application/field-tickets";

const createFieldTicketBody = z.looseObject({
  projectId: z.string().trim().min(1, "projectId is required; list projects from GET /api/v1/projects"),
  date: z.string().optional(),
  period: z.string().optional(),
});

export const runtime = "nodejs";

/** GET /api/v1/field-tickets — list field-ticket documents. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return v1ListRecords(request, "field-tickets", "api/v1/field-tickets");
}

/**
 * POST /api/v1/field-tickets — draft a field ticket on a project.
 * Same writer as POST /api/field-tickets. Feature-off is a 404.
 */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/field-tickets", async (_auth, context) => {
    const parsed = createFieldTicketBody.safeParse(await readV1JsonObject(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue?.path[0] === "projectId"
        ? "projectId is required; list projects from GET /api/v1/projects"
        : `${issue?.path.join(".") || "request body"}: ${issue?.message || "invalid value"}`;
      throw invalidInput(message, {
        issues: parsed.error.issues.map((entry) => ({
          path: entry.path.map(String).join("."),
          message: entry.message,
        })),
      });
    }
    const body = parsed.data;
    const outcome = await createApplicationFieldTicket(context, {
      projectId: body.projectId,
      date: body.date,
      period: body.period,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
