import { sql } from "drizzle-orm";
import { CommerceError } from "./errors.ts";
import { findNative } from "./external-links.ts";
import { loadChannelOrder, type ChannelOrderDetail } from "./orders.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { lookupSpotRate } from "../fx/spot-rate.ts";
import { apportion, roundDiv, toUnits } from "../money/money.ts";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import type { ChannelOrderLine } from "./contracts.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export type EconomicsComponent =
  | "net_revenue"
  | "discount"
  | "cogs"
  | "processor_fee"
  | "shipping_label"
  | "marketplace_fee"
  | "stored_value_funding"
  | "returns"
  | "restocking_fee"
  | "ad_spend";

export type EconomicsSourceKind =
  | "posting"
  | "fulfilment"
  | "label"
  | "payout"
  | "refund"
  | "estimate"
  | "import"
  | "manual";

export interface EconomicsFactInput {
  lineKey: string;
  component: EconomicsComponent;
  sourceKind: EconomicsSourceKind;
  sourceRef: string;
  currency: string;
  amountMinor: bigint;
  itemId: string | null;
  sku: string | null;
  promotionCode: string | null;
  estimated: boolean;
}

export interface EconomicsFact extends EconomicsFactInput {
  version: number;
  asOf: string;
}

export interface OrderEconomics {
  orderId: string;
  currency: string;
  facts: EconomicsFact[];
  /** Net merchandise and shipping revenue after discounts (same-currency rows). */
  revenue: bigint;
  /** CM1: revenue minus actual issue cost, returns and restocking income. */
  cm1: bigint;
  /** CM2: CM1 minus fulfilment, payment, marketplace and funding costs. */
  cm2: bigint;
  /** CM3: CM2 minus allocated marketing spend. */
  cm3: bigint;
  /** CM2 as a 4dp percent of revenue, derived from stored sums, never stored. */
  marginPct: string | null;
  estimatedAny: boolean;
  /**
   * A cost arrived in another currency that no rate could price, so it stays
   * out of the CM sums until its rate exists. Converted costs join the sums
   * with their original currency kept as evidence on the source ref.
   */
  mixedCurrency: boolean;
}

function refuse(code: string, message: string, remedy: string, field: string | null = null): never {
  throw new CommerceError(code, message, remedy, { field });
}

/** Postgres returns bigint columns as strings; coerce at the boundary. */
function asMinorUnits(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value as string);
}

/** Quantity text to an exact 8dp integer weight; null when unreadable. */
function parseQuantityWeight(raw: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(raw.trim());
  if (!match) return null;
  const whole = BigInt(match[1]!);
  const frac = match[2] ?? "";
  if (whole === 0n && /^0*$/.test(frac)) return null;
  return whole * 10n ** 8n + (frac === "" ? 0n : BigInt(frac) * 10n ** BigInt(8 - frac.length));
}

/**
 * Line gross in minor units, half-up on fractional quantities — the same
 * rounding the posting kernel uses, so economics weights agree with documents.
 */
export function channelLineGrossMinor(priceMinor: bigint, quantity: string): bigint {
  const weight = parseQuantityWeight(quantity);
  if (weight === null) return priceMinor;
  return (2n * priceMinor * weight + 100000000n) / 200000000n;
}

/** Exact 4dp decimal text (ledger/numeric columns) to minor units. */
export function decimalToMinorUnits(amount: string, minorUnits: number): bigint {
  return roundDiv(toUnits(amount), 10n ** BigInt(4 - minorUnits));
}

/** Ten decimal places: the storage scale of every fx rate this file applies. */
const RATE_SCALE_UNITS = 10n ** 10n;

/**
 * Parse a decimal rate into exact ten-decimal units. Commerce refuses its
 * own rate vocabulary (a CommerceError naming the cost), because a coerced
 * rate would silently reprice the margin.
 */
function parseRateUnits(rate: string, label: string): bigint {
  const match = /^\+?(\d+)(?:\.(\d{1,10}))?$/.exec(rate.trim());
  if (!match) {
    refuse(
      "economics_rate_invalid",
      `Order economics cannot price ${label} at exchange rate ${JSON.stringify(rate)}.`,
      "Record the rate as a positive decimal with at most ten places, then recompute the order's economics.",
    );
  }
  const units = BigInt(match[1]!) * RATE_SCALE_UNITS + BigInt((match[2] ?? "").padEnd(10, "0"));
  if (units <= 0n) {
    refuse(
      "economics_rate_invalid",
      `Order economics cannot price ${label} at a zero exchange rate.`,
      "Record the rate as a positive decimal, then recompute the order's economics.",
    );
  }
  return units;
}

/**
 * Apply a rate to foreign minor units, exact bigint math, halves away from
 * zero like the ledger: value = amount × rate ÷ 10^10, restated from the
 * cost precision into the order precision.
 */
function convertAtRate(amountMinor: bigint, amountExponent: number, rateUnits: bigint, targetExponent: number): bigint {
  return roundDiv(
    amountMinor * rateUnits * 10n ** BigInt(targetExponent),
    RATE_SCALE_UNITS * 10n ** BigInt(amountExponent),
  );
}

export interface ConvertedCost {
  minor: bigint;
  currency: string;
  /** Original currency and rate evidence, appended to the source ref when converted. */
  evidenceSuffix: string | null;
}

async function foreignExponent(cache: Map<string, number>, code: string): Promise<number> {
  let exponent = cache.get(code);
  if (exponent === undefined) {
    exponent = await minorUnitsForCurrency(code);
    cache.set(code, exponent);
  }
  return exponent;
}

/** Convert foreign minor units at a document rate or the business-date spot (see convertCostAmount). */
async function convertMinorCost(
  foreignMinor: bigint,
  amountCurrency: string,
  orderCurrency: string,
  orderMinorUnits: number,
  cache: Map<string, number>,
  fx: { orgId: string; asOf: string; documentRate: string | null },
): Promise<ConvertedCost> {
  const code = amountCurrency.toUpperCase();
  if (code === orderCurrency || foreignMinor === 0n) {
    return { minor: foreignMinor, currency: orderCurrency, evidenceSuffix: null };
  }
  const exponent = await foreignExponent(cache, code);
  const documentRate = fx.documentRate?.trim() ? fx.documentRate.trim() : null;
  if (documentRate) {
    const units = parseRateUnits(documentRate, `the ${code} cost`);
    return {
      minor: convertAtRate(foreignMinor, exponent, units, orderMinorUnits),
      currency: orderCurrency,
      evidenceSuffix: `${code}@${documentRate}`,
    };
  }
  const spot = await lookupSpotRate(db, fx.orgId, code, orderCurrency, fx.asOf);
  if (!spot) {
    return { minor: foreignMinor, currency: code, evidenceSuffix: null };
  }
  const units = parseRateUnits(spot, `the ${code} cost on ${fx.asOf}`);
  return {
    minor: convertAtRate(foreignMinor, exponent, units, orderMinorUnits),
    currency: orderCurrency,
    evidenceSuffix: `${code}@${spot}`,
  };
}

