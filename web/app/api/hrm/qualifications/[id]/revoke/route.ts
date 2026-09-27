import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { revokeQualification } from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { qualificationErrorResponse } from "../../_lib";
import { revokeQualificationBody } from "../../bodies";
/** Revoke with a reason: the row freezes, only a new record replaces it. */
export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  body: revokeQualificationBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params, body }) => {
    try {
      const { id } = params;
      const qualification = await withOrgTransaction(
        gate.user.orgId,
        async () =>
          revokeQualification(db, {
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
