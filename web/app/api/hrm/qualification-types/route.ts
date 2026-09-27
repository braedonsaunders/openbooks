import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  createQualificationType,
  listQualificationTypes,
} from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { qualificationErrorResponse } from "../qualifications/_lib";
import { createQualificationTypeBody } from "../qualifications/bodies";
/** Qualification types: the org-declared taxonomy (Setup mirrors this). */
export const GET = defineRoute({
  permission: "hrm.certifications.read",
  feature: "hrmCertifications",
  handler: async ({ request: req, authz: gate }) => {
    const includeInactive =
      new URL(req.url).searchParams.get("includeInactive") === "1";
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
  },
});
export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  scope: "unrestricted",
  body: createQualificationTypeBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const type = await createQualificationType(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...body,
      });
      return NextResponse.json({ type }, { status: 201 });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
