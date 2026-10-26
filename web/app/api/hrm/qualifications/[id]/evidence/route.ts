import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { attachEvidence } from "@openbooks/engine/hrm/qualifications/qualifications";
import { guardPermission } from "@/lib/authz";
import { qualificationErrorResponse } from "../../_lib";
import { attachEvidenceBody } from "../../bodies";
/**
 * Attach evidence uploaded through the File Cabinet upload route: the
 * client uploads the file first, then names it here. Verification stays
 * HR's — attaching never verifies.
 */
export const POST = defineRoute({
  authorize: async () => {
    const hrGate = await guardPermission("hrm.certifications.read");
    return hrGate instanceof NextResponse ? await guardPermission("hrm.self.read") : hrGate;
  },
  feature: "hrmCertifications",
  params: z.object({ id: z.string() }),
  body: attachEvidenceBody,
  handler: async ({ params, body, authz: gate }) => {
    // HR readers attach anywhere they manage; the holder attaches to their
    // own pending rows (the service enforces both) — so either grant opens
    // the route and the service decides.
    try {
      const { id } = params;
      const qualification = await attachEvidence(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        qualificationId: id,
        ...body,
      });
      return NextResponse.json({ qualification });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
