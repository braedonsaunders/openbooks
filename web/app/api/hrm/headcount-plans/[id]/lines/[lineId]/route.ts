import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { approvePlanLine } from "@openbooks/engine/src/hrm/compensation/headcount-plans.ts";
import { isUuid } from "../../../../../../../lib/list-params";
import { compensationErrorResponse } from "../../../../compensation/_lib";
/**
 * One plan line: POST {action: approve} approves it — create/backfill
 * lines open a requisition through the recruiting service (a hire
 * against it marks the line filled). The client checks res.ok before
 * parsing.
 */
export const POST = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  body: z.object({
    action: z.literal("approve"),
    reason: z.string().trim().max(2000).nullable().optional(),
  }),
  params: z.object({ id: z.string(), lineId: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    // The folder segment is [id]; naming the local planId is fine, reading
    // a params key by that name is not -- Next generates the context type
    // from the path.
    const { id: planId, lineId } = params;
    if (!isUuid(planId) || !isUuid(lineId))
      return NextResponse.json({ error: "invalid plan line" }, { status: 400 });
    try {
      const line = await approvePlanLine({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        lineId,
        reason: body.reason ?? null,
      });
      return NextResponse.json({ line });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
