import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { postChannelOrder } from "@openbooks/engine/commerce";
import { CommerceError } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

/**
 * Replay one channel order through the normal posting path: a fixed
 * exception posts (or rejoins its summary batch), a still-blocked order
 * parks again with the reason and remedy. Idempotent — a replay never
 * double-posts.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("order");
    try {
      const outcome = await postChannelOrder(gate.user.orgId, gate.user.id, id, { forcePerOrder: true });
      return NextResponse.json({ status: outcome.status, documentId: outcome.documentId });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_order_unknown") {
        return notFound("order");
      }
      throw error;
    }
  },
});
