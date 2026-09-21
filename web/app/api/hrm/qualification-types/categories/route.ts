import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { declareCategory } from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { qualificationErrorResponse } from "../../qualifications/_lib";
import { declareCategoryBody } from "../../qualifications/bodies";

export const runtime = "nodejs";

/** Extend the org's category vocabulary through Setup. */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.certifications.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, declareCategoryBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const settings = await declareCategory(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ settings }, { status: 201 });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
