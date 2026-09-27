import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import {
  listRequirements,
  setRequirement,
} from "@openbooks/engine/src/hrm/qualifications/requirements.ts";
import { qualificationErrorResponse } from "../qualifications/_lib";
import { setRequirementBody } from "../qualifications/bodies";
/** Dispatch requirements: what a subject demands. */
export const GET = defineRoute({
  permission: "hrm.certifications.read",
  feature: "hrmCertifications",
  handler: async ({ request: req, authz: gate }) => {
    const params = new URL(req.url).searchParams;
    const subjectKindRaw = params.get("subjectKind");
    const subjectKind =
      subjectKindRaw === null
        ? undefined
        : ["project", "equipment", "position", "classification"].includes(
              subjectKindRaw,
            )
          ? (subjectKindRaw as
              "project" | "equipment" | "position" | "classification")
          : null;
    if (subjectKind === null) {
      return NextResponse.json(
        {
          error:
            "subjectKind must be one of project, equipment, position, classification",
        },
        { status: 400 },
      );
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
  },
});
export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  body: setRequirementBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const requirement = await withOrgTransaction(gate.user.orgId, () =>
        setRequirement(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          ...body,
        }),
      );
      return NextResponse.json({ requirement }, { status: 201 });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
