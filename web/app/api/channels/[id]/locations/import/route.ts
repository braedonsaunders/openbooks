import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError, importShopifyLocations } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { guardChannelScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

/** Import storefront locations: idempotent, never moves the operator's mappings. */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: z.strictObject({}),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      return NextResponse.json(await importShopifyLocations(gate.user.orgId, gate.user.id, id));
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
