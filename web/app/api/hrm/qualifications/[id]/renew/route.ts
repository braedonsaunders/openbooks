import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { renewQualification } from "@openbooks/engine/hrm/qualifications/qualifications";
import { qualificationErrorResponse } from "../../_lib";
import { renewQualificationBody } from "../../bodies";
/** Renewal writes a NEW row linked to the old one — never an overwrite. */
export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  body: renewQualificationBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    try {
      const { id } = params;
      const qualification = await withOrgTransaction(gate.user.orgId, async () =>
        renewQualification(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          qualificationId: id,
          ...body,
        }),
      );
      return NextResponse.json({ qualification }, { status: 201 });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
