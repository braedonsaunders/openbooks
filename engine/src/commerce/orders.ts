import { sql } from "drizzle-orm";
import type { ChannelOrder, ChannelRefund, ChannelShippingLine, ChannelTaxLine, ChannelTender } from "./contracts.ts";
import { markOrderEconomicsDirty, recomputeOrderEconomicsScoped } from "./economics.ts";
import { CommerceError } from "./errors.ts";
import { findNative, linkExternal } from "./external-links.ts";
import { getPostingPolicy } from "./posting-policies.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg } from "../platform/db.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export type ChannelOrderPostingStatus = "pending" | "posted" | "summarized" | "exception" | "excluded";

export interface ChannelOrderRow {
  id: string;
  channelId: string;
  externalId: string;
  externalNumber: string;
  customerPartyId: string | null;
  shopCurrency: string;
  presentmentCurrency: string;
  totalMinor: bigint;
  financialStatus: string;
  fulfilmentStatus: string;
  postingStatus: ChannelOrderPostingStatus;
  postingDocumentId: string | null;
  summaryId: string | null;
  exceptionCode: string | null;
  exceptionReason: string | null;
  exceptionRemedy: string | null;
  orderedAt: string;
}

type OrderDbRow = Record<string, unknown> & {
  id: string;
  channel_id: string;
  external_id: string;
  external_number: string;
  customer_party_id: string | null;
  shop_currency: string;
  presentment_currency: string;
  total_minor: bigint;
  financial_status: string;
  fulfilment_status: string;
  posting_status: ChannelOrderPostingStatus;
  posting_document_id: string | null;
  summary_id: string | null;
  exception_code: string | null;
  exception_reason: string | null;
  exception_remedy: string | null;
  ordered_at: string;
};

function toOrderRow(row: OrderDbRow): ChannelOrderRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    externalId: row.external_id,
    externalNumber: row.external_number,
    customerPartyId: row.customer_party_id,
    shopCurrency: row.shop_currency,
    presentmentCurrency: row.presentment_currency,
    totalMinor: asMinorUnits(row.total_minor),
    financialStatus: row.financial_status,
    fulfilmentStatus: row.fulfilment_status,
    postingStatus: row.posting_status,
    postingDocumentId: row.posting_document_id,
    summaryId: row.summary_id,
    exceptionCode: row.exception_code,
    exceptionReason: row.exception_reason,
    exceptionRemedy: row.exception_remedy,
    orderedAt: row.ordered_at,
  };
}

const ORDER_COLUMNS = sql`id, channel_id, external_id, external_number, customer_party_id, shop_currency, presentment_currency, total_minor, financial_status, fulfilment_status, posting_status, posting_document_id, summary_id, exception_code, exception_reason, exception_remedy, ordered_at`;

/**
 * Postgres returns bigint columns as strings; the subledger boundary
 * coerces them back, so resolution always computes on real bigints and a
 * string-concatenation can never masquerade as a cross-foot mismatch.
 */
function asMinorUnits(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value as string);
}

function reviveTaxLines(lines: ChannelTaxLine[] | null | undefined): ChannelTaxLine[] {
  for (const tax of lines ?? []) {
    tax.amountMinor = asMinorUnits(tax.amountMinor);
  }
  return (lines ?? []) as ChannelTaxLine[];
}

/** Stored lines keep minor units as JSON strings; revive them to bigints on the way out. */
function reviveOrderLines(lines: ChannelOrder["lines"] | null | undefined): ChannelOrder["lines"] {
  for (const line of lines ?? []) {
    line.priceMinor = asMinorUnits(line.priceMinor);
    line.discountMinor = asMinorUnits(line.discountMinor);
    line.taxLines = reviveTaxLines(line.taxLines);
  }
  return (lines ?? []) as ChannelOrder["lines"];
}

