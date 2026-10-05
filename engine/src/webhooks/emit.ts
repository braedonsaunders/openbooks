import { sql } from "drizzle-orm";
import { SUPPORTED_CURRENCIES } from "../fx/currencies.ts";
import { roundDiv, toUnits } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  FANOUT_EVENT_TYPES,
  isWebhookEventType,
  WEBHOOK_PAYLOAD_VERSION,
  type WebhookEventType,
} from "./catalog.ts";

/**
 * Domain-event emission — the transactional outbox half of outbound
 * webhooks. The caller writes the event row (and its delivery rows) through
 * the executor it already holds, so the rows commit with the business
 * change or roll back with it: an event emitted in a rolled-back
 * transaction is never delivered, because its rows never existed.
 *
 * Post-commit callers (posting effects) pass the ambient `db`; their
 * business change already committed. In-transaction callers pass their
 * runner and the emit joins that transaction.
 *
 * Emission is gated on the `outboundWebhooks` feature: while the gate is
 * off nothing is stored and the call returns null. Fan-out matches active
 * endpoints subscribed to the event type; point-to-point callers
 * (automation actions, test pings) use `enqueueTargetedDelivery` with an
 * explicit endpoint instead.
 *
 * Amounts convert from ledger-exact decimals to whole minor units with the
 * currency's registered exponent (half away from zero, the same rounding
 * the currency module uses). Posted documents carry validated ISO codes
 * (see posting-prepare's currency check), so an unknown code here is a
 * corrupt row and refuses by name rather than guessing a quantum.
 */

export class WebhookEmitError extends Error {}

const MINOR_UNITS_BY_CURRENCY = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c.minorUnits]));

export function minorUnitsOf(amountMajor: string, currency: string): string {
  const exponent = MINOR_UNITS_BY_CURRENCY.get(currency);
  if (exponent === undefined) {
    throw new WebhookEmitError(
      `currency '${currency}' has no registered minor-unit exponent — amounts cannot be snapshotted for webhooks; use a transactable ISO 4217 currency`,
    );
  }
  const quantum = 10n ** BigInt(4 - exponent);
  const units = toUnits(amountMajor);
  // roundDiv already returns the quotient: whole minor units, half away
  // from zero — never a second division.
  const rounded = roundDiv(units < 0n ? -units : units, quantum);
  return String(units < 0n ? -rounded : rounded);
}

export type EmitDomainEventInput = {
  orgId: string;
  type: WebhookEventType | string;
  entityKind?: string | null;
  entityId?: string | null;
  payload: Record<string, unknown>;
  /** Stable per effect: re-entrant replays collapse onto one event row. */
  dedupeKey: string;
  occurredAt?: Date;
};

export type EmitDomainEventResult = {
  eventId: string;
  deliveries: number;
} | null;

async function currentXactId(executor: SqlExecutor): Promise<string> {
  const rows = (await executor.execute<{ xact: string }>(sql`select pg_current_xact_id()::text as xact`)).rows;
  return rows[0]!.xact;
}

async function insertEventRow(
  executor: SqlExecutor,
  input: EmitDomainEventInput & { type: WebhookEventType },
): Promise<string> {
  if (!input.orgId.trim()) throw new WebhookEmitError("webhook emission requires an organization");
  if (!input.dedupeKey.trim()) throw new WebhookEmitError("webhook emission requires a dedupe key");
  const occurredAt = input.occurredAt ?? new Date();
  // The conflict is the expected benign replay (a retried posting effect
  // re-emits the same dedupe key): the existing row is re-read and
  // returned, so one business effect is one event.
  const inserted = (await executor.execute<{ id: string }>(sql`
    insert into webhook_events (org_id, event_type, entity_kind, entity_id, payload, dedupe_key, occurred_at)
    values (${input.orgId}, ${input.type}, ${input.entityKind ?? null},
            ${input.entityId ?? null}::uuid, ${JSON.stringify(input.payload)}::jsonb,
            ${input.dedupeKey}, ${occurredAt})
    on conflict (org_id, dedupe_key) do nothing
    returning id
  `)).rows[0]?.id;
  if (inserted) return inserted;
  const existing = (await executor.execute<{ id: string }>(sql`
    select id from webhook_events where org_id = ${input.orgId} and dedupe_key = ${input.dedupeKey} limit 1
  `)).rows[0]?.id;
  if (!existing) {
    throw new WebhookEmitError(
      `webhook event '${input.type}' was not stored and no replay row exists — retry the action`,
    );
  }
  return existing;
}

