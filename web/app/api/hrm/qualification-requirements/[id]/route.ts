import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { removeRequirement } from "@openbooks/engine/src/hrm/qualifications/requirements.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { qualificationErrorResponse } from "../../qualifications/_lib";

export const runtime = "nodejs";

/** Remove a dispatch requirement (zero matched rows refuse). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.certifications.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    await removeRequirement(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requirementId: (await params).id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