function reviveShippingLines(lines: ChannelShippingLine[] | null | undefined): ChannelOrder["shippingLines"] {
  for (const line of lines ?? []) {
    line.amountMinor = asMinorUnits(line.amountMinor);
    line.discountMinor = asMinorUnits(line.discountMinor);
    line.taxLines = reviveTaxLines(line.taxLines);
  }
  return (lines ?? []) as ChannelOrder["shippingLines"];
}

function reviveTenders(tenders: ChannelTender[] | null | undefined): ChannelOrder["tenders"] {
  for (const tender of tenders ?? []) {
    tender.amountMinor = asMinorUnits(tender.amountMinor);
  }
  return (tenders ?? []) as ChannelOrder["tenders"];
}

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

/**
 * Refresh one order's margin facts without disturbing the order flow: the
 * recompute joins this unit of work, and a refusal parks a restatement mark
 * for the channel scan instead of failing an ingest that already stored.
 */
async function refreshOrderEconomics(orgId: string, actor: string | null, orderId: string, reason: string): Promise<void> {
  try {
    await recomputeOrderEconomicsScoped(orgId, actor, orderId);
  } catch {
    await markOrderEconomicsDirty(orgId, orderId, reason).catch(() => null);
  }
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Serialize validated tags as a Postgres array literal (drizzle cannot bind a JS array to a text[] cast). */
function toTextArrayLiteral(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

interface IngestChannel {
  id: string;
  kind: string;
  name: string;
  currency: string;
  externalAccount: string;
}

async function loadIngestChannel(orgId: string, channelId: string): Promise<IngestChannel> {
  const row = (await db.execute<{ id: string; kind: string; name: string; currency: string; external_account: string }>(sql`
    select id, kind, name, currency, external_account from sales_channels
     where org_id = ${orgId} and id = ${channelId}`)).rows[0];
  if (!row) {
    refuse(
      "channel_not_found",
      "The sales channel does not belong to this organization.",
      "Choose a channel in this organization, or connect it first under Channels.",
      "channelId",
    );
  }
  return { id: row.id, kind: row.kind, name: row.name, currency: row.currency, externalAccount: row.external_account };
}

function checkOrderShape(order: ChannelOrder): void {
  if (!cleanText(order.externalId)) refuse("channel_order_id_missing", "A channel order needs its storefront id.", "Ingest the order with the storefront's order id.", "externalId");
  if (!cleanText(order.number)) refuse("channel_order_number_missing", "A channel order needs its storefront number.", "Ingest the order with the storefront's order number.", "number");
  if (!/^[A-Za-z]{3}$/.test(order.shopCurrency ?? "")) {
    refuse(
      "channel_order_currency_invalid",
      `Shop currency "${order.shopCurrency}" is not a three-letter ISO code.`,
      "Ingest the order with the shop's three-letter currency code, for example USD.",
      "shopCurrency",
    );
  }
  if (order.totalMinor < 0n) {
    refuse(
      "channel_order_total_negative",
      `Order ${order.number} totals a negative amount.`,
      "Ingest refunds as order events against the original order, never as negative orders.",
      "totalMinor",
    );
  }
}

/**
 * Match the buyer to a customer party: the channel's customer link first,
 * then the buyer email, then a new customer party (or the channel's
 * walk-in customer when the merchant configured one). Matching never
 * invents a party silently: a created party is linked back to the
 * storefront customer, so the next order for the same buyer matches.
 */
export async function resolveCustomer(
  orgId: string,
  actor: string | null,
  channel: IngestChannel,
  order: ChannelOrder,
  guestCustomerPartyId: string | null,
): Promise<string | null> {
  if (order.customerExternalId) {
    const linked = await findNative(orgId, {
      provider: channel.kind,
      externalAccount: channel.externalAccount,
      objectType: "customer",
      externalId: order.customerExternalId,
    });
    if (linked?.nativeTable === "parties") {
      const party = (await db.execute<{ id: string }>(sql`
        select id from parties where org_id = ${orgId} and id = ${linked.nativeId} and is_active`)).rows[0];
      if (party) return party.id;
    }
  }
  const email = cleanText(order.customerEmail)?.toLowerCase() ?? null;
  if (email) {
    const party = (await db.execute<{ id: string }>(sql`
      select id from parties
       where org_id = ${orgId} and kind = 'customer' and is_active
         and lower(email) = ${email}
       order by created_at limit 1`)).rows[0];
    if (party) {
      if (order.customerExternalId && actor) {
        await linkExternal(orgId, actor, {
          channelId: channel.id,
          provider: channel.kind,
          externalAccount: channel.externalAccount,
          objectType: "customer",
          externalId: order.customerExternalId,
          nativeTable: "parties",
          nativeId: party.id,
        }, "salesChannels").catch(() => null);
      }
      return party.id;
    }
  }
  if (guestCustomerPartyId) return guestCustomerPartyId;
  const displayName = cleanText(order.customerName) ?? (email ?? `Storefront customer ${order.customerExternalId ?? order.number}`);
  const inserted = await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name, email, is_active, custom, created_by, updated_by)
    values (${orgId}, 'customer', ${displayName}, ${email},
      true, '{}'::jsonb, ${actor}, ${actor})
    returning id`);
  if (inserted.rows.length !== 1) throw new Error("Customer party insert returned an unexpected row count");
  const partyId = inserted.rows[0]!.id;
  if (order.customerExternalId && actor) {
    await linkExternal(orgId, actor, {
      channelId: channel.id,
      provider: channel.kind,
      externalAccount: channel.externalAccount,
      objectType: "customer",
      externalId: order.customerExternalId,
      nativeTable: "parties",
      nativeId: partyId,
    }, "salesChannels").catch(() => null);
  }
  return partyId;
}

function serializeOrder(order: ChannelOrder): {
  lines: string;
  shippingLines: string;
  tenders: string;
  customerAddress: string | null;
} {
  const replacer = (_key: string, value: unknown): unknown => typeof value === "bigint" ? value.toString() : value;
  return {
    lines: JSON.stringify(order.lines, replacer),
    shippingLines: JSON.stringify(order.shippingLines, replacer),
    tenders: JSON.stringify(order.tenders, replacer),
    customerAddress: order.customerAddress ? JSON.stringify(order.customerAddress) : null,
  };
}

/**
 * Ingest one normalized storefront order into the channel subledger.
 * Idempotent on (channel, external id): a redelivery returns the stored row,
 * and an edit whose totals or lines changed refreshes the row and records a
 * channel_order_events edit row, so the audit trail shows what moved. Orders
 * the channel excludes by tag or source park as excluded with the reason;
 * everything else waits as pending for the posting scan.
 */
export async function ingestChannelOrder(
  orgId: string,
  actor: string | null,
  channelId: string,
  order: ChannelOrder,
): Promise<ChannelOrderRow> {
  checkOrderShape(order);
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
    const channel = await loadIngestChannel(orgId, channelId);
    const orderDate = order.orderedAt.slice(0, 10);
    // No policy, no mode: the event stays failed with this refusal until
    // the operator chooses the channel's posting mode, then replays.
    const policy = await getPostingPolicy(orgId, channelId, orderDate);
    const customerPartyId = await resolveCustomer(orgId, actor, channel, order, policy.guestCustomerPartyId);
    const parts = serializeOrder(order);
    const excludedByTag = order.tags.find((tag) => policy.excludedTags.includes(tag)) ?? null;
    const excludedBySource = order.source && policy.excludedSources.includes(order.source) ? order.source : null;
    const excludedReason = excludedByTag
      ? `Order carries excluded tag "${excludedByTag}".`
      : excludedBySource
        ? `Order source "${excludedBySource}" is excluded for this channel.`
        : null;
    const existing = (await db.execute<OrderDbRow>(sql`
      select ${ORDER_COLUMNS} from channel_orders
       where org_id = ${orgId} and channel_id = ${channelId} and external_id = ${order.externalId}`)).rows[0];
    if (existing) {
      // Posted history is immutable: a redelivered order that already
      // posted (or summarized, or was deliberately excluded) is observed,
      // never rewritten — an edit after posting is a new event instead.
      if (existing.posting_status === "posted" || existing.posting_status === "summarized" || existing.posting_status === "excluded") {
        return toOrderRow(existing);
      }
      const updated = await db.execute<OrderDbRow>(sql`
        update channel_orders
           set external_number = ${order.number},
               customer_external_id = ${order.customerExternalId},
               customer_party_id = ${customerPartyId},
               customer_name = ${order.customerName},
               customer_email = ${order.customerEmail},
               customer_address = ${parts.customerAddress}::jsonb,
               shop_currency = ${order.shopCurrency},
               presentment_currency = ${order.presentmentCurrency},
               subtotal_minor = ${order.subtotalMinor.toString()},
               tax_minor = ${order.taxMinor.toString()},
               shipping_minor = ${order.shippingMinor.toString()},
               discount_minor = ${order.discountMinor.toString()},
               total_minor = ${order.totalMinor.toString()},
               financial_status = ${order.financialStatus},
               fulfilment_status = ${order.fulfilmentStatus},
               order_tags = ${toTextArrayLiteral(order.tags)}::text[],
               order_source = ${order.source},
               lines = ${parts.lines}::jsonb,
               shipping_lines = ${parts.shippingLines}::jsonb,
               tenders = ${parts.tenders}::jsonb,
               ordered_at = ${order.orderedAt},
               cancelled_at = ${order.cancelledAt},
               posting_status = ${excludedReason ? "excluded" : "pending"},
               exclude_reason = ${excludedReason},
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${existing.id}
         returning ${ORDER_COLUMNS}`);
      if (updated.rows.length !== 1) {
        throw new Error("Channel order update matched no row; the order left while it was ingested");
      }
      await db.execute(sql`
        insert into channel_order_events
          (org_id, channel_id, order_id, kind, external_id, payload, posting_status, occurred_at, created_by, updated_by)
        values (${orgId}, ${channelId}, ${existing.id}, 'edit', ${`edit:${order.externalId}:${order.orderedAt}`},
          ${JSON.stringify({ number: order.number, totalMinor: order.totalMinor.toString() })}::jsonb,
          'ignored', now(), ${actor}, ${actor})
        on conflict (org_id, order_id, external_id) do nothing`);
      await refreshOrderEconomics(orgId, actor, existing.id, "order updated");
      return toOrderRow(updated.rows[0]!);
    }
    // A redelivery racing the first store collides on the channel-external
    // unique key; the conflict is expected and benign, so re-read the
    // winner instead of refusing a duplicate.
    const inserted = await db.execute<{ id: string }>(sql`
      insert into channel_orders
        (org_id, channel_id, external_id, external_number, customer_external_id, customer_party_id,
         customer_name, customer_email, customer_address,
         shop_currency, presentment_currency,
         subtotal_minor, tax_minor, shipping_minor, discount_minor, total_minor,
         financial_status, fulfilment_status, order_tags, order_source,
         lines, shipping_lines, tenders, ordered_at, cancelled_at,
         posting_status, exclude_reason, created_by, updated_by)
      values (${orgId}, ${channelId}, ${order.externalId}, ${order.number},
        ${order.customerExternalId}, ${customerPartyId},
        ${order.customerName}, ${order.customerEmail}, ${parts.customerAddress}::jsonb,
        ${order.shopCurrency}, ${order.presentmentCurrency},
        ${order.subtotalMinor.toString()}, ${order.taxMinor.toString()},
        ${order.shippingMinor.toString()}, ${order.discountMinor.toString()}, ${order.totalMinor.toString()},
        ${order.financialStatus}, ${order.fulfilmentStatus}, ${toTextArrayLiteral(order.tags)}::text[], ${order.source},
        ${parts.lines}::jsonb, ${parts.shippingLines}::jsonb, ${parts.tenders}::jsonb,
        ${order.orderedAt}, ${order.cancelledAt},
        ${excludedReason ? "excluded" : "pending"}, ${excludedReason}, ${actor}, ${actor})
      on conflict (org_id, channel_id, external_id) do nothing
      returning id`);
    const id = inserted.rows[0]?.id ?? (await db.execute<{ id: string }>(sql`
      select id from channel_orders
       where org_id = ${orgId} and channel_id = ${channelId} and external_id = ${order.externalId}`)).rows[0]?.id;
    if (!id) throw new Error("Channel order store returned no row; the order was lost");
    const row = (await db.execute<OrderDbRow>(sql`
      select ${ORDER_COLUMNS} from channel_orders where org_id = ${orgId} and id = ${id}`)).rows[0];
    if (!row) throw new Error("Channel order store returned no row; the order was lost");
    await refreshOrderEconomics(orgId, actor, id, "order ingested");
    return toOrderRow(row);
  });
}

/**
 * Store one refund, cancellation, edit or fulfilment against its order.
 * Idempotent on (order, event external id): a redelivered provider event
 * returns the stored row. A cancellation parks a still-pending order as
 * excluded so it can never post; refund posting rides the cash-refund
 * writer and is recorded on the event row when it lands.
 */
export async function ingestChannelEvent(
  orgId: string,
  actor: string | null,
  channelId: string,
  orderExternalId: string,
  event: ChannelEventInput,
): Promise<{ eventId: string; orderId: string }> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
    await loadIngestChannel(orgId, channelId);
    const order = (await db.execute<{ id: string; posting_status: string }>(sql`
      select id, posting_status from channel_orders
       where org_id = ${orgId} and channel_id = ${channelId} and external_id = ${orderExternalId}`)).rows[0];
    if (!order) {
      refuse(
        "channel_order_unknown",
        `Order "${orderExternalId}" is not in this channel's subledger yet.`,
        "Ingest the order first (replay the orders/create delivery), then record its events.",
        "orderExternalId",
      );
    }
    // Same expected-benign collision shape as the order store above.
    const inserted = await db.execute<{ id: string }>(sql`
      insert into channel_order_events
        (org_id, channel_id, order_id, kind, external_id,
         payload, posting_status, occurred_at, created_by, updated_by)
      values (${orgId}, ${channelId}, ${order.id}, ${event.kind}, ${event.externalId},
        ${event.refund ? JSON.stringify(event.refund, (_key, value) => typeof value === "bigint" ? value.toString() : value) : "{}"}::jsonb,
        'pending', ${event.occurredAt}, ${actor}, ${actor})
      on conflict (org_id, order_id, external_id) do nothing
      returning id`);
    const eventId = inserted.rows[0]?.id ?? (await db.execute<{ id: string }>(sql`
      select id from channel_order_events
       where org_id = ${orgId} and order_id = ${order.id} and external_id = ${event.externalId}`)).rows[0]?.id;
    if (!eventId) throw new Error("Channel event store returned no row; the event was lost");
    if (event.kind === "cancellation" && order.posting_status === "pending") {
      const parked = await db.execute(sql`
        update channel_orders
           set posting_status = 'excluded', exclude_reason = 'Cancelled at the storefront before posting.',
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${order.id} and posting_status = 'pending'`);
      if (parked.rowCount !== 1) {
        throw new Error("Channel order cancellation matched no row; the order posted while it was cancelled");
      }
    }
    // Fulfilments, refunds and edits move the margin picture, so the event
    // refreshes it in the same unit of work.
    await refreshOrderEconomics(orgId, actor, order.id, `order ${event.kind}`);
    return { eventId, orderId: order.id };
  });
}

