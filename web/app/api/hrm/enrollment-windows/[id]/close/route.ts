import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { closeEnrollmentWindow } from "@openbooks/engine/src/hrm/benefits/windows.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../../benefits/_lib";
import { closeWindowBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Close an open window. The reason is required: it is recorded on every
 * pending election the closure refuses, so no election is silently dropped.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "window id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, closeWindowBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const window = await closeEnrollmentWindow({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      windowId: id,
      reason: parsedBody.data.reason,
    });
    return NextResponse.json({ window });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