/**
 * Convert a cost into the order's currency. Same-currency costs convert at
 * the order precision; a foreign-currency cost converts at its source
 * document's rate when that rate quotes cost→order directly, else at the
 * business-date spot (the order's day) from the fx module — and the CM sums
 * include it, with the original currency and rate kept as evidence on the
 * source ref. When no rate exists the cost keeps its own currency and stays
 * out of the sums (flagged by mixedCurrency) instead of blocking the
 * posting: recording the rate restates the order.
 */
async function convertCostAmount(
  amountText: string,
  amountCurrency: string | null,
  orderCurrency: string,
  orderMinorUnits: number,
  cache: Map<string, number>,
  fx: { orgId: string; asOf: string; documentRate: string | null },
): Promise<ConvertedCost> {
  const code = (amountCurrency ?? orderCurrency).toUpperCase();
  if (code === orderCurrency) {
    return { minor: decimalToMinorUnits(amountText, orderMinorUnits), currency: orderCurrency, evidenceSuffix: null };
  }
  const exponent = await foreignExponent(cache, code);
  return convertMinorCost(decimalToMinorUnits(amountText, exponent), code, orderCurrency, orderMinorUnits, cache, fx);
}

/** Tenant minor-unit precision; an unknown currency refuses instead of converting dust. */
export async function minorUnitsForCurrency(currency: string): Promise<number> {
  const row = (await db.execute<{ minor_units: number }>(sql`
    select minor_units from currencies where code = ${currency}`)).rows[0];
  const minorUnits = row?.minor_units;
  if (minorUnits == null || !Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    refuse(
      "currency_unsupported",
      `Order economics cannot price in ${currency}: the currency has no supported minor-unit precision.`,
      "Price the storefront order in a supported billing currency, then recompute its economics.",
      "shopCurrency",
    );
  }
  return minorUnits;
}

/**
 * A payout fee row that reads like a marketplace exaction (a commission or
 * referral the channel kept) rather than card processing. Unknown fee types
 * stay processor fees: misclassifying processing as commission would hide
 * the true card cost, while the reverse only moves a row between fee lines.
 */
function isMarketplaceFeeType(shopifyType: string | undefined): boolean {
  const kind = (shopifyType ?? "").toLowerCase();
  return kind.includes("commission") || kind.includes("marketplace") || kind.includes("referral");
}

interface RevenueLine {
  key: string;
  gross: bigint;
  itemId: string | null;
  sku: string | null;
  promotionCode: string | null;
  qtyWeight: bigint;
}

/** Match a channel line to its native item: variant link first, then SKU. */
async function lookupChannelLineItem(
  orgId: string,
  provider: string,
  externalAccount: string,
  line: ChannelOrderLine,
): Promise<string | null> {
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
      if (item) return item.id;
    }
  }
  const sku = typeof line.sku === "string" && line.sku.trim() !== "" ? line.sku.trim() : null;
  if (sku) {
    const item = (await db.execute<{ id: string }>(sql`
      select id from items where org_id = ${orgId} and code = ${sku} and is_active
       order by created_at limit 1`)).rows[0];
    if (item) return item.id;
  }
  return null;
}

async function channelProvider(orgId: string, channelId: string): Promise<{ kind: string; externalAccount: string }> {
  const row = (await db.execute<{ kind: string; external_account: string }>(sql`
    select kind, external_account from sales_channels where org_id = ${orgId} and id = ${channelId}`)).rows[0];
  if (!row) {
    refuse(
      "channel_not_found",
      "The sales channel does not belong to this organization.",
      "Choose a channel in this organization, or connect it first under Channels.",
      "channelId",
    );
  }
  return { kind: row.kind, externalAccount: row.external_account };
}

async function buildRevenueLines(
  orgId: string,
  order: ChannelOrderDetail,
): Promise<RevenueLine[]> {
  const channel = await channelProvider(orgId, order.channelId);
  const lines: RevenueLine[] = [];
  let index = -1;
  for (const line of order.lines) {
    index += 1;
    // Gift card sales credit the stored-value liability, never revenue, so
    // they carry no margin facts of their own.
    if (line.giftCard) continue;
    const gross = channelLineGrossMinor(line.priceMinor, line.quantity);
    lines.push({
      key: `line:${index}`,
      gross,
      itemId: await lookupChannelLineItem(orgId, channel.kind, channel.externalAccount, line),
      sku: line.sku,
      promotionCode: line.discountCode,
      qtyWeight: parseQuantityWeight(line.quantity) ?? gross,
    });
  }
  let shipIndex = -1;
  for (const ship of order.shippingLines) {
    shipIndex += 1;
    lines.push({
      key: `ship:${shipIndex}`,
      gross: ship.amountMinor,
      itemId: null,
      sku: null,
      promotionCode: null,
      qtyWeight: ship.amountMinor,
    });
  }
  return lines;
}

/**
 * Split a signed total across revenue lines by gross value so the parts sum
 * EXACTLY to the total. Lines with no value share nothing: a zero-weight
 * total books to the order-level row instead of dividing by zero.
 */
export function allocateAcrossLines(
  totalMinor: bigint,
  lines: RevenueLine[],
  makeRow: (line: RevenueLine | null, amountMinor: bigint) => EconomicsFactInput,
): EconomicsFactInput[] {
  const weights = lines.map((line) => (line.gross > 0n ? line.gross : 0n));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightTotal === 0n || totalMinor === 0n) {
    if (totalMinor === 0n) return [];
    return [makeRow(null, totalMinor)];
  }
  const parts = apportion(totalMinor < 0n ? -totalMinor : totalMinor, weights);
  return lines.map((line, at) => makeRow(line, totalMinor < 0n ? -parts[at]! : parts[at]!));
}

export interface RefundLineInput {
  docLineId: string;
  itemId: string | null;
  /** Signed minor units: revenue reversals negative, fee charges negated before entry. */
  amountMinor: bigint;
  isRestockingFee: boolean;
}

export interface AttributedRefund {
  lineKey: string;
  component: "returns" | "restocking_fee";
  amountMinor: bigint;
  sourceRef: string;
}

/**
 * Attribute posted refund lines to channel lines. Lines sharing the refunded
 * item split by quantity weight; a refund no channel line can take (an
 * unmatched item, a discount-only reversal) books to the order-level row so
 * the margin still moves. Restocking fees arrive as negative credit lines
 * and are negated into positive margin contributions, attributed across the
 * lines that were returned — or every revenue line when nothing matched.
 */
