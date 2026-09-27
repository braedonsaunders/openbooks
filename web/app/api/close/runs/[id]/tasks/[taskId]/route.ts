import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { guardCloseScope } from "@/lib/close-scope";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { CloseError } from "@openbooks/engine/src/periods/period-policy.ts";
import { updateCloseTask } from "@openbooks/engine/src/close/tasks.ts";
import { guardFeaturePermission } from "../../../../../../../lib/feature-gates";
import { isUuid } from "../../../../../../../lib/list-params";

const requestBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), notes: z.string().max(2000).optional() }),
  z.object({ action: z.literal("submit"), notes: z.string().max(2000).optional() }),
  z.object({ action: z.literal("complete"), notes: z.string().max(2000).optional() }),
  z.object({ action: z.literal("approve"), notes: z.string().max(2000).optional() }),
  z.object({ action: z.literal("request_changes"), notes: z.string().max(2000).optional() }),
  z.object({ action: z.literal("waive"), notes: z.string().max(2000).optional() }),
]);


export const runtime = "nodejs";

const ACTIONS = new Set([
  "start",
  "submit",
  "complete",
  "approve",
  "request_changes",
  "waive",
]);

async function legacyPOST(
  req: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  if (!isUuid(id) || !isUuid(taskId))
    return NextResponse.json(
      { error: "invalid run or task id" },
      { status: 400 },
    );
  const parsedBody = await parseJsonBody(req, requestBodySchema);
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
      return apiErrorResponse(error, { safeStatus: 422 });
    throw error;
  }
}

export const POST = defineRoute({
  public: "session",
  params: z.object({ "id": z.string(), "taskId": z.string() }),
  body: requestBodySchema,
  handler: async ({ request, body, params }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPOST(replayRequest as never, { params: Promise.resolve(params as never) } as never);
  },
});
