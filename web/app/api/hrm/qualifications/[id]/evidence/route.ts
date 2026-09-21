import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { attachEvidence } from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { qualificationErrorResponse } from "../../_lib";
import { attachEvidenceBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Attach evidence uploaded through the File Cabinet upload route: the
 * client uploads the file first, then names it here. Verification stays
 * HR's — attaching never verifies.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // HR readers attach anywhere they manage; the holder attaches to their
  // own pending rows (the service enforces both) — so either grant opens
  // the route and the service decides.
  const hrGate = await guardPermission("hrm.certifications.read");
  const gate = hrGate instanceof NextResponse ? await guardPermission("hrm.self.read") : hrGate;
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, attachEvidenceBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const { id } = await params;
    const qualification = await attachEvidence(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      qualificationId: id,
      ...parsedBody.data,
    });
    return NextResponse.json({ qualification });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
