import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError, pushItemToShopify } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { guardChannelScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

/** Push an item's price/title to its Shopify variant (off unless enabled). */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: z.strictObject({
    itemId: z.string().uuid(),
    fields: z.array(z.enum(["price", "title"])).optional(),
  }),
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      return NextResponse.json(
        await pushItemToShopify(gate.user.orgId, gate.user.id, id, body.itemId, { fields: body.fields }),
      );
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
