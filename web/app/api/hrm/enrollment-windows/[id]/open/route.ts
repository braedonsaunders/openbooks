import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { openEnrollmentWindow } from "@openbooks/engine/src/hrm/benefits/windows.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../../benefits/_lib";
import { emptyBody } from "../../bodies";

export const runtime = "nodejs";

/** Open a draft window (overlap and inverted-range refusals name the remedy). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "window id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, emptyBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const window = await openEnrollmentWindow({ orgId: gate.user.orgId, actorId: gate.user.id, windowId: id });
    return NextResponse.json({ window });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
