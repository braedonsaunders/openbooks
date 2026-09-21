import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { approvePlanLine } from "@openbooks/engine/src/hrm/compensation/headcount-plans.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { isUuid } from "../../../../../../../lib/list-params";
import { compensationErrorResponse } from "../../../../compensation/_lib";

export const runtime = "nodejs";

/**
 * One plan line: POST {action: approve} approves it — create/backfill
 * lines open a requisition through the recruiting service (a hire
 * against it marks the line filled). The client checks res.ok before
 * parsing.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmHeadcountPlans"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // The folder segment is [id]; naming the local planId is fine, reading
  // a params key by that name is not -- Next generates the context type
  // from the path.
  const { id: planId, lineId } = await params;
  if (!isUuid(planId) || !isUuid(lineId)) return NextResponse.json({ error: "invalid plan line" }, { status: 400 });
  const parsedBody = await parseJsonBody(
    req,
    z.object({ action: z.literal("approve"), reason: z.string().trim().max(2000).nullable().optional() }),
  );
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const line = await approvePlanLine({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      lineId,
      reason: parsedBody.data.reason ?? null,
    });
    return NextResponse.json({ line });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