async function insertDeliveryRow(
  executor: SqlExecutor,
  orgId: string,
  eventId: string,
  endpointId: string,
): Promise<boolean> {
  // Same replay collapse as the event row: a re-fanned event never
  // double-queues a delivery for one endpoint.
  const inserted = await executor.execute(sql`
    insert into webhook_deliveries (org_id, event_id, endpoint_id, status, next_attempt_at)
    values (${orgId}, ${eventId}::uuid, ${endpointId}::uuid, 'pending', now())
    on conflict (org_id, event_id, endpoint_id) do nothing
  `);
  return (inserted.rowCount ?? 0) > 0;
}

/**
 * Emit one domain event and fan out deliveries to every active endpoint
 * subscribed to its type. Returns null while the feature is off.
 */
export async function emitDomainEvent(
  executor: SqlExecutor,
  input: EmitDomainEventInput,
): Promise<EmitDomainEventResult> {
  if (!isWebhookEventType(input.type)) {
    throw new WebhookEmitError(
      `unknown webhook event type '${input.type}' — use one of the catalogued domain events`,
    );
  }
  if (!(await orgFeatureEnabled(input.orgId, "outboundWebhooks", executor))) return null;
  const eventId = await insertEventRow(executor, { ...input, type: input.type });
  const endpoints = (await executor.execute<{ id: string }>(sql`
    select id from webhook_endpoints
     where org_id = ${input.orgId} and status = 'active' and events @> array[${input.type}]::text[]
  `)).rows;
  let deliveries = 0;
  for (const endpoint of endpoints) {
    if (await insertDeliveryRow(executor, input.orgId, eventId, endpoint.id)) deliveries += 1;
  }
  return { eventId, deliveries };
}

/**
 * Point-to-point delivery for an explicitly addressed endpoint — automation
 * actions and test pings name their recipient instead of fanning out to
 * subscribers. The caller verified the endpoint first.
 */
export async function enqueueTargetedDelivery(
  executor: SqlExecutor,
  input: EmitDomainEventInput & { endpointId: string },
): Promise<EmitDomainEventResult> {
  if (!isWebhookEventType(input.type)) {
    throw new WebhookEmitError(
      `unknown webhook event type '${input.type}' — use one of the catalogued domain events`,
    );
  }
  if (FANOUT_EVENT_TYPES.has(input.type)) {
    throw new WebhookEmitError(
      `event type '${input.type}' fans out to subscribers and cannot be sent point-to-point — subscribe the endpoint instead`,
    );
  }
  if (!(await orgFeatureEnabled(input.orgId, "outboundWebhooks", executor))) return null;
  const eventId = await insertEventRow(executor, { ...input, type: input.type });
  await insertDeliveryRow(executor, input.orgId, eventId, input.endpointId);
  return { eventId, deliveries: 1 };
}

type DocumentSnapshot = {
  id: string;
  kind: string;
  documentNumber: string;
  currency: string;
  total: string;
  documentDate: string | null;
  postingDate: string | null;
  partyId: string | null;
};

async function loadDocumentSnapshot(executor: SqlExecutor, orgId: string, documentId: string): Promise<DocumentSnapshot> {
  const row = (await executor.execute<DocumentSnapshot>(sql`
    select id, kind,
           document_number as "documentNumber", currency, total::text as total,
           document_date::text as "documentDate", posting_date::text as "postingDate",
           party_id as "partyId"
      from documents where org_id = ${orgId} and id = ${documentId}::uuid limit 1
  `)).rows[0];
  if (!row) {
    throw new WebhookEmitError("the posted document is gone — the record was deleted; nothing was emitted");
  }
  return row;
}

function eventEnvelope(): { v: 1; occurredAt: string } {
  return { v: WEBHOOK_PAYLOAD_VERSION, occurredAt: new Date().toISOString() };
}

