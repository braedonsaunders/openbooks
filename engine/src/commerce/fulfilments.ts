import { sql } from "drizzle-orm";
import type { ChannelFulfilment } from "./orders.ts";
import { CommerceError } from "./errors.ts";
import { findNative, linkExternal } from "./external-links.ts";
import {
  ingestChannelEvent,
  loadChannelEvent,
  loadChannelOrder,
  markChannelEventException,
  markChannelEventIgnored,
  markChannelEventPosted,
  type ChannelOrderDetail,
  type ChannelOutboundFulfilment,
} from "./orders.ts";
import { getPostingPolicy } from "./posting-policies.ts";
import { CHANNEL_REFUND_EXCEPTION_CODES, RefundPostException } from "./refunds.ts";
import { OrderPostException } from "./order-posting.ts";
import {
  createShopifyFulfillment,
  fetchShopifyFulfillmentOrders,
} from "./shopify/fulfilments.ts";
import { loadShopifyChannel } from "./shopify/channel-access.ts";
import { ShopifyClient } from "../connectors/shopify.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import { issueInventory } from "../inventory/movements.ts";
import { isFulfilmentGovernedInvoice as isSaleFulfilmentGoverned } from "../inventory/documents-sales.ts";
import { InventoryError } from "../inventory/contracts.ts";
import { loadKitComponents, kitComponentQuantities, kitLabel } from "../inventory/kits.ts";
import { postedReturnQuantity } from "../inventory/return-quantities.ts";
import { reverseInventoryMovement } from "../inventory/reversal.ts";
import { trackingUrl } from "../sales/fulfillment.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export const CHANNEL_FULFILMENT_EXCEPTION_CODES = [...CHANNEL_REFUND_EXCEPTION_CODES] as const;

