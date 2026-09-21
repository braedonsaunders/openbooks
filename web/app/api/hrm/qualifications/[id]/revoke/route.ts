import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { revokeQualification } from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { qualificationErrorResponse } from "../../_lib";
import { revokeQualificationBody } from "../../bodies";

export const runtime = "nodejs";

/** Revoke with a reason: the row freezes, only a new record replaces it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.certifications.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, revokeQualificationBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const { id } = await params;
    const qualification = await withOrgTransaction(gate.user.orgId, async () =>
      revokeQualification(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        qualificationId: id,
        ...parsedBody.data,
      }),
    );
    return NextResponse.json({ qualification });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
