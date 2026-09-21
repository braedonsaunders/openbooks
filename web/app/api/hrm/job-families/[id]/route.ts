import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { updateJobFamily } from "@openbooks/engine/src/hrm/compensation/architecture.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";
import { updateFamilyBody } from "../../compensation/bodies";

export const runtime = "nodejs";

/**
 * One job family: PATCH renames, retires or revives it through the
 * manage gate. Families with levels are never deleted (RESTRICT) —
 * retire them instead. The client checks res.ok before parsing.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid job family" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, updateFamilyBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const family = await updateJobFamily({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      familyId: id,
      name: body.name ?? null,
      description: body.description ?? null,
      isActive: body.isActive ?? null,
      reason: body.reason,
    });
    return NextResponse.json({ family });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