function park(
  code: (typeof CHANNEL_REFUND_EXCEPTION_CODES)[number],
  message: string,
  remedy: string,
): never {
  throw new RefundPostException(code, message, remedy);
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Stored fulfilment payloads revive to the channel-neutral fulfilment. */
export function reviveFulfilmentPayload(payload: Record<string, unknown>): ChannelFulfilment {
  if (payload.direction === "outbound") {
    throw new CommerceError(
      "channel_event_wrong_kind",
      "This fulfilment event pushes to the storefront rather than issuing stock.",
      "Replay it from the fulfilment queue; inbound and outbound events never share a row.",
      { field: "eventId" },
    );
  }
  const lines = (payload.lines ?? []) as Array<Record<string, unknown>>;
  return {
    externalId: String(payload.externalId ?? ""),
    orderExternalId: String(payload.orderExternalId ?? ""),
    locationExternalId: typeof payload.locationExternalId === "string" ? payload.locationExternalId : null,
    status: typeof payload.status === "string" ? payload.status : "",
    cancelled: payload.cancelled === true,
    trackingNumber: typeof payload.trackingNumber === "string" ? payload.trackingNumber : null,
    trackingUrl: typeof payload.trackingUrl === "string" ? payload.trackingUrl : null,
    carrierName: typeof payload.carrierName === "string" ? payload.carrierName : null,
    lines: lines.map((line) => ({
      lineExternalId: typeof line.lineExternalId === "string" ? line.lineExternalId : null,
      sku: typeof line.sku === "string" ? line.sku : null,
      variantExternalId: typeof line.variantExternalId === "string" ? line.variantExternalId : null,
      quantity: String(line.quantity ?? "0"),
    })),
    fulfilledAt: String(payload.fulfilledAt ?? new Date().toISOString()),
  };
}

export function reviveOutboundPayload(payload: Record<string, unknown>): ChannelOutboundFulfilment {
  if (payload.direction !== "outbound") {
    throw new CommerceError(
      "channel_event_wrong_kind",
      "This fulfilment event issues stock rather than pushing to the storefront.",
      "Replay it from the fulfilment queue; inbound and outbound events never share a row.",
      { field: "eventId" },
    );
  }
  return {
    direction: "outbound",
    shipmentId: typeof payload.shipmentId === "string" ? payload.shipmentId : null,
    orderId: String(payload.orderId ?? ""),
  };
}

function parseQuantity(raw: string, label: string): { numerator: bigint; denominator: bigint } {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(raw.trim());
  if (!match) {
    park("tax_mismatch", `Fulfilment ${label} carries an unreadable quantity.`, "Replay the fulfillments delivery from the storefront so every line arrives with a positive quantity, then post it again.");
  }
  const whole = BigInt(match[1]!);
  const frac = match[2] ?? "";
  if (whole === 0n && /^0*$/.test(frac)) {
    park("tax_mismatch", `Fulfilment ${label} has zero quantity.`, "Replay the fulfillments delivery from the storefront so every line arrives with a positive quantity, then post it again.");
  }
  const denominator = 10n ** BigInt(frac.length);
  return { numerator: whole * denominator + (frac === "" ? 0n : BigInt(frac)), denominator };
}

/** Exact fraction to four-decimal stock units. */
function toStockQuantity(fraction: { numerator: bigint; denominator: bigint }, label: string): string {
  const scaled = fraction.numerator * 10_000n;
  const whole = scaled / fraction.denominator;
  if (scaled % fraction.denominator !== 0n) {
    park(
      "tax_mismatch",
      `Fulfilment ${label} ships a fractional quantity below stock precision.`,
      "Record the fractional shipment directly against the sales order, then replay the fulfilment.",
    );
  }
  const digits = whole.toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function fulfilmentDateOf(fulfilledAt: string, fulfilmentId: string): string {
  const date = fulfilledAt.slice(0, 10);
  if (!isIsoCalendarDate(date)) {
    park(
      "tax_mismatch",
      `Fulfilment ${fulfilmentId} carries an unreadable fulfilment date.`,
      "Replay the fulfillments delivery from the storefront so it arrives with its fulfilled-at timestamp, then post it again.",
    );
  }
  return date;
}

async function mapFulfilmentLocation(
  orgId: string,
  channelId: string,
  channelName: string,
  fulfilmentId: string,
  locationExternalId: string | null,
): Promise<string> {
  if (locationExternalId) {
    const row = (await db.execute<{ stock_location_id: string | null }>(sql`
      select stock_location_id from sales_channel_locations
       where org_id = ${orgId} and channel_id = ${channelId} and external_location_id = ${locationExternalId}`)).rows[0];
    if (row?.stock_location_id) return row.stock_location_id;
    park(
      "unmapped_fulfilment_location",
      `Fulfilment ${fulfilmentId} arrives from storefront location "${locationExternalId}", which maps to no stock location.`,
      `Map the storefront location under Channels → Settings → Locations on "${channelName}", then replay the fulfilment. Fixing one offers to fix every fulfilment blocked by the same location.`,
    );
  }
  // No location on the delivery: exactly one mapped location is unambiguous,
  // anything else names the storefront to disambiguate.
  const rows = (await db.execute<{ stock_location_id: string | null }>(sql`
    select stock_location_id from sales_channel_locations
     where org_id = ${orgId} and channel_id = ${channelId} and stock_location_id is not null`)).rows;
  const mapped = rows.map((row) => row.stock_location_id).filter((id): id is string => !!id);
  if (mapped.length !== 1) {
    park(
      "unmapped_fulfilment_location",
      mapped.length === 0
        ? `Fulfilment ${fulfilmentId} names no storefront location and channel "${channelName}" maps none.`
        : `Fulfilment ${fulfilmentId} names no storefront location and channel "${channelName}" maps ${mapped.length}.`,
      `Map the storefront locations under Channels → Settings → Locations on "${channelName}", then replay the fulfilment.`,
    );
  }
  return mapped[0]!;
}

async function matchFulfilmentItem(
  orgId: string,
  provider: string,
  externalAccount: string,
  order: ChannelOrderDetail,
  fulfilmentId: string,
  line: ChannelFulfilment["lines"][number],
): Promise<{ itemId: string; orderLine: ChannelOrderDetail["lines"][number] | null }> {
  let orderLine: ChannelOrderDetail["lines"][number] | null = null;
  if (line.variantExternalId) {
    orderLine = order.lines.find((candidate) => candidate.variantExternalId === line.variantExternalId) ?? null;
  }
  if (!orderLine && line.sku) {
    const sku = line.sku.trim().toUpperCase();
    orderLine = order.lines.find((candidate) => (candidate.sku ?? "").trim().toUpperCase() === sku) ?? null;
  }
  // A gift-card purchase never ships: the fulfilment may still name it, and
  // there is nothing to issue for it.
  if (orderLine?.giftCard) return { itemId: "", orderLine };
  if (line.variantExternalId) {
    const linked = await findNative(orgId, {
      provider,
      externalAccount,
      objectType: "variant",
      externalId: line.variantExternalId,
    });
    if (linked?.nativeTable === "items") {
      const item = (await db.execute<{ id: string }>(sql`
        select id from items where org_id = ${orgId} and id = ${linked.nativeId} and is_active`)).rows[0];
      if (item) return { itemId: item.id, orderLine };
    }
  }
  const sku = cleanText(line.sku);
  if (sku) {
    const item = (await db.execute<{ id: string }>(sql`
      select id from items
       where org_id = ${orgId} and code = ${sku} and is_active
       order by created_at limit 1`)).rows[0];
    if (item) return { itemId: item.id, orderLine };
  }
  park(
    "unmapped_item",
    `Fulfilment ${fulfilmentId} ships SKU ${sku ?? "(none)"} with no matching item.`,
    "Match the storefront variant to an item under Channels → Products, or create the item from the exception row, then replay the fulfilment. Fixing one offers to fix every fulfilment blocked by the same SKU.",
  );
}

interface ChannelMeta {
  name: string;
  kind: string;
  externalAccount: string;
  currency: string;
  subsidiaryId: string | null;
}

async function loadFulfilmentChannel(orgId: string, channelId: string): Promise<ChannelMeta> {
  const row = (await db.execute<{ name: string; kind: string; external_account: string; currency: string; subsidiary_id: string | null }>(sql`
    select name, kind, external_account, currency, subsidiary_id from sales_channels
     where org_id = ${orgId} and id = ${channelId}`)).rows[0];
  if (!row) {
    throw new CommerceError(
      "channel_not_found",
      "The sales channel does not belong to this organization.",
      "Choose a channel in this organization, or connect it first under Channels.",
      { field: "channelId" },
    );
  }
  return { name: row.name, kind: row.kind, externalAccount: row.external_account, currency: row.currency, subsidiaryId: row.subsidiary_id };
}

/**
 * The sale document a fulfilment settles against: the per-order cash sale,
 * or the summary cash sale that absorbed the order. A fulfilment behind no
 * sale waits — revenue and COGS stay in the same story.
 */
async function saleDocumentForFulfilment(orgId: string, order: ChannelOrderDetail): Promise<string | null> {
  if (order.postingDocumentId) {
    const sale = (await db.execute<{ kind: string; status: string }>(sql`
      select kind, status from documents where org_id = ${orgId} and id = ${order.postingDocumentId}`)).rows[0];
    if (sale?.kind === "cash_sale" && sale.status === "posted") return order.postingDocumentId;
    return null;
  }
  if (!order.summaryId) return null;
  const summary = (await db.execute<{ posting_document_id: string | null }>(sql`
    select s.posting_document_id from channel_daily_summaries s
     join documents d on d.org_id = s.org_id and d.id = s.posting_document_id
     where s.org_id = ${orgId} and s.id = ${order.summaryId} and d.status = 'posted'`)).rows[0];
  return summary?.posting_document_id ?? null;
}

/** Exact 4dp scaling for remainder arithmetic: sale quantities ("2") and movement sums ("-2.0000") meet as integers. */
function scale4dp(decimal: string): bigint {
  const [whole = "", frac = ""] = decimal.trim().split(".");
  const negative = whole.startsWith("-");
  const digits = `${negative ? whole.slice(1) : whole}${(frac + "0000").slice(0, 4)}`;
  const scaled = BigInt(digits === "" ? "0" : digits);
  return negative ? -scaled : scaled;
}

function format4dp(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

interface SalePosition {
  lineId: string;
  itemId: string;
  itemKind: string;
  /** Sale-line units still unrelieved, 4dp-scaled. */
  remaining4dp: bigint;
  /** Kit ruler: component issues are measured in kits through the first component. */
  kitRuler: { componentItemId: string; perKit4dp: bigint; label: string } | null;
}

/**
 * Every stocked sale line with its unrelieved remainder, in sale-line
 * units. Posted issues against the line (sale-time issues when OpenBooks
 * fulfils, earlier fulfilments when the storefront does) reduce it;
 * reversed issues do not — the stock came home, so the remainder grows
 * back. A reversed-to-nothing line reads as fully relieved, and the
 * fulfilment behind it carries tracking only.
 */
async function loadSalePositions(
  orgId: string,
  saleDocumentId: string,
  documentDate: string,
  fulfilmentId: string,
): Promise<SalePosition[]> {
  const lines = (await db.execute<{ id: string; item_id: string; quantity: string; kind: string }>(sql`
    select dl.id, dl.item_id, dl.quantity::text as quantity, i.kind
      from document_lines dl
      join items i on i.org_id = dl.org_id and i.id = dl.item_id
     where dl.org_id = ${orgId} and dl.document_id = ${saleDocumentId} and dl.item_id is not null
     order by dl.line_number`)).rows;
  const positions: SalePosition[] = [];
  for (const line of lines) {
    if (line.kind !== "inventory" && line.kind !== "assembly" && line.kind !== "kit") continue;
    const saleQty = scale4dp(line.quantity);
    if (line.kind === "kit") {
      const components = await loadKitComponents(db, orgId, line.item_id, documentDate);
      const label = await kitLabel(db, orgId, line.item_id);
      const perKit = kitComponentQuantities(label, "1.0000", components);
      const ruler = components[0];
      const need = ruler ? perKit.find((entry) => entry.componentItemId === ruler.componentItemId) : undefined;
      if (!ruler || !need) {
        park(
          "tax_mismatch",
          `Fulfilment ${fulfilmentId} settles a sale whose kit line has no recipe.`,
          "Restore the kit recipe effective on the sale date, then replay the fulfilment.",
        );
      }
      const perKit4dp = scale4dp(need!.quantity);
      const issued = (await db.execute<{ total: string }>(sql`
        select coalesce(sum(m.quantity), 0)::text as total from inventory_movements m
         where m.org_id = ${orgId} and m.document_line_id = ${line.id}
           and m.item_id = ${ruler!.componentItemId} and m.kind = 'issue' and m.status = 'posted'
           and not exists (
             select 1 from inventory_movements r
              where r.org_id = m.org_id and r.reverses_movement_id = m.id and r.status = 'posted')`)).rows[0]!.total;
      const issuedComp4dp = -scale4dp(issued);
      const issuedKit4dp = issuedComp4dp * 10_000n;
      if (issuedKit4dp % perKit4dp !== 0n) {
        park(
          "tax_mismatch",
          `Fulfilment ${fulfilmentId} settles a sale whose kit issues do not divide into whole kits.`,
          "Record the correction directly against the sale, then replay the fulfilment.",
        );
      }
      positions.push({
        lineId: line.id,
        itemId: line.item_id,
        itemKind: line.kind,
        remaining4dp: saleQty - issuedKit4dp / perKit4dp,
        kitRuler: { componentItemId: ruler!.componentItemId, perKit4dp, label },
      });
      continue;
    }
    const issued = (await db.execute<{ total: string }>(sql`
      select coalesce(sum(m.quantity), 0)::text as total from inventory_movements m
       where m.org_id = ${orgId} and m.document_line_id = ${line.id}
         and m.kind = 'issue' and m.status = 'posted'
         and not exists (
           select 1 from inventory_movements r
            where r.org_id = m.org_id and r.reverses_movement_id = m.id and r.status = 'posted')`)).rows[0]!.total;
    positions.push({
      lineId: line.id,
      itemId: line.item_id,
      itemKind: line.kind,
      remaining4dp: saleQty + scale4dp(issued),
      kitRuler: null,
    });
  }
  return positions;
}

/**
 * Issue one inbound fulfilment from its mapped location. Kits explode into
 * per-component issues; gift-card lines carry no stock and are skipped. The
 * issue posts COGS at the layer cost — the sale posted revenue without it —
 * exactly once per line, guarded by the fulfilment's idempotency keys.
 */
async function postInboundFulfilment(
  orgId: string,
  actor: string | null,
  eventId: string,
  order: ChannelOrderDetail,
  fulfilment: ChannelFulfilment,
  channel: ChannelMeta,
): Promise<{ status: string; documentId: string | null }> {
  if (!fulfilment.externalId || fulfilment.lines.length === 0) {
    park(
      "tax_mismatch",
      `Fulfilment event ${eventId} carries no fulfilment detail.`,
      "Replay the fulfillments delivery from the storefront so its lines and location arrive, then post it again.",
    );
  }
  const documentDate = fulfilmentDateOf(fulfilment.fulfilledAt, fulfilment.externalId);
  // No policy, no mode: the event stays failed until the operator chooses
  // the channel's posting mode, then replays.
  await getPostingPolicy(orgId, order.channelId, documentDate);
  if (fulfilment.cancelled) {
    return reverseFulfilment(orgId, actor, eventId, order, fulfilment, documentDate, channel);
  }
  const saleDocumentId = await saleDocumentForFulfilment(orgId, order);
  if (!saleDocumentId) {
    park(
      "refund_unposted_order",
      `Fulfilment ${fulfilment.externalId} settles order ${order.externalNumber}, whose sale has not posted yet.`,
      "Post the order first (replay it from the Orders tab), then replay the fulfilment.",
    );
  }
  // The sale's unrelieved remainder is the budget: OpenBooks-fulfilled
  // lines read zero (the sale issued at posting, so the fulfilment carries
  // tracking only), earlier fulfilments reduce their lines, and partial
  // fulfilments split one sale line across events. Stock moves exactly
  // once however the fulfilments arrive.
  const positions = await loadSalePositions(orgId, saleDocumentId!, documentDate, fulfilment.externalId);
  // Only a governed sale (the storefront fulfils) can be over-shipped: its
  // remainder starts full and every unit beyond it left the shelf without a
  // sale line. A sale OpenBooks issued at posting reads zero everywhere by
  // construction, so the storefront's delivery only ever carries tracking.
  const governed = await isSaleFulfilmentGoverned(db, orgId, saleDocumentId!);
  const stockLocationId = await mapFulfilmentLocation(orgId, order.channelId, channel.name, fulfilment.externalId, fulfilment.locationExternalId);
  const saleSubsidiary = (await db.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from documents where org_id = ${orgId} and id = ${saleDocumentId}`)).rows[0]?.subsidiary_id ?? null;
  const subsidiaryId = channel.subsidiaryId ?? saleSubsidiary;
  if (!subsidiaryId) {
    park(
      "tax_mismatch",
      `Fulfilment ${fulfilment.externalId} settles in no subsidiary.`,
      "Set the channel's subsidiary under Channels → Settings, then replay the fulfilment.",
    );
  }
  // Units already allocated earlier in this event, per sale line: two
  // fulfilment lines sharing one sale line split its remainder.
  const eventIssued = new Map<string, bigint>();
  let sequence = 0;
  for (const line of fulfilment.lines) {
    const qty = parseQuantity(line.quantity, `${fulfilment.externalId} line "${line.sku ?? "?"}"`);
    const matched = await matchFulfilmentItem(orgId, channel.kind, channel.externalAccount, order, fulfilment.externalId, line);
    if (!matched.orderLine || matched.orderLine.giftCard || !matched.itemId) continue;
    const itemKind = (await db.execute<{ kind: string }>(sql`
      select kind from items where org_id = ${orgId} and id = ${matched.itemId}`)).rows[0]?.kind ?? null;
    if (itemKind !== "inventory" && itemKind !== "assembly" && itemKind !== "kit") continue;
    const stockQty = toStockQuantity(qty, `${fulfilment.externalId} line "${line.sku ?? "?"}"`);
    let need4dp = scale4dp(stockQty);
    const memo = `Channel fulfilment ${fulfilment.externalId} for order ${order.externalNumber}`;
    const issueLinked = async (
      itemId: string,
      quantity: string,
      saleLineId: string | null,
      keySuffix: string,
      note: string,
    ): Promise<void> => {
      sequence += 1;
      try {
        await issueInventory(orgId, actor, {
          itemId,
          stockLocationId,
          quantity,
          subsidiaryId: subsidiaryId!,
          date: documentDate,
          memo: `${memo}${note}`,
          documentLineId: saleLineId,
          idempotencyKey: `channel-fulfilment:${eventId}:${keySuffix}:${sequence}`,
        });
      } catch (error) {
        if (error instanceof InventoryError && /insufficient stock/i.test(error.message)) {
          park(
            "insufficient_stock",
            `Fulfilment ${fulfilment.externalId} needs ${quantity} units the mapped location does not hold: ${error.message}`,
            "Receive or transfer stock into the mapped location, then replay the fulfilment.",
          );
        }
        throw error;
      }
    };
    for (const position of positions.filter((candidate) => candidate.itemId === matched.itemId)) {
      if (need4dp <= 0n) break;
      const free = position.remaining4dp - (eventIssued.get(position.lineId) ?? 0n);
      if (free <= 0n) continue;
      const take4dp = need4dp < free ? need4dp : free;
      if (position.itemKind === "kit" && position.kitRuler) {
        const components = await loadKitComponents(db, orgId, matched.itemId, documentDate);
        const needs = kitComponentQuantities(position.kitRuler.label, format4dp(take4dp), components);
        for (const component of components) {
          const need = needs.find((entry) => entry.componentItemId === component.componentItemId)!.quantity;
          await issueLinked(component.componentItemId, need, position.lineId, `${position.lineId}:${component.componentItemId}`, "");
        }
      } else {
        await issueLinked(matched.itemId, format4dp(take4dp), position.lineId, position.lineId, "");
      }
      eventIssued.set(position.lineId, (eventIssued.get(position.lineId) ?? 0n) + take4dp);
      need4dp -= take4dp;
    }
    if (need4dp > 0n && governed) {
      // Shipped above the sale (or with no sale line behind it): the units
      // left the shelf regardless, so they issue unlinked — stock truth
      // first — with a memo naming the gap instead of a sale linkage that
      // does not exist.
      const overQty = format4dp(need4dp);
      if (itemKind === "kit") {
        const components = await loadKitComponents(db, orgId, matched.itemId, documentDate);
        const label = await kitLabel(db, orgId, matched.itemId);
        const needs = kitComponentQuantities(label, overQty, components);
        for (const component of components) {
          const need = needs.find((entry) => entry.componentItemId === component.componentItemId)!.quantity;
          await issueLinked(component.componentItemId, need, null, `overage:${matched.itemId}:${component.componentItemId}`,
            ` (shipped above the ${overQty} ordered kits)`);
        }
      } else {
        await issueLinked(matched.itemId, overQty, null, `overage:${matched.itemId}`,
          ` (shipped above the ordered quantity)`);
      }
    }
  }
  await markChannelEventPosted(orgId, eventId, actor, null);
  return { status: "posted", documentId: null };
}

/**
 * Whole pieces for a storefront fulfilment: Shopify counts units, so a
 * fractional stock quantity floors to pieces. Bigint-backed throughout —
 * float math never touches the quantity.
 */
function wholeUnits(decimal: string, label: string, remedy: string): number {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(decimal.trim());
  if (!match) {
    park("tax_mismatch", `Fulfilment ${label} carries an unreadable quantity.`, remedy);
  }
  const whole = BigInt(match![1]!);
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    park("tax_mismatch", `Fulfilment ${label} ships more units than fit a storefront fulfilment.`, remedy);
  }
  return Number(whole);
}

function stockCmp(first: string, second: string): number {
  const scale = (value: string): bigint => {
    const [whole, frac = ""] = value.trim().split(".");
    return BigInt(`${whole}${(frac + "0000").slice(0, 4)}`);
  };
  const diff = scale(first) - scale(second);
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

/**
 * Reverse a cancelled fulfilment: every issue the original event posted is
 * reversed at its own valuation through the governed reversal, which fails
 * closed when the state cannot be reconstructed. A fulfilment that never
 * issued (tracking-only) reverses to nothing. Reversing is an attributed
 * act — an unattended run leaves the event pending for the operator.
 */
async function reverseFulfilment(
  orgId: string,
  actor: string | null,
  eventId: string,
  order: ChannelOrderDetail,
  fulfilment: ChannelFulfilment,
  documentDate: string,
  channel: ChannelMeta,
): Promise<{ status: string; documentId: string | null }> {
  void channel;
  const original = (await db.execute<{ id: string; posting_status: string }>(sql`
    select id, posting_status from channel_order_events
     where org_id = ${orgId} and order_id = ${order.id} and kind = 'fulfilment'
       and id != ${eventId} and coalesce(payload->>'cancelled', 'false') = 'false'
       and payload->>'externalId' = ${fulfilment.externalId}
     order by occurred_at desc
     limit 1`)).rows[0];
  if (!original || original.posting_status !== "posted") {
    park(
      "cancellation_blocked",
      `Fulfilment ${fulfilment.externalId} cannot cancel: order ${order.externalNumber} has no posted fulfilment to reverse.`,
      "Record the fulfilment first (replay its delivery), then replay the cancellation.",
    );
  }
  const movements = (await db.execute<{ id: string; item_id: string; quantity: string; unit_cost: string }>(sql`
    select id, item_id, quantity::text as quantity, unit_cost::text as unit_cost from inventory_movements
     where org_id = ${orgId} and status = 'posted' and kind = 'issue'
       and idempotency_key like ${`channel-fulfilment:${original!.id}:%`}
     order by moved_at, id`)).rows;
  if (movements.length === 0) {
    // The original fulfilment moved no stock (its sale had already issued):
    // the cancellation reverses to nothing and closes.
    await markChannelEventPosted(orgId, eventId, actor, null);
    return { status: "posted", documentId: null };
  }
  if (!actor) {
    return { status: "pending", documentId: null };
  }
  for (const movement of movements) {
    const reversed = (await db.execute<{ id: string }>(sql`
      select id from inventory_movements
       where org_id = ${orgId} and reverses_movement_id = ${movement.id}
       limit 1`)).rows[0];
    if (reversed) continue;
    const returned = await postedReturnQuantity(db, orgId, {
      returnKind: "receipt",
      evidenceKey: "sourceIssueMovementId",
      sourceMovementId: movement.id,
    });
    if (stockCmp(returned, "0") !== 0) {
      // Units already came home through a refund restock: reversing the
      // whole issue would double them. The remainder needs a human.
      park(
        "cancellation_blocked",
        `Fulfilment ${fulfilment.externalId} cannot cancel: part of its stock already returned and reversing the rest is a partial return.`,
        "Record the remaining return directly against the sale, then replay the cancellation.",
      );
    }
    try {
      await reverseInventoryMovement(orgId, actor, {
        movementId: movement.id,
        reversalDate: documentDate,
        reason: `Storefront cancelled fulfilment ${fulfilment.externalId} for order ${order.externalNumber}.`,
      });
    } catch (error) {
      if (error instanceof InventoryError) {
        park(
          "cancellation_blocked",
          `Fulfilment ${fulfilment.externalId} cannot cancel: ${error.message}`,
          "Resolve the blocker named above, then replay the cancellation.",
        );
      }
      throw error;
    }
  }
  await markChannelEventPosted(orgId, eventId, actor, null);
  return { status: "posted", documentId: null };
}

interface OutboundShipmentLine {
  sku: string;
  quantity: number;
}

/**
 * Read one completed shipment as storefront fulfilment lines: the shipped
 * quantities by SKU from the shipment's own lines. The chain is shipment →
 * pick list → sales order through created_from links.
 */
async function outboundShipmentLines(
  orgId: string,
  shipmentId: string,
): Promise<{ salesOrderId: string; lines: OutboundShipmentLine[] } | null> {
  const shipment = (await db.execute<{ id: string; kind: string }>(sql`
    select id, kind from documents where org_id = ${orgId} and id = ${shipmentId}`)).rows[0];
  if (!shipment || shipment.kind !== "shipment") return null;
  const pick = (await db.execute<{ from_document_id: string }>(sql`
    select from_document_id from document_links
     where org_id = ${orgId} and to_document_id = ${shipmentId} and link_type = 'created_from'
     order by created_at limit 1`)).rows[0];
  if (!pick) return null;
  const salesOrder = (await db.execute<{ from_document_id: string; kind: string }>(sql`
    select l.from_document_id, d.kind from document_links l
     join documents d on d.org_id = l.org_id and d.id = l.from_document_id
     where l.org_id = ${orgId} and l.to_document_id = ${pick.from_document_id} and l.link_type = 'created_from'
     order by l.created_at limit 1`)).rows[0];
  if (!salesOrder || salesOrder.kind !== "sales_order") return null;
  const lines = (await db.execute<{ sku: string; quantity: string }>(sql`
    select i.code as sku, dl.quantity::text as quantity
      from document_lines dl
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
     where dl.org_id = ${orgId} and dl.document_id = ${shipmentId} and dl.item_id is not null`)).rows;
  return {
    salesOrderId: salesOrder.from_document_id,
    lines: lines
      .filter((line) => scale4dp(line.quantity) > 0n)
      .map((line) => ({
        sku: line.sku,
        quantity: wholeUnits(line.quantity, `shipment ${shipmentId}`,
          "Correct the shipment quantity to whole units, then push the fulfilment again."),
      })),
  };
}

interface ShipmentTracking {
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrierName: string | null;
}

/**
 * The tracking the storefront receives: the shipping-hub label when the
 * shipment was labelled (carrier, tracking number, label URL), else the
 * shipment's own carrier and tracking number with the carrier's URL
 * template applied.
 */
async function outboundTracking(orgId: string, shipmentId: string): Promise<ShipmentTracking> {
  const label = (await db.execute<{ carrier: string; tracking_number: string | null; label_url: string | null }>(sql`
    select carrier, tracking_number, label_url from shipment_labels
     where org_id = ${orgId} and shipment_document_id = ${shipmentId} and status not in ('voided', 'refunded')
     order by created_at desc
     limit 1`)).rows[0];
  if (label?.tracking_number) {
    return { trackingNumber: label.tracking_number, trackingUrl: label.label_url, carrierName: label.carrier };
  }
  const shipment = (await db.execute<{ tracking_number: string | null; carrier_service: string | null; code: string | null; tracking_url_template: string | null }>(sql`
    select fd.tracking_number, fd.carrier_service, c.code, c.tracking_url_template
      from fulfillment_documents fd
      left join carriers c on c.id = fd.carrier_id and c.org_id = fd.org_id
     where fd.org_id = ${orgId} and fd.document_id = ${shipmentId}`)).rows[0];
  if (!shipment?.tracking_number) return { trackingNumber: null, trackingUrl: null, carrierName: null };
  return {
    trackingNumber: shipment.tracking_number,
    trackingUrl: trackingUrl(shipment.tracking_url_template, shipment.tracking_number),
    carrierName: shipment.code ?? shipment.carrier_service,
  };
}

/**
 * Push one outbound fulfilment to the storefront: match the shipped (or
 * ordered) quantities onto Shopify's open fulfilment-order lines by SKU and
 * fulfil them with tracking. Shopify's fulfilment orders are the source of
 * truth for what is still fulfillable — a fully-fulfilled order closes the
 * event with nothing to do, and a Shopify refusal parks with its message.
 * The fulfilment link makes the push idempotent per shipment (or event).
 */
export interface FulfilmentPostOptions {
  /** Test transport for the Shopify GraphQL calls; production uses fetch. */
  shopifyTransport?: typeof fetch;
}

async function postOutboundFulfilment(
  orgId: string,
  actor: string | null,
  eventId: string,
  order: ChannelOrderDetail,
  outbound: { shipmentId: string | null },
  channel: ChannelMeta,
  options: FulfilmentPostOptions = {},
): Promise<{ status: string; documentId: string | null }> {
  if (channel.kind !== "shopify") {
    park(
      "tax_mismatch",
      `Order ${order.externalNumber} lives on a ${channel.kind} channel, which cannot receive fulfilments.`,
      "Fulfil the order at the storefront directly; OpenBooks still tracks the shipment.",
    );
  }
  const access = await loadShopifyChannel(orgId, order.channelId);
  const client = new ShopifyClient({
    shopDomain: access.shop,
    accessToken: access.accessToken,
    ...(options.shopifyTransport ? { transport: options.shopifyTransport } : {}),
    apiVersion: access.settings.apiVersion,
  });
  let wanted: OutboundShipmentLine[];
  // The fulfilment links to the sale it settles (or the shipment that
  // carried it): the link is the push idempotency, so a replay observes it
  // instead of pushing twice.
  const nativeTable: string | null = "documents";
  let nativeId: string | null = await saleDocumentForFulfilment(orgId, order);
  let linkDocumentId: string | null = null;
  if (outbound.shipmentId) {
    const chain = await outboundShipmentLines(orgId, outbound.shipmentId);
    if (!chain) {
      // No channel shipment behind the request: nothing to push.
      await markChannelEventIgnored(orgId, eventId, actor);
      return { status: "ignored", documentId: null };
    }
    const salesOrder = (await db.execute<{ external_ref: string | null; source_channel_id: string | null }>(sql`
      select external_ref, source_channel_id from documents
       where org_id = ${orgId} and id = ${chain.salesOrderId}`)).rows[0];
    if (salesOrder?.external_ref !== order.externalId || salesOrder?.source_channel_id !== order.channelId) {
      await markChannelEventIgnored(orgId, eventId, actor);
      return { status: "ignored", documentId: null };
    }
    const stage = (await db.execute<{ stage: string }>(sql`
      select stage from fulfillment_documents
       where org_id = ${orgId} and document_id = ${outbound.shipmentId}`)).rows[0]?.stage ?? null;
    if (stage !== "done") {
      // The shipment has not completed: the push waits for completion.
      return { status: "pending", documentId: null };
    }
    wanted = chain.lines;
    nativeId = outbound.shipmentId;
    linkDocumentId = outbound.shipmentId;
  } else {
    // A manual push for an order with no shipment (paid cash sales fulfil
    // without one): the whole order, gift lines aside.
    wanted = order.lines
      .filter((line) => !line.giftCard && line.sku)
      .map((line) => ({
        sku: line.sku!,
        quantity: wholeUnits(line.quantity, `order ${order.externalNumber}`,
          "Fulfil the fractional line in Shopify admin, then replay the push."),
      }))
      .filter((line) => line.quantity > 0);
  }
  if (wanted.length === 0) {
    await markChannelEventPosted(orgId, eventId, actor, linkDocumentId);
    return { status: "posted", documentId: linkDocumentId };
  }
  // The event row lock below serializes concurrent pushes for one event.
  await db.execute(sql`select id from channel_order_events where org_id = ${orgId} and id = ${eventId} for update`);
  if (nativeId) {
    const pushed = (await db.execute<{ id: string }>(sql`
      select id from external_links
       where org_id = ${orgId} and provider = ${channel.kind} and object_type = 'fulfillment'
         and native_table = ${nativeTable} and native_id = ${nativeId}
       limit 1`)).rows[0];
    if (pushed) {
      await markChannelEventPosted(orgId, eventId, actor, linkDocumentId);
      return { status: "posted", documentId: linkDocumentId };
    }
  }
  const fulfilmentOrders = await fetchShopifyFulfillmentOrders(client, order.externalId);
  const open = fulfilmentOrders.filter((fo) => fo.status !== "CLOSED" && fo.status !== "FULFILLED");
  const closed = fulfilmentOrders.filter((fo) => fo.status === "CLOSED" || fo.status === "FULFILLED");
  const pushLines: Array<{ fulfillmentOrderId: string; items: Array<{ fulfillmentOrderLineId: string; quantity: number }> }> = [];
  for (const want of wanted) {
    let need = want.quantity;
    for (const fo of open) {
      if (need <= 0) break;
      for (const foLine of fo.lines) {
        if (need <= 0) break;
        if ((foLine.sku ?? "") !== want.sku) continue;
        const take = Math.min(need, foLine.remainingQuantity);
        if (take <= 0) continue;
        need -= take;
        const bucket = pushLines.find((entry) => entry.fulfillmentOrderId === fo.id);
        if (bucket) bucket.items.push({ fulfillmentOrderLineId: foLine.id, quantity: take });
        else pushLines.push({ fulfillmentOrderId: fo.id, items: [{ fulfillmentOrderLineId: foLine.id, quantity: take }] });
      }
    }
    if (need > 0) {
      // Already fulfilled outside OpenBooks (a closed fulfilment order holds
      // the units): close the event instead of pushing twice.
      const closedQty = closed.reduce(
        (sum, fo) => sum + fo.lines.filter((line) => (line.sku ?? "") === want.sku).reduce((lineSum, line) => lineSum + line.totalQuantity, 0),
        0,
      );
      if (need > closedQty) {
        park(
          "tax_mismatch",
          `Order ${order.externalNumber} ships ${want.quantity} of SKU ${want.sku}, but Shopify holds ${want.quantity - need} fulfillable.`,
          "Fulfil the remainder in Shopify admin (or receive its fulfilment first), then replay the push.",
        );
      }
    }
  }
  if (pushLines.length === 0) {
    // Everything is already fulfilled at the storefront: close the event.
    await markChannelEventPosted(orgId, eventId, actor, linkDocumentId);
    return { status: "posted", documentId: linkDocumentId };
  }
  const tracking = outbound.shipmentId
    ? await outboundTracking(orgId, outbound.shipmentId)
    : { trackingNumber: null, trackingUrl: null, carrierName: null };
  const created = await createShopifyFulfillment(client, {
    orderRestId: order.externalId,
    lines: pushLines,
    trackingNumber: tracking.trackingNumber,
    trackingUrl: tracking.trackingUrl,
    carrierName: tracking.carrierName,
    notifyCustomer: false,
  });
  if (nativeId && nativeTable) {
    await linkExternal(orgId, actor, {
      channelId: order.channelId,
      provider: channel.kind,
      externalAccount: channel.externalAccount,
      objectType: "fulfillment",
      externalId: created.fulfillmentId,
      externalParentId: order.externalId,
      nativeTable,
      nativeId,
    }, "salesChannels");
  }
  await markChannelEventPosted(orgId, eventId, actor, linkDocumentId);
  return { status: "posted", documentId: linkDocumentId };
}

/**
 * Post one stored fulfilment event, inbound or outbound. A replay never
 * double-issues (idempotency keys) and never double-pushes (the fulfilment
 * link). Exceptions park with code, reason and remedy; anything else
 * propagates for the inbox to retry.
 */
export async function postChannelFulfilment(
  orgId: string,
  actor: string | null,
  eventId: string,
  options: FulfilmentPostOptions = {},
): Promise<{ status: string; documentId: string | null; code?: string }> {
  return withOrg(orgId, async () => {
    const event = await loadChannelEvent(orgId, eventId);
    if (!event) {
      throw new CommerceError(
        "channel_event_unknown",
        "The channel event does not belong to this organization.",
        "Choose an event from this organization's channel activity.",
        { field: "eventId" },
      );
    }
    if (event.kind !== "fulfilment") {
      throw new CommerceError(
        "channel_event_wrong_kind",
        `Channel event ${event.externalId} is a ${event.kind}, not a fulfilment.`,
        "Post fulfilments from fulfilment events and refunds from refund events.",
        { field: "eventId" },
      );
    }
    if (event.postingStatus === "posted") return { status: "posted", documentId: event.postingDocumentId };
    if (event.postingStatus === "ignored") return { status: "ignored", documentId: null };
    try {
      const outcome = await withOrgTransaction(orgId, async () => {
        await acquireOrgFeatureGateLock(db, orgId);
        if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
          throw new CommerceError("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
        }
        const live = await loadChannelEvent(orgId, eventId);
        if (!live) throw new Error("Channel fulfilment left while it posted");
        if (live.postingStatus === "posted") {
          return { status: "posted", documentId: live.postingDocumentId };
        }
        if (live.postingStatus === "ignored") {
          return { status: "ignored", documentId: null as string | null };
        }
        const order = await loadChannelOrder(orgId, live.orderId);
        if (!order) throw new Error("Channel fulfilment order left while it posted");
        const channel = await loadFulfilmentChannel(orgId, order.channelId);
        if ((live.payload.direction ?? "inbound") === "outbound") {
          const outbound = reviveOutboundPayload(live.payload);
          return postOutboundFulfilment(orgId, actor, eventId, order, outbound, channel, options);
        }
        const fulfilment = reviveFulfilmentPayload(live.payload);
        return postInboundFulfilment(orgId, actor, eventId, order, fulfilment, channel);
      });
      return { status: outcome.status, documentId: outcome.documentId };
    } catch (error) {
      if (error instanceof RefundPostException || error instanceof OrderPostException) {
        await markChannelEventException(orgId, eventId, actor, {
          code: error.code,
          reason: error.message,
          remedy: error.remedy,
        });
        return { status: "exception", documentId: null, code: error.code };
      }
      if (error instanceof CommerceError) {
        await markChannelEventException(orgId, eventId, actor, {
          code: error.code,
          reason: error.message,
          remedy: error.remedy,
        });
        return { status: "exception", documentId: null, code: error.code };
      }
      throw error;
    }
  });
}

/**
 * Request a push of one OpenBooks fulfilment to the storefront: materialize
 * the outbound event (idempotent per shipment or order) and process it. A
 * shipment that is not a channel shipment retires the event as ignored. A
 * push that cannot complete parks with the reason and remedy — the shipment
 * itself already completed, so the push never fails it.
 */
export async function requestChannelFulfilmentPush(
  orgId: string,
  actor: string | null,
  input: { shipmentId: string } | { orderId: string },
  options: FulfilmentPostOptions = {},
): Promise<{ status: string; documentId: string | null; eventId: string | null; code?: string }> {
  return withOrg(orgId, async () => {
    let orderId: string | null = null;
    let orderExternalId: string | null = null;
    let shipmentId: string | null = null;
    if ("shipmentId" in input) {
      shipmentId = input.shipmentId;
      const chain = await outboundShipmentLines(orgId, input.shipmentId);
      if (!chain) return { status: "ignored", documentId: null, eventId: null };
      const salesOrder = (await db.execute<{ id: string; external_ref: string | null; source_channel_id: string | null }>(sql`
        select id, external_ref, source_channel_id from documents
         where org_id = ${orgId} and id = ${chain.salesOrderId}`)).rows[0];
      if (!salesOrder?.external_ref || !salesOrder.source_channel_id) {
        return { status: "ignored", documentId: null, eventId: null };
      }
      const order = (await db.execute<{ id: string }>(sql`
        select id from channel_orders
         where org_id = ${orgId} and channel_id = ${salesOrder.source_channel_id}
           and external_id = ${salesOrder.external_ref}`)).rows[0];
      if (!order) return { status: "ignored", documentId: null, eventId: null };
      orderId = order.id;
      orderExternalId = salesOrder.external_ref;
    } else {
      const order = await loadChannelOrder(orgId, input.orderId);
      if (!order) {
        throw new CommerceError(
          "channel_order_unknown",
          "The channel order does not belong to this organization.",
          "Choose an order from this organization's channel orders.",
          { field: "orderId" },
        );
      }
      orderId = order.id;
      orderExternalId = order.externalId;
    }
    const order = (await loadChannelOrder(orgId, orderId!))!;
    const externalId = shipmentId ? `outbound-shipment:${shipmentId}` : `outbound-order:${orderId}`;
    const stored = await ingestChannelEvent(orgId, actor, order.channelId, orderExternalId!, {
      kind: "fulfilment",
      externalId,
      outbound: { direction: "outbound", shipmentId, orderId: orderId! },
      occurredAt: new Date().toISOString(),
    });
    return { ...(await postChannelFulfilment(orgId, actor, stored.eventId, options)), eventId: stored.eventId };
  });
}