export function attributeRefundLines(
  refundLines: RefundLineInput[],
  revenueLines: RevenueLine[],
): AttributedRefund[] {
  const attributed: AttributedRefund[] = [];
  const returns = refundLines.filter((line) => !line.isRestockingFee);
  const fees = refundLines.filter((line) => line.isRestockingFee);
  const returnedKeys = new Set<string>();
  for (const line of returns) {
    const candidates = revenueLines.filter((revenue) =>
      line.itemId !== null && revenue.itemId !== null && revenue.itemId === line.itemId,
    );
    if (candidates.length === 0) {
      attributed.push({ lineKey: "order", component: "returns", amountMinor: line.amountMinor, sourceRef: `refund:${line.docLineId}` });
      continue;
    }
    const weights = candidates.map((candidate) => candidate.qtyWeight);
    const magnitude = line.amountMinor < 0n ? -line.amountMinor : line.amountMinor;
    const parts = apportion(magnitude, weights);
    candidates.forEach((candidate, at) => {
      if (parts[at] === 0n) return;
      returnedKeys.add(candidate.key);
      attributed.push({
        lineKey: candidate.key,
        component: "returns",
        amountMinor: line.amountMinor < 0n ? -parts[at]! : parts[at]!,
        sourceRef: `refund:${line.docLineId}`,
      });
    });
  }
  for (const fee of fees) {
    // The credit line charges the fee (negative); the margin earns it back.
    const earned = fee.amountMinor < 0n ? -fee.amountMinor : fee.amountMinor;
    if (earned === 0n) continue;
    const targets = returnedKeys.size > 0
      ? revenueLines.filter((revenue) => returnedKeys.has(revenue.key))
      : revenueLines;
    const weights = targets.map((target) => (target.gross > 0n ? target.gross : 0n));
    if (targets.length === 0 || weights.reduce((sum, weight) => sum + weight, 0n) === 0n) {
      attributed.push({ lineKey: "order", component: "restocking_fee", amountMinor: earned, sourceRef: `refund:${fee.docLineId}` });
      continue;
    }
    const parts = apportion(earned, weights);
    targets.forEach((target, at) => {
      if (parts[at] === 0n) return;
      attributed.push({ lineKey: target.key, component: "restocking_fee", amountMinor: parts[at]!, sourceRef: `refund:${fee.docLineId}` });
    });
  }
  return attributed;
}

type SettlementRow = {
  line_number: number;
  kind: string;
  external_ref: string | null;
  amount: string;
  currency: string | null;
  meta: unknown;
  batch_id: string;
  batch_currency: string;
};

interface SettledFee {
  amountText: string;
  currency: string;
  marketplace: boolean;
  sourceRef: string;
  /** The line's evidenced rate into the batch currency, when the provider reported one. */
  exchangeRate: string | null;
  batchCurrency: string;
}

/**
 * Settled order costs from payout content: every charge or refund row naming
 * this order contributes its sibling fee rows (`<id>_fee` in the same
 * batch). Shopify's parser never links settlement lines to documents, so
 * the order thread is the provider's own source order id.
 */
async function loadSettledOrderFees(orgId: string, orderExternalId: string): Promise<SettledFee[]> {
  const rows = (await db.execute<SettlementRow>(sql`
    select l.line_number, l.kind, l.external_ref, l.amount::text as amount, l.currency,
           l.meta, l.batch_id, b.currency as batch_currency
      from psp_settlement_lines l
      join psp_settlement_batches b on b.id = l.batch_id and b.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.kind in ('charge', 'refund')
       and l.meta->>'sourceOrderId' = ${orderExternalId}`)).rows;
  const fees: SettledFee[] = [];
  for (const row of rows) {
    if (!row.external_ref) continue;
    const siblings = (await db.execute<SettlementRow>(sql`
      select l.line_number, l.kind, l.external_ref, l.amount::text as amount, l.currency,
             l.meta, l.batch_id, b.currency as batch_currency
        from psp_settlement_lines l
        join psp_settlement_batches b on b.id = l.batch_id and b.org_id = l.org_id
       where l.org_id = ${orgId} and l.batch_id = ${row.batch_id}
         and l.kind = 'fee' and l.external_ref = ${`${row.external_ref}_fee`}`)).rows;
    for (const sibling of siblings) {
      const meta = (sibling.meta ?? {}) as Record<string, unknown>;
      const exchangeRate = typeof meta["exchangeRate"] === "string" ? meta["exchangeRate"] : null;
      fees.push({
        amountText: sibling.amount,
        currency: (sibling.currency ?? row.currency ?? "").toUpperCase(),
        marketplace: isMarketplaceFeeType(typeof meta["shopifyType"] === "string" ? meta["shopifyType"] : undefined),
        sourceRef: `settle:${sibling.batch_id}:${sibling.line_number}`,
        exchangeRate,
        batchCurrency: sibling.batch_currency.toUpperCase(),
      });
    }
  }
  return fees;
}

type LabelRow = {
  id: string;
  rate_minor: bigint;
  rate_currency: string;
};

/**
 * Carrier cost per purchased label charged to the order's posted document,
 * grouped by currency: the bought rate plus every posted billing adjustment
 * on the label. A voided label leaves the set, so its facts withdraw and
 * history shows the reversal.
 */
async function loadLabelCosts(orgId: string, postingDocumentId: string | null): Promise<LabelRow[]> {
  if (!postingDocumentId) return [];
  type RawLabel = { id: string; rate_minor: string; rate_currency: string };
  const labels = (await db.execute<RawLabel>(sql`
    select id, rate_minor::text, rate_currency from shipment_labels
     where org_id = ${orgId} and order_document_id = ${postingDocumentId} and status = 'purchased'`)).rows;
  // Posted billing adjustments join the label's cost in their own currency,
  // so a correction restates the order instead of hiding beside the rate.
  type RawAdjustment = { label_id: string; currency: string; total: string };
  const adjustments = (await db.execute<RawAdjustment>(sql`
    select a.label_id, a.currency, sum(a.amount_minor)::text as total
      from shipping_adjustments a
      join shipment_labels l on l.id = a.label_id and l.org_id = a.org_id
     where a.org_id = ${orgId} and l.order_document_id = ${postingDocumentId} and l.status = 'purchased'
       and a.status = 'posted'
     group by a.label_id, a.currency`)).rows;
  const costs = new Map<string, LabelRow>();
  for (const label of labels) {
    costs.set(`${label.id}|${label.rate_currency}`, {
      id: label.id,
      rate_minor: asMinorUnits(label.rate_minor),
      rate_currency: label.rate_currency,
    });
  }
  for (const adjustment of adjustments) {
    const total = BigInt(adjustment.total);
    if (total === 0n) continue;
    const key = `${adjustment.label_id}|${adjustment.currency}`;
    const existing = costs.get(key);
    if (existing) existing.rate_minor += total;
    else costs.set(key, { id: adjustment.label_id, rate_minor: total, rate_currency: adjustment.currency });
  }
  return [...costs.values()].filter((cost) => cost.rate_minor !== 0n);
}

type IssueRow = {
  item_id: string;
  total: string;
};

type SummaryOrderWeight = { orderId: string; weight: bigint };

/**
 * Every summarized order's quantity weight per item, for splitting the
 * summary cash sale's issue costs back to the orders it summarizes. Items
 * resolve exactly like the per-order path (variant link, then SKU), settled
 * set-wise instead of line by line; an unreadable quantity takes no
 * quantity share. Siblings read oldest first so the largest-remainder split
 * below is deterministic for identical data.
 */
