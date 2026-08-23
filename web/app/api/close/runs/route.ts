import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { startCloseRun, CloseError } from "@openbooks/engine/src/close.ts";
import { guardPermission } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await guardPermission("close.run");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
  const periodId = typeof body.periodId === "string" ? body.periodId : "";
  const bookId = typeof body.bookId === "string" ? body.bookId : "";
  if (!isUuid(periodId) || !isUuid(bookId)) {
    return NextResponse.json(
      { error: "valid periodId and bookId are required" },
      { status: 400 },
    );
  }
  const blueprintId =
    typeof body.blueprintId === "string" && isUuid(body.blueprintId)
      ? body.blueprintId
      : undefined;
  const reportingPackageId =
    typeof body.reportingPackageId === "string" &&
    isUuid(body.reportingPackageId)
      ? body.reportingPackageId
      : undefined;
  const subsidiaryIds = Array.isArray(body.subsidiaryIds)
    ? body.subsidiaryIds.filter(
        (id): id is string => typeof id === "string" && isUuid(id),
      )
    : undefined;
  try {
    const runId = await startCloseRun({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      periodId,
      bookId,
      blueprintId,
      reportingPackageId,
      targetCloseDate:
        typeof body.targetCloseDate === "string"
          ? body.targetCloseDate
          : undefined,
      subsidiaryIds,
    });
    return NextResponse.json({ ok: true, runId });
  } catch (error) {
    if (error instanceof CloseError)
      return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