export interface ChannelEventInput {
  kind: "refund" | "cancellation" | "edit" | "fulfilment";
  externalId: string;
  refund?: ChannelRefund | null;
  occurredAt: string;
}

/** The full stored order: resolution and posting read this, never the provider payload. */
export interface ChannelOrderDetail extends ChannelOrderRow {
  customerExternalId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerAddress: Record<string, unknown> | null;
  presentmentRate: string | null;
  subtotalMinor: bigint;
  taxMinor: bigint;
  shippingMinor: bigint;
  discountMinor: bigint;
  tags: string[];
  source: string | null;
  lines: ChannelOrder["lines"];
  shippingLines: ChannelOrder["shippingLines"];
  tenders: ChannelOrder["tenders"];
  cancelledAt: string | null;
  excludeReason: string | null;
}

type OrderDetailDbRow = Record<string, unknown> & {
  id: string;
  channel_id: string;
  external_id: string;
  external_number: string;
  customer_external_id: string | null;
  customer_party_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_address: Record<string, unknown> | null;
  shop_currency: string;
  presentment_currency: string;
  presentment_rate: string | null;
  subtotal_minor: bigint;
  tax_minor: bigint;
  shipping_minor: bigint;
  discount_minor: bigint;
  total_minor: bigint;
  financial_status: string;
  fulfilment_status: string;
  order_tags: string[];
  order_source: string | null;
  lines: ChannelOrder["lines"];
  shipping_lines: ChannelOrder["shippingLines"];
  tenders: ChannelOrder["tenders"];
  ordered_at: string;
  cancelled_at: string | null;
  posting_status: ChannelOrderPostingStatus;
  posting_document_id: string | null;
  summary_id: string | null;
  exception_code: string | null;
  exception_reason: string | null;
  exception_remedy: string | null;
  exclude_reason: string | null;
};

