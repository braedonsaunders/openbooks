import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { updateQualificationType } from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { qualificationErrorResponse } from "../../qualifications/_lib";
import { updateQualificationTypeBody } from "../../qualifications/bodies";

export const runtime = "nodejs";

/** Retire or correct a qualification type (code is immutable). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.certifications.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, updateQualificationTypeBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const type = await updateQualificationType(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      typeId: (await params).id,
      ...parsedBody.data,
    });
    return NextResponse.json({ type });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
