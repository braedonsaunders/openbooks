import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { isUuid } from "@/lib/list-params";
import {
  createWebhookEndpoint,
  redeliverWebhookDelivery,
  rotateWebhookEndpointSecret,
  sendWebhookTestPing,
  setWebhookEndpointStatus,
  updateWebhookEndpoint,
  WebhookEndpointError,
  FANOUT_EVENT_TYPES,
  readWebhookEndpointActivity,
} from "@openbooks/engine/webhooks";

export const runtime = "nodejs";

/**
 * Subscriber webhook endpoints (Settings → Developers → Webhooks).
 * Reads need `webhooks.read`; every mutation needs `webhooks.manage` and
 * the `outboundWebhooks` gate — enforced both by the route and inside the
 * engine service. The signing secret is returned once at creation and
 * rotation, and never stored in plaintext.
 */

const createBodySchema = z.object({
  key: z.string().trim().min(1).max(64),
  url: z.string().trim().min(1).max(2000),
  description: z.string().max(500).nullable().optional(),
  events: z.array(z.string()).refine((events) => events.every((e) => FANOUT_EVENT_TYPES.has(e)), {
    error: `events must be subscribable types: ${[...FANOUT_EVENT_TYPES].join(", ")}`,
  }),
});

const updateBodySchema = z.object({
  id: uuidString(),
  op: z.enum(["update", "disable", "enable", "rotate", "redeliver", "ping"]).optional(),
  url: z.string().trim().min(1).max(2000).optional(),
  description: z.string().max(500).nullable().optional(),
  events: z.array(z.string()).optional(),
  reason: z.string().max(500).optional(),
  deliveryId: uuidString().optional(),
});

function endpointErrorResponse(error: unknown) {
  if (error instanceof WebhookEndpointError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

export const GET = defineRoute({
  permission: "webhooks.read",
  feature: "outboundWebhooks",
  scope: "unrestricted",
  handler: async ({ authz, request }) => {
    const endpointId = new URL(request.url).searchParams.get("endpoint") ?? "";
    if (!endpointId) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
    if (!isUuid(endpointId))
      return NextResponse.json({ error: "endpoint must be a uuid" }, { status: 400 });
    const activity = await readWebhookEndpointActivity(authz.user.orgId, endpointId);
    const endpoint = activity.endpoint;
    if (!endpoint)
      return NextResponse.json(
        { error: "the webhook endpoint is gone — reload the list and try again" },
        { status: 404 },
      );
    return NextResponse.json({ endpoint, deliveries: activity.deliveries });
  },
});

export const POST = defineRoute({
  permission: "webhooks.manage",
  feature: "outboundWebhooks",
  scope: "unrestricted",
  body: createBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body, authz }) => {
    try {
      const created = await createWebhookEndpoint(authz.user.orgId, authz.user.id, {
        key: body.key,
        url: body.url,
        description: body.description ?? "",
        events: body.events,
      });
      return NextResponse.json({ id: created.id, secret: created.secret }, { status: 201 });
    } catch (error) {
      return endpointErrorResponse(error);
    }
  },
});

export const PATCH = defineRoute({
  permission: "webhooks.manage",
  feature: "outboundWebhooks",
  scope: "unrestricted",
  body: updateBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body, authz }) => {
    const { orgId, id: actorId } = { orgId: authz.user.orgId, id: authz.user.id };
    try {
      const op = body.op ?? "update";
      if (op === "update") {
        await updateWebhookEndpoint(orgId, actorId, body.id, {
          url: body.url,
          description: body.description ?? undefined,
          events: body.events,
        });
        return NextResponse.json({ ok: true });
      }
      if (op === "disable" || op === "enable") {
        await setWebhookEndpointStatus(
          orgId,
          actorId,
          body.id,
          op === "enable" ? "active" : "disabled",
          body.reason,
        );
        return NextResponse.json({ ok: true });
      }
      if (op === "rotate") {
        const rotated = await rotateWebhookEndpointSecret(orgId, actorId, body.id);
        return NextResponse.json({ secret: rotated.secret });
      }
      if (op === "redeliver") {
        if (!body.deliveryId)
          return NextResponse.json(
            { error: "deliveryId is required to redeliver" },
            { status: 400 },
          );
        const result = await redeliverWebhookDelivery(orgId, actorId, body.id, body.deliveryId);
        return NextResponse.json(result);
      }
      const pinged = await sendWebhookTestPing(orgId, actorId, body.id);
      return NextResponse.json(pinged);
    } catch (error) {
      return endpointErrorResponse(error);
    }
  },
});