async function loadSummaryItemWeights(
  orgId: string,
  channel: { kind: string; externalAccount: string },
  summaryId: string,
): Promise<Map<string, SummaryOrderWeight[]>> {
  const siblings = (await db.execute<{ id: string; lines: unknown }>(sql`
    select id, lines from channel_orders
     where org_id = ${orgId} and summary_id = ${summaryId}
     order by id`)).rows;
  type ParsedLine = { orderId: string; sku: string | null; variantExternalId: string | null; quantity: string };
  const parsed: ParsedLine[] = [];
  for (const sibling of siblings) {
    if (!Array.isArray(sibling.lines)) continue;
    for (const raw of sibling.lines as Record<string, unknown>[]) {
      if (raw["giftCard"] === true) continue;
      const quantity = typeof raw["quantity"] === "string" ? raw["quantity"] : null;
      if (!quantity) continue;
      const sku = typeof raw["sku"] === "string" && raw["sku"].trim() !== "" ? raw["sku"].trim() : null;
      const variantExternalId = typeof raw["variantExternalId"] === "string" && raw["variantExternalId"].trim() !== ""
        ? raw["variantExternalId"].trim()
        : null;
      parsed.push({ orderId: sibling.id, sku, variantExternalId, quantity });
    }
  }
  const itemByVariant = new Map<string, string>();
  const variantIds = [...new Set(parsed.map((line) => line.variantExternalId).filter((id): id is string => id !== null))];
  if (variantIds.length > 0) {
    const links = (await db.execute<{ external_id: string; native_id: string }>(sql`
      select l.external_id, l.native_id from external_links l
      join items i on i.org_id = l.org_id and i.id = l.native_id and i.is_active
     where l.org_id = ${orgId} and l.provider = ${channel.kind}
       and l.external_account = ${channel.externalAccount}
       and l.object_type = 'variant' and l.native_table = 'items'
       and l.external_id in (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})`)).rows;
    for (const link of links) itemByVariant.set(link.external_id, link.native_id);
  }
  const itemBySku = new Map<string, string>();
  const skus = [...new Set(parsed.map((line) => line.sku).filter((sku): sku is string => sku !== null))];
  if (skus.length > 0) {
    const found = (await db.execute<{ code: string; id: string }>(sql`
      select distinct on (code) code, id from items
       where org_id = ${orgId} and is_active and code in (${sql.join(skus.map((sku) => sql`${sku}`), sql`, `)})
       order by code, created_at`)).rows;
    for (const row of found) itemBySku.set(row.code, row.id);
  }
  // One entry per order: an order spreading an item across priced lines still
  // takes a single quantity share, split across its own lines afterwards.
  const combined = new Map<string, Map<string, bigint>>();
  for (const line of parsed) {
    const itemId = (line.variantExternalId && itemByVariant.get(line.variantExternalId))
      ?? (line.sku && itemBySku.get(line.sku))
      ?? null;
    if (!itemId) continue;
    const weight = parseQuantityWeight(line.quantity) ?? 0n;
    if (weight === 0n) continue;
    const perOrder = combined.get(itemId) ?? new Map<string, bigint>();
    perOrder.set(line.orderId, (perOrder.get(line.orderId) ?? 0n) + weight);
    combined.set(itemId, perOrder);
  }
  const weights = new Map<string, SummaryOrderWeight[]>();
  for (const [itemId, perOrder] of combined) {
    weights.set(itemId, [...perOrder].map(([orderId, weight]) => ({ orderId, weight })));
  }
  return weights;
}

/** The summary batch's posted cash sale carrying a summarized order's issues, if posted. */
async function summaryPostingDocument(orgId: string, summaryId: string): Promise<string | null> {
  const row = (await db.execute<{ posting_document_id: string | null }>(sql`
    select posting_document_id from channel_daily_summaries
     where org_id = ${orgId} and id = ${summaryId}`)).rows[0];
  return row?.posting_document_id ?? null;
}

/**
 * Actual issue cost per item for the posted document, summed across every
 * FIFO layer the issue consumed. Returns carry the original issue movement
 * id on the credit line and are handled as returns, never netted here.
 */
async function loadIssueCosts(orgId: string, postingDocumentId: string | null): Promise<IssueRow[]> {
  if (!postingDocumentId) return [];
  return (await db.execute<IssueRow>(sql`
    select dl.item_id, sum(m.total_value)::text as total
      from document_lines dl
      join inventory_movements m on m.document_line_id = dl.id and m.org_id = dl.org_id
     where dl.org_id = ${orgId} and dl.document_id = ${postingDocumentId}
       and dl.item_id is not null and m.kind = 'issue' and m.total_value is not null
     group by dl.item_id`)).rows;
}

type RefundDocRow = {
  id: string;
  line_id: string;
  item_id: string | null;
  amount: string;
  currency: string;
  description: string;
};

/** Posted cash-refund lines against this order's refund events. */
async function loadRefundLines(orgId: string, orderId: string): Promise<RefundDocRow[]> {
  return (await db.execute<RefundDocRow>(sql`
    select d.id, dl.id as line_id, dl.item_id, dl.amount::text as amount, d.currency, dl.description
      from channel_order_events e
      join documents d on d.id = e.posting_document_id and d.org_id = e.org_id
      join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
     where e.org_id = ${orgId} and e.order_id = ${orderId} and e.kind = 'refund'
       and e.posting_document_id is not null and d.status = 'posted'`)).rows;
}

type SpendRow = {
  id: string;
  amount_minor: bigint;
  currency: string;
};

/** Imported marketing spend for the channel on the order's UTC day. */
async function loadDayAdSpend(orgId: string, channelId: string, orderDay: string): Promise<SpendRow[]> {
  const rows = (await db.execute<SpendRow>(sql`
    select id, amount_minor, currency from channel_ad_spend
     where org_id = ${orgId} and channel_id = ${channelId} and spend_date = ${orderDay}::date`)).rows;
  return rows.map((row) => ({ ...row, amount_minor: asMinorUnits(row.amount_minor) }));
}

type DayRevenueRow = {
  order_id: string;
  revenue: string;
};

/** Current net revenue per channel order of the day, for ad spend weights. */
async function loadDayRevenue(orgId: string, channelId: string, orderDay: string): Promise<DayRevenueRow[]> {
  return (await db.execute<DayRevenueRow>(sql`
    select f.order_id, sum(case when f.component = 'discount' then f.amount_minor else 0 end
      + case when f.component = 'net_revenue' then f.amount_minor else 0 end)::text as revenue
      from channel_order_economics f
      join channel_orders o on o.id = f.order_id and o.org_id = f.org_id
     where f.org_id = ${orgId} and f.channel_id = ${channelId} and f.is_current
       and (o.ordered_at at time zone 'UTC')::date = ${orderDay}::date
     group by f.order_id`)).rows;
}

/**
 * The channel's trailing realized fee rate: settled processor fees over net
 * revenue across current facts, excluding the order being estimated so a big
 * order cannot set its own rate.
 */
