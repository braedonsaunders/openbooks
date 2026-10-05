import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError, rejectExceptionSuggestion } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

/**
 * Decline the proposed fix with a reason. The order stays parked and the
 * decision lands in the audit log with who said no and why.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: z.strictObject({ reason: z.string().trim().min(1).max(2000) }),
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    try {
      await rejectExceptionSuggestion(gate.user.orgId, gate.user.id, id, body.reason);
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_order_unknown") return notFound("record");
      throw error;
    }
  },
});
