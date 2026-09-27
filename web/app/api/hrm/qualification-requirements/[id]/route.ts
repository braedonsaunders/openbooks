import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { removeRequirement } from "@openbooks/engine/src/hrm/qualifications/requirements.ts";
import { qualificationErrorResponse } from "../../qualifications/_lib";
/** Remove a dispatch requirement (zero matched rows refuse). */
export const DELETE = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    try {
      const { id } = params;
      await withOrgTransaction(gate.user.orgId, () =>
        removeRequirement(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          requirementId: id,
        }),
      );
      return NextResponse.json({ ok: true });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
