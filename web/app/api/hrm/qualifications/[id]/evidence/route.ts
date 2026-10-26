import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { attachEvidence } from "@openbooks/engine/hrm/qualifications/qualifications";
import { getAuthz, guardPermission } from "@/lib/authz";
import { isFeatureEnabled } from "@/lib/features";
import { qualificationErrorResponse } from "../../_lib";
import { attachEvidenceBody } from "../../bodies";

/**
 * Attach evidence uploaded through the File Cabinet upload route: the
 * client uploads the file first, then names it here. Verification stays
 * HR's — attaching never verifies. HR readers attach anywhere they
 * manage; the holder attaches to their own pending rows (the service
 * enforces both) — so either grant opens the route and the service
 * decides. The certifications switch is checked before either grant so a
 * disabled module stays a 404 rather than a permission refusal.
 */
async function authorizeEvidenceAttachment() {
  const session = await getAuthz();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await isFeatureEnabled(session.user.orgId, "hrmCertifications"))) {
    return notFound("record");
  }
  const hrGate = await guardPermission("hrm.certifications.read");
  if (!(hrGate instanceof NextResponse)) return hrGate;
  return guardPermission("hrm.self.read");
}

export const POST = defineRoute({
  authorize: () => authorizeEvidenceAttachment(),
  feature: "hrmCertifications",
  params: z.object({ id: z.string() }),
  body: attachEvidenceBody,
  handler: async ({ authz: gate, params, body }) => {
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
