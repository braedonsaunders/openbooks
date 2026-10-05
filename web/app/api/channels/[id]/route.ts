import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  catalogQueueCounts,
  CommerceError,
  getChannel,
  SHOPIFY_WEBHOOK_TOPICS,
  updateChannel,
} from "@openbooks/engine/commerce";
import { can } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const updateBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    subsidiaryId: z.string().uuid().nullish(),
    currency: z.string().trim().min(3).max(3).optional(),
    secrets: z.record(z.string(), z.unknown()).nullish(),
    webhookSecret: z.string().trim().min(1).nullish(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "provide at least one channel field to update");

async function loadOr404(orgId: string, id: string) {
  try {
    return await getChannel(orgId, id);
  } catch (error) {
    // Another org's channel and a missing id answer alike, so ids cannot be probed.
    if (error instanceof CommerceError && error.code === "channel_not_found") return null;
    throw error;
  }
}

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const channel = await loadOr404(gate.user.orgId, id);
    if (!channel) return notFound("channel");
    // The workspace header also wants match counts, webhook topics and the
    // manage grant; all three stay read-scoped to this channel.
    const counts = channel.kind === "shopify" ? await catalogQueueCounts(gate.user.orgId, id) : null;
    const topics = channel.kind === "shopify" ? [...SHOPIFY_WEBHOOK_TOPICS] : [];
    return NextResponse.json({ channel, counts, topics, canManage: can(gate, "channels.manage") });
  },
});

export const PATCH = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: updateBodySchema,
  opaque: {
    secrets: "connector credentials are sealed on write; their shape is the connector's, not the route's",
    settings: "validated against the adapter's describeSettings schema in the engine, never as route JSON",
  },
  handler: async ({ authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const before = await loadOr404(gate.user.orgId, id);
    if (!before) return notFound("channel");
    const channel = await updateChannel(gate.user.orgId, gate.user.id, id, {
      name: routeBody.name,
      subsidiaryId: routeBody.subsidiaryId,
      currency: routeBody.currency,
      secrets: routeBody.secrets ?? undefined,
      webhookSecret: routeBody.webhookSecret ?? undefined,
      settings: routeBody.settings,
    });
    return NextResponse.json({ channel });
  },
});
