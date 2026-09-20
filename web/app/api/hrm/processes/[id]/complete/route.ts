import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { completeProcess } from "@openbooks/engine/src/hrm/processes.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { processErrorResponse } from "../../_lib";
import { completeProcessBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Complete an open checklist. Refused while a required step is pending —
 * the refusal names the pending steps, and the client renders it intact.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.process.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "process id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, completeProcessBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    await completeProcess({ orgId: gate.user.orgId, actorId: gate.user.id, processId: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return processErrorResponse(e);
  }
}
