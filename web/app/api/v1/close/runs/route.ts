import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { listCloseRuns, startApplicationCloseRun } from "../../../../../lib/application/close";

const startApplicationCloseRunBody = z.looseObject({
  periodId: z.string().min(1),
  bookId: z.string().min(1),
  blueprintId: z.string().optional(),
  reportingPackageId: z.string().optional(),
  targetCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  subsidiaryIds: z.array(z.string().min(1)).optional(),
});

export const runtime = "nodejs";

/** GET /api/v1/close/runs */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/runs", async (_auth, context) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const runs = await listCloseRuns(context, { status, limit });
    return { status: 200, body: { runs } };
  });
}

/** POST /api/v1/close/runs */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/runs", async (_auth, context) => {
    const body = startApplicationCloseRunBody.parse(await readV1JsonObject(request));
    const outcome = await startApplicationCloseRun(context, {
      periodId: body.periodId,
      bookId: body.bookId,
      blueprintId: body.blueprintId,
      reportingPackageId: body.reportingPackageId,
      targetCloseDate: body.targetCloseDate,
      subsidiaryIds: body.subsidiaryIds,
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
