import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/database";
import {
  createWebhookEndpoint,
  redeliverWebhookDelivery,
  rotateWebhookEndpointSecret,
  sendWebhookTestPing,
  setWebhookEndpointStatus,
  updateWebhookEndpoint,
  WebhookEndpointError,
  FANOUT_EVENT_TYPES,
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
  id: z.string().uuid(),
  op: z.enum(["update", "disable", "enable", "rotate", "redeliver", "ping"]).optional(),
  url: z.string().trim().min(1).max(2000).optional(),
  description: z.string().max(500).nullable().optional(),
  events: z.array(z.string()).optional(),
  reason: z.string().max(500).optional(),
  deliveryId: z.string().uuid().optional(),
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
  handler: async ({ authz, request }) => {
    const endpointId = new URL(request.url).searchParams.get("endpoint") ?? "";
    if (!endpointId) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
    const endpoint = (await db.execute<Record<string, unknown>>(sql`
      select id, key, url, description, events, status, consecutive_failures as "consecutiveFailures",
             auto_disable_after as "autoDisableAfter", disabled_at as "disabledAt",
             disabled_reason as "disabledReason", secret_rotated_at as "secretRotatedAt",
             last_delivery_at as "lastDeliveryAt", last_delivery_status as "lastDeliveryStatus",
             last_error as "lastError", created_at as "createdAt", updated_at as "updatedAt"
        from webhook_endpoints
       where org_id = ${authz.user.orgId} and id = ${endpointId}::uuid limit 1
    `)).rows[0];
    if (!endpoint) return NextResponse.json({ error: "the webhook endpoint is gone — reload the list and try again" }, { status: 404 });
    const deliveries = (await db.execute<Record<string, unknown>>(sql`
      select d.id, d.status, d.attempt_count as "attemptCount",
             d.next_attempt_at as "nextAttemptAt", d.first_attempt_at as "firstAttemptAt",
             d.last_attempt_at as "lastAttemptAt", d.last_response_code as "lastResponseCode",
             d.last_response_excerpt as "lastResponseExcerpt", d.last_latency_ms as "lastLatencyMs",
             d.last_error as "lastError", d.delivered_at as "deliveredAt",
             d.created_at as "createdAt", e.event_type as "eventType",
             e.occurred_at as "occurredAt"
        from webhook_deliveries d join webhook_events e on e.id = d.event_id and e.org_id = d.org_id
       where d.org_id = ${authz.user.orgId} and d.endpoint_id = ${endpointId}::uuid
       order by d.created_at desc limit 50
    `)).rows;
    return NextResponse.json({ endpoint, deliveries });
  },
});

export const POST = defineRoute({
  permission: "webhooks.manage",
  feature: "outboundWebhooks",
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
        await setWebhookEndpointStatus(orgId, actorId, body.id, op === "enable" ? "active" : "disabled", body.reason);
        return NextResponse.json({ ok: true });
      }
      if (op === "rotate") {
        const rotated = await rotateWebhookEndpointSecret(orgId, actorId, body.id);
        return NextResponse.json({ secret: rotated.secret });
      }
      if (op === "redeliver") {
        if (!body.deliveryId) return NextResponse.json({ error: "deliveryId is required to redeliver" }, { status: 400 });
        const result = await redeliverWebhookDelivery(orgId, actorId, body.deliveryId);
        return NextResponse.json(result);
      }
      const pinged = await sendWebhookTestPing(orgId, actorId, body.id);
      return NextResponse.json(pinged);
    } catch (error) {
      return endpointErrorResponse(error);
    }
  },
});
