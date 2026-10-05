import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CommerceError,
  listChannelLocations,
  unlinkChannelLocation,
  upsertChannelLocation,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const locationsBodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("upsert"),
    externalLocationId: z.string().trim().min(1).max(120),
    externalName: z.string().trim().min(1).max(200),
    stockLocationId: z.string().uuid().nullish(),
    syncInventory: z.boolean().optional(),
    fulfilsOrders: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("unlink"),
    externalLocationId: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1),
  }),
]);

function notFoundWhenMissing(error: unknown) {
  if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
  throw error;
}

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      const locations = await listChannelLocations(gate.user.orgId, id);
      return NextResponse.json({ locations });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: locationsBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      if (body.action === "unlink") {
        await unlinkChannelLocation(gate.user.orgId, gate.user.id, id, body.externalLocationId, body.reason);
        return NextResponse.json({ unlinked: true });
      }
      const location = await upsertChannelLocation(gate.user.orgId, gate.user.id, {
        channelId: id,
        externalLocationId: body.externalLocationId,
        externalName: body.externalName,
        stockLocationId: body.stockLocationId ?? null,
        syncInventory: body.syncInventory,
        fulfilsOrders: body.fulfilsOrders,
      });
      return NextResponse.json({ location });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});