/** Document post (and the posting-effect retry of it) — one event per document. */
export async function emitDocumentPosted(
  executor: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<EmitDomainEventResult> {
  const doc = await loadDocumentSnapshot(executor, orgId, documentId);
  return emitDomainEvent(executor, {
    orgId,
    type: "document.posted",
    entityKind: "document",
    entityId: documentId,
    dedupeKey: `document.posted:${documentId}`,
    payload: {
      ...eventEnvelope(),
      documentId,
      kind: doc.kind,
      documentNumber: doc.documentNumber,
      status: "posted",
      currency: doc.currency,
      totalMinor: minorUnitsOf(doc.total, doc.currency),
      documentDate: doc.documentDate,
      postingDate: doc.postingDate,
      partyId: doc.partyId,
    },
  });
}

/** Document void — one event per document. */
export async function emitDocumentVoided(
  executor: SqlExecutor,
  orgId: string,
  documentId: string,
  input: { reversalEntryId?: string | null; reason?: string | null } = {},
): Promise<EmitDomainEventResult> {
  const doc = await loadDocumentSnapshot(executor, orgId, documentId);
  return emitDomainEvent(executor, {
    orgId,
    type: "document.voided",
    entityKind: "document",
    entityId: documentId,
    dedupeKey: `document.voided:${documentId}`,
    payload: {
      ...eventEnvelope(),
      documentId,
      kind: doc.kind,
      documentNumber: doc.documentNumber,
      reversalEntryId: input.reversalEntryId ?? null,
      reason: input.reason ?? null,
    },
  });
}

/** Customer payment post — one event per payment document. */
export async function emitPaymentReceived(
  executor: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<EmitDomainEventResult> {
  const doc = await loadDocumentSnapshot(executor, orgId, documentId);
  return emitDomainEvent(executor, {
    orgId,
    type: "payment.received",
    entityKind: "document",
    entityId: documentId,
    dedupeKey: `payment.received:${documentId}`,
    payload: {
      ...eventEnvelope(),
      paymentId: documentId,
      documentNumber: doc.documentNumber,
      currency: doc.currency,
      amountMinor: minorUnitsOf(doc.total, doc.currency),
      partyId: doc.partyId,
      documentDate: doc.documentDate,
    },
  });
}

/** Item save — once per transaction, so a multi-write save emits once. */
export async function emitItemUpdated(
  executor: SqlExecutor,
  orgId: string,
  itemId: string,
): Promise<EmitDomainEventResult> {
  const row = (await executor.execute<{
    id: string; code: string | null; name: string | null; kind: string | null; isActive: boolean | null;
  }>(sql`
    select id, code, name, kind, is_active as "isActive"
      from items where org_id = ${orgId} and id = ${itemId}::uuid limit 1
  `)).rows[0];
  if (!row) throw new WebhookEmitError("the updated item is gone — the record was deleted; nothing was emitted");
  return emitDomainEvent(executor, {
    orgId,
    type: "item.updated",
    entityKind: "item",
    entityId: itemId,
    dedupeKey: `item.updated:${itemId}:${await currentXactId(executor)}`,
    payload: { ...eventEnvelope(), itemId, code: row.code, name: row.name, kind: row.kind, isActive: row.isActive },
  });
}

/** Customer save — once per transaction. */
export async function emitCustomerUpdated(
  executor: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<EmitDomainEventResult> {
  const row = (await executor.execute<{ id: string; displayName: string | null; email: string | null }>(sql`
    select id, display_name as "displayName", email
      from parties where org_id = ${orgId} and id = ${partyId}::uuid limit 1
  `)).rows[0];
  if (!row) throw new WebhookEmitError("the updated customer is gone — the record was deleted; nothing was emitted");
  return emitDomainEvent(executor, {
    orgId,
    type: "customer.updated",
    entityKind: "customer",
    entityId: partyId,
    dedupeKey: `customer.updated:${partyId}:${await currentXactId(executor)}`,
    payload: { ...eventEnvelope(), customerId: partyId, displayName: row.displayName, email: row.email },
  });
}

export type OverdueInvoiceSnapshot = {
  id: string;
  documentNumber: string;
  currency: string;
  balanceDueMinor: string;
  dueDate: string;
  daysOverdue: number;
};

/**
 * Invoice overdue — once per business day while the invoice stays overdue.
 * The dunning scan calls this for every past-due invoice it reaches, so a
 * day's tick is one event, not one per ladder rung.
 */
export async function emitInvoiceOverdue(
  executor: SqlExecutor,
  orgId: string,
  invoice: OverdueInvoiceSnapshot,
  businessDate: string,
): Promise<EmitDomainEventResult> {
  return emitDomainEvent(executor, {
    orgId,
    type: "invoice.overdue",
    entityKind: "document",
    entityId: invoice.id,
    dedupeKey: `invoice.overdue:${invoice.id}:${businessDate}`,
    payload: {
      ...eventEnvelope(),
      invoiceId: invoice.id,
      documentNumber: invoice.documentNumber,
      currency: invoice.currency,
      balanceDueMinor: invoice.balanceDueMinor,
      dueDate: invoice.dueDate,
      daysOverdue: invoice.daysOverdue,
    },
  });
}

/**
 * Availability change — once per transaction per item and location, so a
 * receipt that touches several layers emits once. Stock movements call
 * this after their layer writes.
 */
export async function emitAvailabilityChanged(
  executor: SqlExecutor,
  orgId: string,
  itemId: string,
  stockLocationId: string | null,
): Promise<EmitDomainEventResult> {
  return emitDomainEvent(executor, {
    orgId,
    type: "inventory.available_changed",
    entityKind: "item",
    entityId: itemId,
    dedupeKey: `inventory.available_changed:${itemId}:${stockLocationId ?? "-"}:${await currentXactId(executor)}`,
    payload: { ...eventEnvelope(), itemId, stockLocationId },
  });
}

