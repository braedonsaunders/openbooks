import { NextResponse } from "next/server";
import { getCandidateDetail } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/**
 * One candidate: GET resolves the drawer (applications, interviews) with
 * contact PII redacted unless the viewer holds hrm.recruiting.read — the
 * hiring manager reaches their own funnel's candidates here.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid candidate" }, { status: 400 });
  try {
    const candidate = await getCandidateDetail({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      candidateId: id,
    });
    return NextResponse.json({ candidate });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
