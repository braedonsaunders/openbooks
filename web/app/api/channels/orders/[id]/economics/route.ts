import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { CommerceError, recomputeOrderEconomics } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

/**
 * Recompute one channel order's margin facts from every cost source.
 * Idempotent — a refresh never double-books, and late costs restate with
 * history instead of overwriting.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("order");
    try {
      const outcome = await recomputeOrderEconomics(gate.user.orgId, gate.user.id, id);
      return NextResponse.json({ inserted: outcome.inserted, retired: outcome.retired });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_order_unknown") {
        return notFound("order");
      }
      throw error;
    }
  },
});
