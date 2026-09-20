import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  linkDependent,
  unlinkDependent,
} from "@openbooks/engine/src/hrm/benefits/dependents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../../benefits/_lib";
import { linkDependentBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Cover or uncover a dependent on one election. The engine proves both
 * rows belong to the same employment — a cross-employment link is refused.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "enrollment id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, linkDependentBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "link") {
      await linkDependent({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        enrollmentId: id,
        dependentId: body.dependentId,
      });
    } else {
      await unlinkDependent({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        enrollmentId: id,
        dependentId: body.dependentId,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
