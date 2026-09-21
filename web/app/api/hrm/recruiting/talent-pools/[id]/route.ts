import { NextResponse } from "next/server";
import { deleteTalentPool } from "@openbooks/engine/src/hrm/recruiting/pools.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { recruitingErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/**
 * One talent pool: DELETE removes the pool (memberships follow; candidates
 * are untouched — deleting a pool never deletes a person). 404s while hrm,
 * hrmRecruiting, or hrmTalentPool is off.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmTalentPool"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    await deleteTalentPool({ orgId: gate.user.orgId, actorId: gate.user.id, poolId: id });
    return NextResponse.json({ deleted: id });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
