import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { declareCategory } from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { qualificationErrorResponse } from "../../qualifications/_lib";
import { declareCategoryBody } from "../../qualifications/bodies";
/** Extend the org's category vocabulary through Setup. */
export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  scope: "unrestricted",
  body: declareCategoryBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const settings = await declareCategory(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...body,
      });
      return NextResponse.json({ settings }, { status: 201 });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
