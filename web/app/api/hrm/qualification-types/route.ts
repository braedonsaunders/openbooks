import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  createQualificationType,
  listQualificationTypes,
} from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { qualificationErrorResponse } from "../qualifications/_lib";
import { createQualificationTypeBody } from "../qualifications/bodies";

export const runtime = "nodejs";

/** Qualification types: the org-declared taxonomy (Setup mirrors this). */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.certifications.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  try {
    const types = await listQualificationTypes(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      includeInactive,
    });
    return NextResponse.json({ types });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.certifications.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createQualificationTypeBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const type = await createQualificationType(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ type }, { status: 201 });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