async function loadRealizedFeeRate(
  orgId: string,
  channelId: string,
  excludeOrderId: string,
): Promise<{ fee: bigint; revenue: bigint } | null> {
  const row = (await db.execute<{ fee: string; revenue: string }>(sql`
    select coalesce(sum(case when f.component = 'processor_fee' and not f.estimated then -f.amount_minor else 0 end), 0)::text as fee,
           coalesce(sum(case when f.component in ('net_revenue', 'discount') then f.amount_minor else 0 end), 0)::text as revenue
      from channel_order_economics f
     where f.org_id = ${orgId} and f.channel_id = ${channelId} and f.is_current
       and f.order_id <> ${excludeOrderId}
       and f.as_of > now() - interval '90 days'`)).rows[0];
  if (!row) return null;
  const fee = BigInt(row.fee);
  const revenue = BigInt(row.revenue);
  if (fee <= 0n || revenue <= 0n) return null;
  return { fee, revenue };
}

/**
 * Recompute one order's desired facts from every source: the order's own
 * lines (revenue, discounts), the posted issue layers (COGS), purchased
 * carrier labels, settled payout fees (or a channel-rate estimate until they
 * settle), posted refunds with restocking income, and the day's imported ad
 * spend. Redemption of bought stored value settles a liability and funds no
 * order cost, so it writes no funding fact; promotional funding will when it
 * carries its own evidence.
 */
async function buildDesiredFacts(
  orgId: string,
  order: ChannelOrderDetail,
  revenueLines: RevenueLine[],
  minorUnits: number,
): Promise<EconomicsFactInput[]> {
  const desired: EconomicsFactInput[] = [];
  const currency = order.shopCurrency;
  let lineIndex = -1;
  for (const line of order.lines) {
    lineIndex += 1;
    if (line.giftCard) continue;
    const revenue = revenueLines.find((candidate) => candidate.key === `line:${lineIndex}`);
    if (!revenue) continue;
    const gross = channelLineGrossMinor(line.priceMinor, line.quantity);
    desired.push({
      lineKey: revenue.key, component: "net_revenue", sourceKind: "posting", sourceRef: "",
      currency, amountMinor: gross, itemId: revenue.itemId, sku: revenue.sku,
      promotionCode: revenue.promotionCode, estimated: false,
    });
    if (line.discountMinor > 0n) {
      desired.push({
        lineKey: revenue.key, component: "discount", sourceKind: "posting", sourceRef: "",
        currency, amountMinor: -line.discountMinor, itemId: revenue.itemId, sku: revenue.sku,
        promotionCode: revenue.promotionCode, estimated: false,
      });
    }
  }
  let shipIndex = -1;
  for (const ship of order.shippingLines) {
    shipIndex += 1;
    const revenue = revenueLines.find((candidate) => candidate.key === `ship:${shipIndex}`);
    if (!revenue) continue;
    desired.push({
      lineKey: revenue.key, component: "net_revenue", sourceKind: "posting", sourceRef: "",
      currency, amountMinor: ship.amountMinor, itemId: null, sku: null,
      promotionCode: null, estimated: false,
    });
    if (ship.discountMinor > 0n) {
      desired.push({
        lineKey: revenue.key, component: "discount", sourceKind: "posting", sourceRef: "",
        currency, amountMinor: -ship.discountMinor, itemId: null, sku: null,
        promotionCode: null, estimated: false,
      });
    }
  }
  // Actual issue cost. A per-order sale attributes its own document's issues;
  // a summarized order takes its quantity-proportioned share of the summary
  // cash sale's issues — an exact minor-unit split (largest remainder) first
  // across the summarized orders, then across this order's own lines.
  const pushCogsShare = (share: bigint, sourceRef: string, takers: RevenueLine[]): void => {
    if (share === 0n || takers.length === 0) return;
    const magnitude = share < 0n ? -share : share;
    const parts = apportion(magnitude, takers.map((taker) => taker.qtyWeight));
    takers.forEach((taker, at) => {
      if (parts[at] === 0n) return;
      desired.push({
        lineKey: taker.key, component: "cogs", sourceKind: "posting", sourceRef,
        currency, amountMinor: share < 0n ? -parts[at]! : parts[at]!,
        itemId: taker.itemId, sku: taker.sku, promotionCode: taker.promotionCode, estimated: false,
      });
    });
  };
  const issueDocumentId = order.postingDocumentId
    ?? (order.summaryId ? await summaryPostingDocument(orgId, order.summaryId) : null);
  if (issueDocumentId) {
    const summaryShares = order.postingDocumentId || !order.summaryId
      ? null
      : await loadSummaryItemWeights(orgId, await channelProvider(orgId, order.channelId), order.summaryId);
    for (const issue of await loadIssueCosts(orgId, issueDocumentId)) {
      const total = decimalToMinorUnits(issue.total, minorUnits);
      if (total === 0n) continue;
      const takers = revenueLines.filter((line) => line.itemId !== null && line.itemId === issue.item_id);
      if (takers.length === 0) continue;
      if (!summaryShares) {
        pushCogsShare(total, `posting:${issueDocumentId}`, takers);
        continue;
      }
      const vector = summaryShares.get(issue.item_id) ?? [];
      const at = vector.findIndex((entry) => entry.orderId === order.id);
      if (at < 0) continue;
      if (vector.every((entry) => entry.weight === 0n)) continue;
      const parts = apportion(total < 0n ? -total : total, vector.map((entry) => entry.weight));
      pushCogsShare(total < 0n ? -parts[at]! : parts[at]!, `posting:${issueDocumentId}`, takers);
    }
  }
  const orderDay = order.orderedAt.slice(0, 10);
  const fxFor = (documentRate: string | null): { orgId: string; asOf: string; documentRate: string | null } =>
    ({ orgId, asOf: orderDay, documentRate });
  const fxCache = new Map<string, number>();
  // Carrier labels arrive in minor units already, each allocated across the
  // order's lines by value. A foreign-currency label converts at the
  // business-date spot into the order currency; only a label no rate can
  // price keeps its currency and stays out of the sums.
  for (const label of await loadLabelCosts(orgId, order.postingDocumentId)) {
    if (label.rate_minor === 0n) continue;
    const converted = await convertMinorCost(
      label.rate_minor, label.rate_currency, currency, minorUnits, fxCache, fxFor(null),
    );
    if (converted.minor === 0n) continue;
    const sourceRef = converted.evidenceSuffix
      ? `label:${label.id}:${converted.evidenceSuffix}`
      : `label:${label.id}:${label.rate_currency}`;
    for (const row of allocateAcrossLines(-converted.minor, revenueLines, (line, amount) => ({
      lineKey: line?.key ?? "order", component: "shipping_label", sourceKind: "label",
      sourceRef, currency: converted.currency, amountMinor: amount,
      itemId: line?.itemId ?? null, sku: line?.sku ?? null,
      promotionCode: line?.promotionCode ?? null, estimated: false,
    }))) {
      desired.push(row);
    }
  }
  // Settled payout fees, or the channel's realized rate until they settle. A
  // fee in another currency converts at its settlement line's evidenced rate
  // when that rate quotes into the order currency, else at the spot.
  const settled = await loadSettledOrderFees(orgId, order.externalId);
  let settledFeeMinor = 0n;
  for (const fee of settled) {
    const documentRate = fee.exchangeRate && fee.batchCurrency === currency ? fee.exchangeRate : null;
    const converted = await convertCostAmount(fee.amountText, fee.currency, currency, minorUnits, fxCache, fxFor(documentRate));
    if (converted.minor === 0n) continue;
    const component = fee.marketplace ? "marketplace_fee" : "processor_fee";
    if (!fee.marketplace && converted.currency === currency) settledFeeMinor += converted.minor;
    const sourceRef = converted.evidenceSuffix
      ? `${fee.sourceRef}:${converted.evidenceSuffix}`
      : `${fee.sourceRef}:${converted.currency}`;
    for (const row of allocateAcrossLines(-converted.minor, revenueLines, (line, amount) => ({
      lineKey: line?.key ?? "order", component, sourceKind: "payout",
      sourceRef, currency: converted.currency, amountMinor: amount,
      itemId: line?.itemId ?? null, sku: line?.sku ?? null,
      promotionCode: line?.promotionCode ?? null, estimated: false,
    }))) {
      desired.push(row);
    }
  }
  if (settledFeeMinor === 0n) {
    const rate = await loadRealizedFeeRate(orgId, order.channelId, order.id);
    if (rate) {
      const orderRevenue = revenueLines.reduce((sum, line) => sum + line.gross, 0n)
        + desired.filter((row) => row.component === "discount").reduce((sum, row) => sum + row.amountMinor, 0n);
      if (orderRevenue > 0n) {
        const estimate = roundDiv(orderRevenue * rate.fee, rate.revenue);
        for (const row of allocateAcrossLines(-estimate, revenueLines, (line, amount) => ({
          lineKey: line?.key ?? "order", component: "processor_fee", sourceKind: "estimate",
          sourceRef: "rate:channel", currency, amountMinor: amount,
          itemId: line?.itemId ?? null, sku: line?.sku ?? null,
          promotionCode: line?.promotionCode ?? null, estimated: true,
        }))) {
          desired.push(row);
        }
      }
    }
  }
  // Posted refunds with restocking income, attributed to the lines returned.
  // A refund in another currency converts at the business-date spot; only a
  // refund no rate can price keeps its currency instead of joining the sums.
  const refundRows = await loadRefundLines(orgId, order.id);
  if (refundRows.length > 0) {
    const byCurrency = new Map<string, RefundDocRow[]>();
    for (const row of refundRows) {
      const code = row.currency.toUpperCase();
      byCurrency.set(code, [...(byCurrency.get(code) ?? []), row]);
    }
    for (const group of byCurrency.values()) {
      const inputs: RefundLineInput[] = [];
      let groupCurrency = currency;
      let groupSuffix: string | null = null;
      for (const row of group) {
        const converted = await convertCostAmount(row.amount, row.currency, currency, minorUnits, fxCache, fxFor(null));
        groupCurrency = converted.currency;
        groupSuffix = converted.evidenceSuffix;
        inputs.push({
          docLineId: row.line_id,
          itemId: row.item_id,
          amountMinor: converted.minor,
          isRestockingFee: row.description.startsWith("Restocking fee"),
        });
      }
      for (const attributed of attributeRefundLines(inputs, revenueLines)) {
        const taker = revenueLines.find((line) => line.key === attributed.lineKey) ?? null;
        desired.push({
          lineKey: attributed.lineKey, component: attributed.component, sourceKind: "refund",
          sourceRef: groupSuffix ? `${attributed.sourceRef}:${groupSuffix}` : attributed.sourceRef,
          currency: groupCurrency, amountMinor: attributed.amountMinor,
          itemId: taker?.itemId ?? null, sku: taker?.sku ?? null,
          promotionCode: taker?.promotionCode ?? null, estimated: false,
        });
      }
    }
  }
  // The day's imported ad spend, shared across the day's orders by revenue.
  // Foreign-currency spend converts at the day's spot like every other cost.
  const spends = await loadDayAdSpend(orgId, order.channelId, orderDay);
  if (spends.length > 0) {
    const dayRevenue = await loadDayRevenue(orgId, order.channelId, orderDay);
    const weights = new Map(dayRevenue.map((row) => [row.order_id, BigInt(row.revenue)]));
    const weightTotal = [...weights.values()].reduce((sum, weight) => sum + (weight > 0n ? weight : 0n), 0n);
    const ownRevenue = weights.get(order.id) ?? 0n;
    if (weightTotal > 0n && ownRevenue > 0n) {
      for (const spend of spends) {
        if (spend.amount_minor === 0n) continue;
        // Nearest-unit shares; any dust below one minor unit per order stays
        // unallocated rather than invented on a line.
        const share = roundDiv(spend.amount_minor * ownRevenue, weightTotal);
        if (share === 0n) continue;
        const converted = await convertMinorCost(
          share, spend.currency, currency, minorUnits, fxCache, fxFor(null),
        );
        if (converted.minor === 0n) continue;
        const sourceRef = converted.evidenceSuffix
          ? `adspend:${spend.id}:${converted.evidenceSuffix}`
          : `adspend:${spend.id}`;
        for (const row of allocateAcrossLines(-converted.minor, revenueLines, (line, amount) => ({
          lineKey: line?.key ?? "order", component: "ad_spend", sourceKind: "import",
          sourceRef, currency: converted.currency, amountMinor: amount,
          itemId: line?.itemId ?? null, sku: line?.sku ?? null,
          promotionCode: line?.promotionCode ?? null, estimated: false,
        }))) {
          desired.push(row);
        }
      }
    }
  }
  return desired;
}

