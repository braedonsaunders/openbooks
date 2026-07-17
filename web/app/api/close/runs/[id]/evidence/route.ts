import { NextResponse } from "next/server";
import { addCloseEvidence, CloseError } from "@openbooks/engine/src/close.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

const EVIDENCE_TYPES = new Set([
  "file",
  "report",
  "journal",
  "reconciliation",
  "link",
  "note",
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const gate = await guardPermission("close.run");
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const evidenceType =
    typeof body.evidenceType === "string" ? body.evidenceType : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (
    !isUuid(id) ||
    !isUuid(taskId) ||
    !EVIDENCE_TYPES.has(evidenceType) ||
    !label
  ) {
    return NextResponse.json(
      { error: "valid task, evidence type, and label are required" },
      { status: 400 },
    );
  }
  try {
    const evidenceId = await addCloseEvidence({
      orgId: gate.user.orgId,
      runId: id,
      taskId,
      actorId: gate.user.id,
      evidenceType: evidenceType as Parameters<
        typeof addCloseEvidence
      >[0]["evidenceType"],
      label,
      fileId:
        typeof body.fileId === "string" && isUuid(body.fileId)
          ? body.fileId
          : undefined,
      referenceId:
        typeof body.referenceId === "string" && isUuid(body.referenceId)
          ? body.referenceId
          : undefined,
      referenceUrl:
        typeof body.referenceUrl === "string" ? body.referenceUrl : undefined,
      snapshot:
        body.snapshot &&
        typeof body.snapshot === "object" &&
        !Array.isArray(body.snapshot)
          ? (body.snapshot as Record<string, unknown>)
          : undefined,
    });
    return NextResponse.json({ ok: true, evidenceId });
  } catch (error) {
    if (error instanceof CloseError)
      return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