const ORDER_DETAIL_COLUMNS = sql`id, channel_id, external_id, external_number, customer_external_id, customer_party_id, customer_name, customer_email, customer_address, shop_currency, presentment_currency, presentment_rate, subtotal_minor, tax_minor, shipping_minor, discount_minor, total_minor, financial_status, fulfilment_status, order_tags, order_source, lines, shipping_lines, tenders, ordered_at, cancelled_at, posting_status, posting_document_id, summary_id, exception_code, exception_reason, exception_remedy, exclude_reason`;

function toOrderDetail(row: OrderDetailDbRow): ChannelOrderDetail {
  return {
    id: row.id,
    channelId: row.channel_id,
    externalId: row.external_id,
    externalNumber: row.external_number,
    customerExternalId: row.customer_external_id,
    customerPartyId: row.customer_party_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerAddress: row.customer_address,
    shopCurrency: row.shop_currency,
    presentmentCurrency: row.presentment_currency,
    presentmentRate: row.presentment_rate,
    subtotalMinor: asMinorUnits(row.subtotal_minor),
    taxMinor: asMinorUnits(row.tax_minor),
    shippingMinor: asMinorUnits(row.shipping_minor),
    discountMinor: asMinorUnits(row.discount_minor),
    totalMinor: asMinorUnits(row.total_minor),
    financialStatus: row.financial_status,
    fulfilmentStatus: row.fulfilment_status,
    tags: row.order_tags ?? [],
    source: row.order_source,
    lines: reviveOrderLines(row.lines),
    shippingLines: reviveShippingLines(row.shipping_lines),
    tenders: reviveTenders(row.tenders),
    orderedAt: row.ordered_at,
    cancelledAt: row.cancelled_at,
    postingStatus: row.posting_status,
    postingDocumentId: row.posting_document_id,
    summaryId: row.summary_id,
    exceptionCode: row.exception_code,
    exceptionReason: row.exception_reason,
    exceptionRemedy: row.exception_remedy,
    excludeReason: row.exclude_reason,
  };
}