type StoredFact = {
  id: string;
  line_key: string;
  component: string;
  source_kind: string;
  source_ref: string;
  currency: string;
  amount_minor: bigint;
  item_id: string | null;
  sku: string | null;
  promotion_code: string | null;
  estimated: boolean;
  version: number;
};

function factKey(fact: { lineKey: string; component: string; sourceKind: string; sourceRef: string }): string {
  return `${fact.lineKey}|${fact.component}|${fact.sourceKind}|${fact.sourceRef}`;
}

function sameFact(current: StoredFact, desired: EconomicsFactInput): boolean {
  return current.currency === desired.currency
    && current.amount_minor === desired.amountMinor
    && current.estimated === desired.estimated
    && (current.item_id ?? null) === desired.itemId
    && (current.sku ?? null) === desired.sku
    && (current.promotion_code ?? null) === desired.promotionCode;
}

/**
 * Reconcile desired facts against current rows inside the caller's org
 * context: unchanged rows stand, changed rows restate as a new version with
 * the old row retired, and vanished rows (a voided label, an estimate the
 * settlement replaced) retire with history kept. Every retiring update
 * checks its row count: under row-level security a zero-row write is a
 * failure, never a success.
 */
async function writeFacts(
  orgId: string,
  actor: string | null,
  order: ChannelOrderDetail,
  desired: EconomicsFactInput[],
): Promise<{ inserted: number; retired: number }> {
  const current = (await db.execute<StoredFact>(sql`
    select id, line_key, component, source_kind, source_ref, currency, amount_minor,
           item_id, sku, promotion_code, estimated, version
      from channel_order_economics
     where org_id = ${orgId} and order_id = ${order.id} and is_current`)).rows
    .map((row) => ({ ...row, amount_minor: asMinorUnits(row.amount_minor) }));
  const byKey = new Map(current.map((row) => [factKey({
    lineKey: row.line_key, component: row.component, sourceKind: row.source_kind, sourceRef: row.source_ref,
  }), row]));
  let inserted = 0;
  let retired = 0;
  const seen = new Set<string>();
  for (const want of desired) {
    const key = factKey(want);
    // The same (line, component, source) recomputed twice converges: a
    // duplicate inside one recompute keeps the first amount, so a doubled
    // source row can never double-book the margin.
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = byKey.get(key);
    if (existing && sameFact(existing, want)) continue;
    // Retire before inserting: the current-row uniqueness holds per (line,
    // component, source), so the new version can only land once the old row
    // leaves the current set. One transaction keeps the swap atomic.
    let supersedes: string | null = null;
    let version = 1;
    if (existing) {
      version = existing.version + 1;
      const retiring = await db.execute(sql`
        update channel_order_economics
           set is_current = false, updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${existing.id} and is_current`);
      if (retiring.rowCount !== 1) {
        throw new Error("Order economics restatement matched no row; the fact changed while it restated");
      }
      supersedes = existing.id;
      retired += 1;
    }
    const created = await db.execute<{ id: string }>(sql`
      insert into channel_order_economics
        (org_id, channel_id, order_id, line_key, component, source_kind, source_ref,
         currency, amount_minor, item_id, sku, promotion_code, estimated, version,
         created_by, updated_by)
      values (${orgId}, ${order.channelId}, ${order.id}, ${want.lineKey}, ${want.component},
        ${want.sourceKind}, ${want.sourceRef}, ${want.currency}, ${want.amountMinor.toString()},
        ${want.itemId}, ${want.sku}, ${want.promotionCode}, ${want.estimated}, ${version},
        ${actor}, ${actor})
      returning id`);
    if (created.rows.length !== 1) throw new Error("Order economics insert returned an unexpected row count");
    inserted += 1;
    if (supersedes) {
      const linked = await db.execute(sql`
        update channel_order_economics
           set superseded_by = ${created.rows[0]!.id}, updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${supersedes}`);
      if (linked.rowCount !== 1) {
        throw new Error("Order economics history link matched no row; the fact changed while it restated");
      }
    }
  }
  for (const row of current) {
    const key = factKey({
      lineKey: row.line_key, component: row.component, sourceKind: row.source_kind, sourceRef: row.source_ref,
    });
    if (seen.has(key)) continue;
    const withdrawn = await db.execute(sql`
      update channel_order_economics
         set is_current = false, updated_by = ${actor}, updated_at = now()
       where org_id = ${orgId} and id = ${row.id} and is_current`);
    if (withdrawn.rowCount !== 1) {
      throw new Error("Order economics withdrawal matched no row; the fact changed while it withdrew");
    }
    retired += 1;
  }
  return { inserted, retired };
}

