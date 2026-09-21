import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { checkAssignment } from "@openbooks/engine/src/hrm/qualifications/gating.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { qualificationErrorResponse } from "../_lib";
import { checkAssignmentBody } from "../bodies";

export const runtime = "nodejs";

/** The gate as a read: verdict for one employment against one subject. */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.certifications.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, checkAssignmentBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const verdict = await checkAssignment(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ verdict });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
