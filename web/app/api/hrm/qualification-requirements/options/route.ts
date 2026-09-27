import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { listRequirementSubjectOptions } from "@openbooks/engine/src/hrm/qualifications/requirements.ts";
import { qualificationErrorResponse } from "../../qualifications/_lib";
const SUBJECT_KINDS = [
  "project",
  "equipment",
  "position",
  "classification",
] as const;
const PAGE_SIZE = 20;
/** Search bounded authoring options through the same subsidiary fence as requirement writes. */
export const GET = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  handler: async ({ request: req, authz: gate }) => {
    const params = new URL(req.url).searchParams;
    const subjectKind = params.get("subjectKind");
    if (
      !SUBJECT_KINDS.includes(subjectKind as (typeof SUBJECT_KINDS)[number])
    ) {
      return NextResponse.json(
        {
          error:
            "subjectKind must be one of project, equipment, position, classification",
        },
        { status: 400 },
      );
    }
    const query = (params.get("q") ?? "").trim();
    if (query.length < 2)
      return NextResponse.json({ options: [], hasMore: false });
    try {
      const rows = await listRequirementSubjectOptions(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        subjectKind: subjectKind as (typeof SUBJECT_KINDS)[number],
        query,
        limit: PAGE_SIZE + 1,
      });
      return NextResponse.json({
        options: rows.slice(0, PAGE_SIZE),
        hasMore: rows.length > PAGE_SIZE,
      });
    } catch (error) {
      return qualificationErrorResponse(error);
    }
  },
});
