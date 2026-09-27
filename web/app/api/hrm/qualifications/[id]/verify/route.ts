import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { verifyQualification } from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { qualificationErrorResponse } from "../../_lib";
import { verifyQualificationBody } from "../../bodies";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

/** Verification stays HR's: pending_verification becomes valid. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.certifications.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return notFound("record");
  }
  const parsedBody = await parseJsonBody(req, verifyQualificationBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const { id } = await params;
    const qualification = await withOrgTransaction(gate.user.orgId, async () =>
      verifyQualification(db, {
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
