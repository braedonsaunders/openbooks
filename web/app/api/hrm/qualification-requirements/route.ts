import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  listRequirements,
  setRequirement,
} from "@openbooks/engine/src/hrm/qualifications/requirements.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { qualificationErrorResponse } from "../qualifications/_lib";
import { setRequirementBody } from "../qualifications/bodies";

export const runtime = "nodejs";

/** Dispatch requirements: what a subject demands. */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.certifications.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const params = new URL(req.url).searchParams;
  const subjectKindRaw = params.get("subjectKind");
  const subjectKind =
    subjectKindRaw === null
      ? undefined
      : ["project", "equipment", "position", "classification"].includes(subjectKindRaw)
        ? (subjectKindRaw as "project" | "equipment" | "position" | "classification")
        : null;
  if (subjectKind === null) {
    return NextResponse.json({ error: "subjectKind must be one of project, equipment, position, classification" }, { status: 400 });
  }
  try {
    const requirements = await listRequirements(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      subjectKind,
      subjectId: params.get("subjectId") ?? undefined,
    });
    return NextResponse.json({ requirements });
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
  const parsedBody = await parseJsonBody(req, setRequirementBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const requirement = await setRequirement(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ requirement }, { status: 201 });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
