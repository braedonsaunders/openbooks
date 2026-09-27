import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { verifyQualification } from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { qualificationErrorResponse } from "../../_lib";
import { verifyQualificationBody } from "../../bodies";
/** Verification stays HR's: pending_verification becomes valid. */
export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  body: verifyQualificationBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    try {
      const { id } = params;
      const qualification = await withOrgTransaction(
        gate.user.orgId,
        async () =>
          verifyQualification(db, {
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            qualificationId: id,
            ...body,
          }),
      );
      return NextResponse.json({ qualification });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
