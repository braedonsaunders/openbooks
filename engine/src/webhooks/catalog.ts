import { z } from "zod";

/**
 * Outbound webhook event catalog — the stable contract subscribers code
 * against. Names match the commerce design; payloads are snapshots of the
 * public representation taken at emit time, never live reads.
 *
 * Money travels as decimal strings in minor units beside an ISO currency
 * code (`totalMinor: "1999", currency: "USD"`), so a value larger than
 * 2^53 still arrives exactly. `v` is the payload version; subscribers
 * ignore unknown fields and refuse unknown versions loudly.
 *
 * `subscription.changed` and `channel_order.exception` are catalogued for
 * the packs that own those domains — this module carries no emitter for
 * them yet, and emission refuses unknown types rather than invent one.
 */

export const WEBHOOK_PAYLOAD_VERSION = 1;

const basePayload = z.object({
  v: z.literal(WEBHOOK_PAYLOAD_VERSION),
  occurredAt: z.string().min(1),
});

const minorUnits = z.string().regex(/^-?\d+$/, "minor-unit amounts are decimal integer strings");

export const documentPostedPayload = basePayload.extend({
  documentId: z.string().uuid(),
  kind: z.string().min(1),
  documentNumber: z.string().min(1),
  status: z.literal("posted"),
  currency: z.string().min(1),
  totalMinor: minorUnits,
  documentDate: z.string().nullable(),
  postingDate: z.string().nullable(),
  partyId: z.string().uuid().nullable(),
});

export const documentVoidedPayload = basePayload.extend({
  documentId: z.string().uuid(),
  kind: z.string().min(1),
  documentNumber: z.string().min(1),
  reversalEntryId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
});

export const paymentReceivedPayload = basePayload.extend({
  paymentId: z.string().uuid(),
  documentNumber: z.string().min(1),
  currency: z.string().min(1),
  amountMinor: minorUnits,
  partyId: z.string().uuid().nullable(),
  documentDate: z.string().nullable(),
});

export const itemUpdatedPayload = basePayload.extend({
  itemId: z.string().uuid(),
  code: z.string().nullable(),
  name: z.string().nullable(),
  kind: z.string().nullable(),
  isActive: z.boolean().nullable(),
});

export const customerUpdatedPayload = basePayload.extend({
  customerId: z.string().uuid(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
});

export const invoiceOverduePayload = basePayload.extend({
  invoiceId: z.string().uuid(),
  documentNumber: z.string().min(1),
  currency: z.string().min(1),
  balanceDueMinor: minorUnits,
  dueDate: z.string().min(1),
  daysOverdue: z.number().int().positive(),
});

export const inventoryAvailableChangedPayload = basePayload.extend({
  itemId: z.string().uuid(),
  stockLocationId: z.string().uuid().nullable(),
  quantityOnHand: z.string().nullable(),
});

export const subscriptionChangedPayload = basePayload.extend({
  subscriptionId: z.string().uuid(),
  change: z.string().min(1),
});

export const channelOrderExceptionPayload = basePayload.extend({
  channelOrderId: z.string().uuid(),
  exceptionCode: z.string().min(1),
  exceptionDetail: z.string().nullable(),
});

/** Automation point-to-point calls and operator test pings. Never fanned out to subscribers. */
export const automationFiredPayload = basePayload.extend({
  automationId: z.string().uuid(),
  automationName: z.string().min(1),
  subjectKind: z.string().nullable(),
  subjectId: z.string().nullable(),
});

export const endpointTestedPayload = basePayload.extend({
  endpointId: z.string().uuid(),
  endpointKey: z.string().min(1),
});

const payloadByType = {
  "document.posted": documentPostedPayload,
  "document.voided": documentVoidedPayload,
  "payment.received": paymentReceivedPayload,
  "item.updated": itemUpdatedPayload,
  "customer.updated": customerUpdatedPayload,
  "invoice.overdue": invoiceOverduePayload,
  "inventory.available_changed": inventoryAvailableChangedPayload,
  "subscription.changed": subscriptionChangedPayload,
  "channel_order.exception": channelOrderExceptionPayload,
  "automation.fired": automationFiredPayload,
  "endpoint.tested": endpointTestedPayload,
} as const;

export type WebhookEventType = keyof typeof payloadByType;

/** Domain events fanned out to every subscribed endpoint. */
export const FANOUT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "document.posted",
  "document.voided",
  "payment.received",
  "item.updated",
  "customer.updated",
  "invoice.overdue",
  "inventory.available_changed",
  "subscription.changed",
  "channel_order.exception",
]);

export const WEBHOOK_EVENT_TYPES = Object.keys(payloadByType) as WebhookEventType[];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export function parseWebhookPayload(type: WebhookEventType, payload: unknown): unknown {
  return payloadByType[type].parse(payload);
}
