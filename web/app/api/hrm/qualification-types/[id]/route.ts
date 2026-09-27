import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { updateQualificationType } from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { qualificationErrorResponse } from "../../qualifications/_lib";
import { updateQualificationTypeBody } from "../../qualifications/bodies";
/** Retire or correct a qualification type (code is immutable). */
export const PATCH = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  scope: "unrestricted",
  body: updateQualificationTypeBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params, body }) => {
    try {
      const type = await updateQualificationType(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        typeId: params.id,
        ...body,
      });
      return NextResponse.json({ type });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
