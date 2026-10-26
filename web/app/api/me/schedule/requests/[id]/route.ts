import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { respondToSwap, withdrawOwnShiftRequest } from "@openbooks/engine/schedule-boards/requests";
import { deliverScheduleNotices } from "@/lib/scheduling/notify";

/** Withdraw an own request, or accept or decline a swap a colleague offered. */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrmShiftPlanning",
  params: z.object({ id: uuidString() }),
  body: z.discriminatedUnion("action", [
    z.strictObject({
      action: z.literal("withdraw"),
      expectedRevision: z.number().int().positive(),
    }),
    z.strictObject({
      action: z.enum(["accept", "decline"]),
      expectedRevision: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2000),
    }),
  ]),
  handler: async ({ authz, params, body }) => {
    const actor = {
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      requestId: params.id,
      expectedRevision: body.expectedRevision,
    };
    if (body.action === "withdraw")
      return NextResponse.json({ request: await withdrawOwnShiftRequest(actor) });
    const result = await respondToSwap({
      ...actor,
      accept: body.action === "accept",
      reason: body.reason,
    });
    const delivery = await deliverScheduleNotices({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardName: result.boardName,
      notices: [...result.notices],
    });
    return NextResponse.json({
      request: result.request,
      delivery,
      distributionRefusals: result.distributionRefusals,
    });
  },
});
