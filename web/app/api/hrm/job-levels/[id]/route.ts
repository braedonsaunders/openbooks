import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { updateJobLevel } from "@openbooks/engine/src/hrm/compensation/architecture.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";
import { updateLevelBody } from "../../compensation/bodies";

export const runtime = "nodejs";

/**
 * One job level: PATCH renames, re-ranks, re-declares criteria, retires
 * or revives it through the manage gate. The ladder never moves — retire
 * and recreate on the right one. The client checks res.ok before parsing.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid job level" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, updateLevelBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const level = await updateJobLevel({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      levelId: id,
      name: body.name ?? null,
      rank: body.rank ?? null,
      equalValueCriteria: body.equalValueCriteria === undefined ? undefined : (body.equalValueCriteria ?? null),
      isActive: body.isActive ?? null,
      reason: body.reason,
    });
    return NextResponse.json({ level });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
