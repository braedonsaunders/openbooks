import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { rediscoverForRequisition } from "@openbooks/engine/src/hrm/recruiting/pools.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { rediscoverBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Pool rediscovery: POST matches pool members to an open requisition by
 * declared tags — a read returning names + matched tags only (no PII, no
 * AI). 404s while hrm, hrmRecruiting, or hrmTalentPool is off.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmTalentPool"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, rediscoverBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const matches = await rediscoverForRequisition({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      poolId: id,
      requisitionId: body.requisitionId,
      requisitionTags: body.requisitionTags,
    });
    return NextResponse.json({ matches });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
