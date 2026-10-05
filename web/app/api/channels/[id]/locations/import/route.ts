import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError } from "@openbooks/engine/src/commerce/errors.ts";
import { importShopifyLocations } from "@openbooks/engine/src/commerce/shopify/locations.ts";
import { isUuid } from "@/lib/list-params";

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
    try {
      return NextResponse.json(await importShopifyLocations(gate.user.orgId, gate.user.id, id));
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
