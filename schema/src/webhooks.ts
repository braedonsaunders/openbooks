import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Outbound webhooks — signed delivery of domain events to subscriber
 * endpoints (migration 0493).
 *
 * `webhook_endpoints` holds one subscriber URL with its sealed signing
 * secret. Rotation keeps the previous sealed secret beside the current one
 * so in-flight deliveries verify during the roll; the plaintext secret is
 * shown once at creation or rotation and never stored. `events` is the
 * subscribed event-type list; an empty list receives nothing.
 *
 * `webhook_events` is the transactional outbox: the business transaction
 * writes its event row and the per-endpoint delivery rows together, so a
 * rollback delivers nothing. `dedupe_key` collapses re-entrant effect
 * replays onto one event.
 *
 * `webhook_deliveries` is the worker's queue: one row per event and
 * endpoint with attempt history, the next attempt time, and the response
 * evidence. The id is the `OpenBooks-Delivery` header value.
 */

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: id(),
    orgId: orgRef(),
    /** Stable slug recipes reference (`endpointKey` on the automation webhook action). Immutable after creation. */
    key: text("key").notNull(),
    url: text("url").notNull(),
    description: text("description").notNull().default(""),
    /** Subscribed event types. Empty receives nothing. */
    events: text("events").array().notNull().default(sql`'{}'`),
    status: text("status").notNull().default("active"),
    /** Current signing secret, sealed with purpose `webhook.endpoint.secret`. */
    secretSealed: text("secret_sealed").notNull(),
    /** Previous signing secret during a rotation overlap; deliveries carry both signatures. */
    secretPreviousSealed: text("secret_previous_sealed"),
    secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    autoDisableAfter: integer("auto_disable_after").notNull().default(25),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastDeliveryStatus: text("last_delivery_status"),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("webhook_endpoints_key").on(t.orgId, t.key),
    check("webhook_endpoints_status_valid", sql`${t.status} IN ('active', 'disabled')`),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    orgId: orgRef(),
    eventType: text("event_type").notNull(),
    entityKind: text("entity_kind"),
    entityId: uuid("entity_id"),
    /** Snapshot of the public representation at emit time; totals in minor units with currency. */
    payload: jsonb("payload").notNull().default(sql`'{}'`),
    /** Collapses re-entrant replays onto one event row. */
    dedupeKey: text("dedupe_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [uniqueIndex("webhook_events_dedupe").on(t.orgId, t.dedupeKey)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    orgId: orgRef(),
    eventId: uuid("event_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastResponseCode: integer("last_response_code"),
    /** Truncated response body excerpt for the operator. */
    lastResponseExcerpt: text("last_response_excerpt"),
    lastLatencyMs: integer("last_latency_ms"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_endpoint").on(t.orgId, t.eventId, t.endpointId),
    index("webhook_deliveries_due").on(t.status, t.nextAttemptAt),
    check("webhook_deliveries_status_valid", sql`${t.status} IN ('pending', 'delivered', 'failed', 'dead')`),
  ],
);
