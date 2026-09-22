import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { listCloseRuns, startApplicationCloseRun } from "../../../../../lib/application/close";

export const runtime = "nodejs";

/** GET /api/v1/close/runs */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/runs", async (_auth, context) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const runs = await listCloseRuns(context, { status, limit });
    return { status: 200, body: { runs } };
  });
}

/** POST /api/v1/close/runs */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/runs", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const outcome = await startApplicationCloseRun(context, {
      periodId: String(body.periodId ?? ""),
      bookId: String(body.bookId ?? ""),
      blueprintId: typeof body.blueprintId === "string" ? body.blueprintId : undefined,
      reportingPackageId: typeof body.reportingPackageId === "string" ? body.reportingPackageId : undefined,
      targetCloseDate: typeof body.targetCloseDate === "string" ? body.targetCloseDate : undefined,
      subsidiaryIds: Array.isArray(body.subsidiaryIds)
        ? body.subsidiaryIds.filter((id): id is string => typeof id === "string")
        : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}
