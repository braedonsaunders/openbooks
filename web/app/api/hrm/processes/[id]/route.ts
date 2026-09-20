import { NextResponse } from "next/server";
import { getProcess } from "@openbooks/engine/src/hrm/processes-read.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { processErrorResponse } from "../_lib";

export const runtime = "nodejs";

/** Single process checklist with its steps, owners, due dates, and evidence. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.process.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "process id must be a uuid" }, { status: 400 });
  try {
    const process = await getProcess({ orgId: gate.user.orgId, actorId: gate.user.id, processId: id });
    return NextResponse.json({ process });
  } catch (e) {
    return processErrorResponse(e);
  }
}