/** Load one stored order with its normalized lines, or null when it is not in this org. */
export async function loadChannelOrder(orgId: string, orderId: string): Promise<ChannelOrderDetail | null> {
  const row = (await db.execute<OrderDetailDbRow>(sql`
    select ${ORDER_DETAIL_COLUMNS} from channel_orders
     where org_id = ${orgId} and id = ${orderId}`)).rows[0];
  return row ? toOrderDetail(row) : null;
}

/**
 * Claim pending orders for posting, oldest first, skipping rows another
 * worker holds. The claim is the SELECT itself: callers post each id
 * through postChannelOrder, which re-reads and locks the row.
 */
export async function claimPendingChannelOrders(orgId: string, limit: number): Promise<string[]> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from channel_orders
     where org_id = ${orgId} and posting_status = 'pending'
     order by ordered_at
     limit ${limit}
     for update skip locked`)).rows;
  return rows.map((row) => row.id);
}

/** Park an order on the exception queue with the code, reason and remedy the operator acts on. */
export async function markOrderException(
  orgId: string,
  orderId: string,
  actor: string | null,
  exception: { code: string; reason: string; remedy: string },
): Promise<void> {
  const updated = await db.execute(sql`
    update channel_orders
       set posting_status = 'exception',
           posting_document_id = null,
           summary_id = null,
           exception_code = ${exception.code},
           exception_reason = ${exception.reason},
           exception_remedy = ${exception.remedy},
           updated_by = ${actor}, updated_at = now()
     where org_id = ${orgId} and id = ${orderId}
       and posting_status in ('pending', 'exception')`);
  if (updated.rowCount !== 1) {
    throw new Error("Channel order exception mark matched no row; the order posted or left while it parked");
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'channel_orders', ${orderId}, 'update',
      ${JSON.stringify({ before: null, after: null, reason: `${exception.code}: ${exception.reason}` })}::jsonb, ${actor})`);
}

