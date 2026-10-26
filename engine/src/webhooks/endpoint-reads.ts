import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export async function readWebhookEndpointActivity(
  orgId: string,
  endpointId: string,
): Promise<{ endpoint: Record<string, unknown> | null; deliveries: Record<string, unknown>[] }> {
  const endpoint =
    (
      await db.execute<Record<string, unknown>>(
        sql`
    select id, key, url, description, events, status, consecutive_failures as "consecutiveFailures",
           auto_disable_after as "autoDisableAfter", disabled_at as "disabledAt",
           disabled_reason as "disabledReason", secret_rotated_at as "secretRotatedAt",
           last_delivery_at as "lastDeliveryAt", last_delivery_status as "lastDeliveryStatus",
           last_error as "lastError", created_at as "createdAt", updated_at as "updatedAt"
      from webhook_endpoints
     where org_id = ${orgId} and id = ${endpointId}::uuid limit 1
  `,
        "objects",
      )
    )[0] ?? null;
  if (!endpoint) return { endpoint: null, deliveries: [] };

  const deliveries = await db.execute<Record<string, unknown>>(
    sql`
    select d.id, d.status, d.attempt_count as "attemptCount",
           d.next_attempt_at as "nextAttemptAt", d.first_attempt_at as "firstAttemptAt",
           d.last_attempt_at as "lastAttemptAt", d.last_response_code as "lastResponseCode",
           d.last_response_excerpt as "lastResponseExcerpt", d.last_latency_ms as "lastLatencyMs",
           d.last_error as "lastError", d.delivered_at as "deliveredAt",
           d.created_at as "createdAt", e.event_type as "eventType",
           e.occurred_at as "occurredAt"
      from webhook_deliveries d join webhook_events e on e.id = d.event_id and e.org_id = d.org_id
     where d.org_id = ${orgId} and d.endpoint_id = ${endpointId}::uuid
     order by d.created_at desc limit 50
  `,
    "objects",
  );
  return { endpoint, deliveries };
}
