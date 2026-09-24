import { guardCloseScope } from "@/lib/close-scope";
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { CloseError } from "@openbooks/engine/src/close/period-policy.ts";
import { updateCloseTask } from "@openbooks/engine/src/close/tasks.ts";
import { guardFeaturePermission } from "../../../../../../../lib/feature-gates";
import { isUuid } from "../../../../../../../lib/list-params";

export const runtime = "nodejs";

const ACTIONS = new Set([
  "start",
  "submit",
  "complete",
  "approve",
  "request_changes",
  "waive",
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  if (!isUuid(id) || !isUuid(taskId))
    return NextResponse.json(
      { error: "invalid run or task id" },
      { status: 400 },
    );
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    action?: string;
    notes?: string;
  };
  if (!body.action || !ACTIONS.has(body.action))
    return NextResponse.json({ error: "invalid task action" }, { status: 400 });
  const permission = ["approve", "request_changes", "waive"].includes(
    body.action,
  )
    ? "close.approve"
    : "close.run";
  const gate = await guardFeaturePermission(permission, "continuousClose");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardCloseScope(gate);
  if (scopeDenied) return scopeDenied;
  try {
    await updateCloseTask({
      orgId: gate.user.orgId,
      runId: id,
      taskId,
      actorId: gate.user.id,
      action: body.action as Parameters<typeof updateCloseTask>[0]["action"],
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CloseError)
      return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