/** Link an order to its posted document. Posted history is never rewritten: only a pending or parked row moves. */
export async function markOrderPosted(
  orgId: string,
  orderId: string,
  actor: string | null,
  documentId: string,
): Promise<void> {
  const updated = await db.execute(sql`
    update channel_orders
       set posting_status = 'posted',
           posting_document_id = ${documentId},
           exception_code = null, exception_reason = null, exception_remedy = null,
           updated_by = ${actor}, updated_at = now()
     where org_id = ${orgId} and id = ${orderId}
       and posting_status in ('pending', 'exception')`);
  if (updated.rowCount !== 1) {
    throw new Error("Channel order post mark matched no row; the order already posted or left while it posted");
  }
}

/** Link an order to a held (approval-gated) draft without changing its pending state. */
export async function linkOrderDocument(
  orgId: string,
  orderId: string,
  actor: string | null,
  documentId: string,
): Promise<void> {
  const updated = await db.execute(sql`
    update channel_orders
       set posting_document_id = ${documentId},
           updated_by = ${actor}, updated_at = now()
     where org_id = ${orgId} and id = ${orderId}
       and posting_status = 'pending'`);
  if (updated.rowCount !== 1) {
    throw new Error("Channel order document link matched no row; the order posted or left while it linked");
  }
}

/** Link an order into its daily summary batch. */
export async function markOrderSummarized(
  orgId: string,
  orderId: string,
  actor: string | null,
  summaryId: string,
): Promise<void> {
  const updated = await db.execute(sql`
    update channel_orders
       set posting_status = 'summarized',
           summary_id = ${summaryId},
           exception_code = null, exception_reason = null, exception_remedy = null,
           updated_by = ${actor}, updated_at = now()
     where org_id = ${orgId} and id = ${orderId}
       and posting_status in ('pending', 'exception')`);
  if (updated.rowCount !== 1) {
    throw new Error("Channel order summary mark matched no row; the order already posted or left while it summarized");
  }
}
