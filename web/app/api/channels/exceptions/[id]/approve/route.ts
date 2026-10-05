import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError, approveExceptionSuggestion } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { guardChannelOrderScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

/**
 * Apply the approved fix as an effective-dated mapping and replay the
 * affected orders. The body names a candidate rank, never a target: the
 * engine recomputes the proposal and refuses a rank it did not offer.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: z.strictObject({ rank: z.number().int().min(0).max(20), applyToSimilar: z.boolean() }),
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const outOfScope = await guardChannelOrderScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      return NextResponse.json(
        await approveExceptionSuggestion(gate.user.orgId, gate.user.id, id, {
          rank: body.rank,
          applyToSimilar: body.applyToSimilar,
        }),
      );
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_order_unknown") return notFound("record");
      throw error;
    }
  },
});