/**
 * Recompute one order inside the caller's org context and transaction: the
 * posting, ingest and scan triggers call this, never the transactional
 * wrapper below, so economics joins their unit of work instead of opening
 * its own beside it.
 */
export async function recomputeOrderEconomicsScoped(
  orgId: string,
  actor: string | null,
  orderId: string,
): Promise<{ inserted: number; retired: number }> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"economics:" + orderId}, 0))`);
  const order = await loadChannelOrder(orgId, orderId);
  if (!order) {
    refuse(
      "channel_order_unknown",
      "The channel order does not belong to this organization.",
      "Choose an order from this organization's channel subledger.",
      "orderId",
    );
  }
  const minorUnits = await minorUnitsForCurrency(order.shopCurrency);
  const revenueLines = await buildRevenueLines(orgId, order);
  const desired = await buildDesiredFacts(orgId, order, revenueLines, minorUnits);
  return writeFacts(orgId, actor, order, desired);
}

/**
 * Recompute one order's margin facts from every cost source, idempotent by
 * (line, cost component, source). Posting, fulfilment, label, payout and
 * refund arrivals all converge here; replaying a recompute changes nothing.
 */
export async function recomputeOrderEconomics(
  orgId: string,
  actor: string | null,
  orderId: string,
): Promise<{ inserted: number; retired: number }> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
    return recomputeOrderEconomicsScoped(orgId, actor, orderId);
  });
}

/**
 * Mark one order for restatement. Label purchase and payout settlement run
 * in modules that cannot import commerce, so they insert the same row with
 * their own statement and the channel scan recomputes; a retried mark
 * collides on (org, order) and the first mark wins.
 */
export async function markOrderEconomicsDirty(orgId: string, orderId: string, reason: string): Promise<void> {
  await db.execute(sql`
    insert into channel_order_economics_pending (org_id, order_id, reason)
    values (${orgId}, ${orderId}, ${reason})
    on conflict (org_id, order_id) do nothing`);
}

/**
 * Drain the restatement queue, oldest marks first. Called from the channel
 * sync scan beside the posting drain, so late label and payout costs restate
 * without a new scheduler kind.
 */
export async function recomputePendingOrderEconomics(
  orgId: string,
  actor: string | null,
  limit = 100,
): Promise<{ orders: number }> {
  return withOrgTransaction(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
    const marks = (await db.execute<{ order_id: string }>(sql`
      select order_id from channel_order_economics_pending
       where org_id = ${orgId} order by enqueued_at limit ${limit} for update skip locked`)).rows;
    let orders = 0;
    for (const mark of marks) {
      await recomputeOrderEconomicsScoped(orgId, actor, mark.order_id);
      const cleared = await db.execute(sql`
        delete from channel_order_economics_pending where org_id = ${orgId} and order_id = ${mark.order_id}`);
      if (cleared.rowCount !== 1) {
        throw new Error("Economics restatement mark matched no row; the queue changed while it drained");
      }
      orders += 1;
    }
    return { orders };
  });
}

/** CM summation: every row counts in its own currency; CM uses the order's. */
function sumComponent(facts: EconomicsFact[], currency: string, components: EconomicsComponent[]): bigint {
  return facts
    .filter((fact) => fact.currency === currency && components.includes(fact.component))
    .reduce((sum, fact) => sum + fact.amountMinor, 0n);
}

/** A 4dp percent string from stored sums; null when there is no revenue base. */
export function marginPercentText(cmMinor: bigint, revenueMinor: bigint): string | null {
  if (revenueMinor <= 0n) return null;
  const scaled = roundDiv(cmMinor * 1000000n, revenueMinor);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / 10000n;
  const frac = String(magnitude % 10000n).padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Read one order's current margin facts with CM1/CM2/CM3 and the derived
 * margin ratio. Ratios are computed here from stored sums on every read and
 * never persisted.
 */
export async function getOrderEconomics(orgId: string, orderId: string): Promise<OrderEconomics> {
  return withOrg(orgId, async () => {
    const order = await loadChannelOrder(orgId, orderId);
    if (!order) {
      refuse(
        "channel_order_unknown",
        "The channel order does not belong to this organization.",
        "Choose an order from this organization's channel subledger.",
        "orderId",
      );
    }
    type CurrentFact = {
      line_key: string;
      component: string;
      source_kind: string;
      source_ref: string;
      currency: string;
      amount_minor: string;
      item_id: string | null;
      sku: string | null;
      promotion_code: string | null;
      estimated: boolean;
      version: number;
      as_of: string;
    };
    const rows = (await db.execute<CurrentFact>(sql`
      select line_key, component, source_kind, source_ref, currency, amount_minor::text,
             item_id, sku, promotion_code, estimated, version, as_of::text
        from channel_order_economics
       where org_id = ${orgId} and order_id = ${order.id} and is_current
       order by line_key, component, source_kind, source_ref`)).rows;
    const currency = order.shopCurrency;
    const facts: EconomicsFact[] = rows.map((row) => ({
      lineKey: row.line_key,
      component: row.component as EconomicsComponent,
      sourceKind: row.source_kind as EconomicsSourceKind,
      sourceRef: row.source_ref,
      currency: row.currency,
      amountMinor: asMinorUnits(row.amount_minor),
      itemId: row.item_id,
      sku: row.sku,
      promotionCode: row.promotion_code,
      estimated: row.estimated,
      version: row.version,
      asOf: row.as_of,
    }));
    const revenue = sumComponent(facts, currency, ["net_revenue", "discount"]);
    const cm1 = revenue + sumComponent(facts, currency, ["cogs", "returns", "restocking_fee"]);
    const cm2 = cm1 + sumComponent(facts, currency, ["processor_fee", "shipping_label", "marketplace_fee", "stored_value_funding"]);
    const cm3 = cm2 + sumComponent(facts, currency, ["ad_spend"]);
    return {
      orderId: order.id,
      currency,
      facts,
      revenue,
      cm1,
      cm2,
      cm3,
      marginPct: marginPercentText(cm2, revenue),
      estimatedAny: facts.some((fact) => fact.estimated),
      mixedCurrency: facts.some((fact) => fact.currency !== currency),
    };
  });
}

export interface ChannelMarginSummary {
  channelId: string;
  channelName: string;
  currency: string;
  orders: number;
  revenueMinor: bigint;
  cm2Minor: bigint;
  estimatedOrders: number;
  adSpendMinor: bigint;
}

type SummaryRow = {
  channel_id: string;
  channel_name: string;
  currency: string;
  orders: string;
  revenue: string;
  cm2: string;
  estimated_orders: string;
};

/**
 * Trailing margin per channel and currency for the cockpit panel: order
 * counts, revenue and CM2 from current facts, the orders still carrying
 * estimated fees, and the imported ad spend beside them.
 */
export async function getChannelMarginSummary(orgId: string, days = 30): Promise<ChannelMarginSummary[]> {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    refuse(
      "margin_window_invalid",
      `Margin window "${days}" is not between 1 and 90 days.`,
      "Request trailing margin for 1 to 90 days.",
    );
  }
  return withOrg(orgId, async () => {
    const rows = (await db.execute<SummaryRow>(sql`
      select c.id as channel_id, c.name as channel_name, f.currency,
             count(distinct f.order_id)::text as orders,
             coalesce(sum(case when f.component in ('net_revenue', 'discount') then f.amount_minor else 0 end), 0)::text as revenue,
             coalesce(sum(case when f.component in ('net_revenue', 'discount', 'cogs', 'returns', 'restocking_fee',
               'processor_fee', 'shipping_label', 'marketplace_fee', 'stored_value_funding') then f.amount_minor else 0 end), 0)::text as cm2,
             count(distinct case when f.estimated then f.order_id end)::text as estimated_orders
        from channel_order_economics f
        join channel_orders o on o.id = f.order_id and o.org_id = f.org_id
        join sales_channels c on c.id = f.channel_id and c.org_id = f.org_id
       where f.org_id = ${orgId} and f.is_current and o.ordered_at >= now() - make_interval(days => ${days})
       group by c.id, c.name, f.currency
       order by c.name, f.currency`)).rows;
    const spend = (await db.execute<{ channel_id: string; currency: string; total: string }>(sql`
      select channel_id, currency, coalesce(sum(amount_minor), 0)::text as total
        from channel_ad_spend
       where org_id = ${orgId} and spend_date >= (now() - make_interval(days => ${days}))::date
       group by channel_id, currency`)).rows;
    const spendByChannel = new Map(spend.map((row) => [`${row.channel_id}|${row.currency}`, BigInt(row.total)]));
    return rows.map((row) => ({
      channelId: row.channel_id,
      channelName: row.channel_name,
      currency: row.currency,
      orders: Number(row.orders),
      revenueMinor: BigInt(row.revenue),
      cm2Minor: BigInt(row.cm2),
      estimatedOrders: Number(row.estimated_orders),
      adSpendMinor: spendByChannel.get(`${row.channel_id}|${row.currency}`) ?? 0n,
    }));
  });
}

/**
 * Record one day's imported marketing spend for a channel (idempotent by
 * channel, day and source: re-importing the same source replaces its
 * figure) and mark that day's orders for restatement.
 */
export async function recordChannelAdSpend(
  orgId: string,
  actor: string | null,
  input: { channelId: string; spendDate: string; amountMinor: bigint; currency: string; source: string },
): Promise<{ spendId: string }> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
    await channelProvider(orgId, input.channelId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spendDate)) {
      refuse(
        "ad_spend_date_invalid",
        `Ad spend date "${input.spendDate}" is not a calendar day.`,
        "Record ad spend against a calendar day as YYYY-MM-DD.",
        "spendDate",
      );
    }
    if (input.amountMinor < 0n) {
      refuse(
        "ad_spend_negative",
        "Daily ad spend cannot be negative.",
        "Record the day's spend as a zero or positive amount.",
        "amountMinor",
      );
    }
    await minorUnitsForCurrency(input.currency);
    // A re-import from the same source replaces that source's day figure:
    // the conflict is expected (imports retry) and the latest file wins.
    const stored = await db.execute<{ id: string }>(sql`
      insert into channel_ad_spend (org_id, channel_id, spend_date, amount_minor, currency, source, created_by, updated_by)
      values (${orgId}, ${input.channelId}, ${input.spendDate}, ${input.amountMinor.toString()},
        ${input.currency}, ${input.source}, ${actor}, ${actor})
      on conflict (org_id, channel_id, spend_date, source) do update
        set amount_minor = excluded.amount_minor, currency = excluded.currency,
            updated_by = ${actor}, updated_at = now()
      returning id`);
    if (stored.rows.length !== 1) throw new Error("Ad spend store returned an unexpected row count");
    // Every order of the spend day shares the new figure, so every one
    // restates; a day with no orders marks nothing, which is correct.
    await db.execute(sql`
      insert into channel_order_economics_pending (org_id, order_id, reason)
      select ${orgId}, o.id, ${`ad spend imported for ${input.spendDate}`}
        from channel_orders o
       where o.org_id = ${orgId} and o.channel_id = ${input.channelId}
         and (o.ordered_at at time zone 'UTC')::date = ${input.spendDate}::date
      on conflict (org_id, order_id) do nothing`);
    return { spendId: stored.rows[0]!.id };
  });
}

