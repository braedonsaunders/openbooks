import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  disconnectChannel,
  getChannel,
  pauseChannel,
  resumeChannel,
  retryChannel,
} from "@openbooks/engine/src/commerce/channels.ts";
import { channelAdapter } from "@openbooks/engine/src/commerce/adapters.ts";
import { ensureShopifyAdapterRegistered } from "@openbooks/engine/src/commerce/shopify/adapter.ts";
import { disconnectShopify } from "@openbooks/engine/src/commerce/shopify/connect.ts";
import { CommerceError } from "@openbooks/engine/src/commerce/errors.ts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const lifecycleBodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("pause"), reason: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal("resume"), reason: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal("disconnect"), reason: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal("retry"), reason: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal("test") }),
]);

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: lifecycleBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      if (body.action === "test") {
        ensureShopifyAdapterRegistered();
        const adapter = channelAdapter("shopify");
        return NextResponse.json(await adapter.testConnection({ orgId: gate.user.orgId, actorId: gate.user.id }, id));
      }
      if (body.action === "disconnect" && (await getChannel(gate.user.orgId, id)).kind === "shopify") {
        // A Shopify disconnect also removes the storefront subscriptions;
        // anything left behind warns instead of blocking the disconnect.
        const result = await disconnectShopify(gate.user.orgId, gate.user.id, id, body.reason);
        return NextResponse.json({ ...result, channel: await getChannel(gate.user.orgId, id) });
      }
      const channel =
        body.action === "pause"
          ? await pauseChannel(gate.user.orgId, gate.user.id, id, body.reason)
          : body.action === "resume"
            ? await resumeChannel(gate.user.orgId, gate.user.id, id, body.reason)
            : body.action === "disconnect"
              ? await disconnectChannel(gate.user.orgId, gate.user.id, id, body.reason)
              : await retryChannel(gate.user.orgId, gate.user.id, id, body.reason);
      return NextResponse.json({ channel });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
