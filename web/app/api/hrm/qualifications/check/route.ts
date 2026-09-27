import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { checkAssignment } from "@openbooks/engine/src/hrm/qualifications/gating.ts";
import { qualificationErrorResponse } from "../_lib";
import { checkAssignmentBody } from "../bodies";
/** The gate as a read: verdict for one employment against one subject. */
export const POST = defineRoute({
  permission: "hrm.certifications.read",
  feature: "hrmCertifications",
  body: checkAssignmentBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const verdict = await withOrgTransaction(gate.user.orgId, () =>
        checkAssignment(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          ...body,
        }),
      );
      return NextResponse.json({ verdict });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
