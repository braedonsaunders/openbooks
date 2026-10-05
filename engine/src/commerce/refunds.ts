import { sql } from "drizzle-orm";
import type { ChannelRefund } from "./contracts.ts";
import { CommerceError } from "./errors.ts";
import { findNative } from "./external-links.ts";
import {
  loadChannelEvent,
  loadChannelOrder,
  markChannelEventException,
  markChannelEventPosted,
  maybeCloseGoverningOrder,
  type ChannelOrderDetail,
} from "./orders.ts";
import { getPostingPolicy } from "./posting-policies.ts";
import {
  CHANNEL_ORDER_EXCEPTION_CODES,
  discountTaxes,
  OrderPostException,
  resolveOrderForPosting,
} from "./order-posting.ts";
import { resolveAccountMap } from "./account-maps.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { db, withOrg, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import { replaceDocumentTenders, type TenderInput } from "../sales/document-tenders.ts";
import { fromMinorUnits, toMinorUnits } from "../payments/acceptance.ts";
import { arePeriodModulesOpen, closeModuleForDocument, CloseError } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { loadKitComponents, kitComponentQuantities, kitLabel } from "../inventory/kits.ts";
import { postedReturnQuantity } from "../inventory/return-quantities.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

/**
 * Refund posting exception codes. Each parks the refund event with the
 * reason and the one-click remedy — a refund that cannot post is never
 * dropped and never posted to a fallback account. The order-level queue
 * reuses the same vocabulary, so the Exceptions tab reads as one queue.
 */
export const CHANNEL_REFUND_EXCEPTION_CODES = [
  ...CHANNEL_ORDER_EXCEPTION_CODES,
  "over_refund",
  "refund_unposted_order",
  "unmapped_fulfilment_location",
  "insufficient_stock",
  "cancellation_blocked",
] as const;

export type ChannelRefundExceptionCode = (typeof CHANNEL_REFUND_EXCEPTION_CODES)[number];

/** A computed refund refusal that must reach the operator: parked, never swallowed. */
export class RefundPostException extends CommerceError {
  constructor(code: ChannelRefundExceptionCode, message: string, remedy: string) {
    super(code, message, remedy, { status: 422 });
    this.name = "RefundPostException";
  }
}

function park(code: ChannelRefundExceptionCode, message: string, remedy: string): never {
  throw new RefundPostException(code, message, remedy);
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Minor units to ledger decimal through the shared provider-scale conversion (signed-safe). */
function minorToLedger(minor: bigint, currency: string): string {
  return fromMinorUnits(minor, currency);
}

type MovementRow = Record<string, unknown> & {
  id: string;
  itemId: string;
  stockLocationId: string;
  quantity: string;
  totalValue: string | null;
  lotId: string | null;
  serialId: string | null;
  documentLineId: string | null;
};

interface RefundLineMatch {
  orderLineIndex: number;
  itemId: string | null;
  accountId: string;
  title: string;
  refundQuantity: { numerator: bigint; denominator: bigint };
  /** Order line discount share, minor units. */
  discountMinor: bigint;
  /** Order line merchant tax, minor units. */
  merchantTaxMinor: bigint;
  /** Marketplace net-mode tax on the order line: facilitator money, never booked. */
  marketplaceNetMinor: bigint;
  promotionId: string | null;
  marketplaceFacilitator: string | null;
  taxes: Array<{
    taxCodeId: string;
    ratePercent: string;
    collectedBy: "merchant" | "marketplace";
    facilitatorName: string | null;
    liabilityAccountId: string | null;
    amountMinor: bigint;
    facilitatorNetMode: boolean;
  }>;
  restock: boolean;
  /** Authoritative refunded revenue for this line, minor units. */
  revenueMinor: bigint;
}

interface RefundTenderMatch {
  gateway: string;
  amountMinor: bigint;
  giftCardAccountId: string | null;
  accountId: string | null;
}

export interface ResolvedRefund {
  eventId: string;
  orderId: string;
  channelId: string;
  channelName: string;
  provider: string;
  externalAccount: string;
  externalId: string;
  documentDate: string;
  currency: string;
  subsidiaryId: string | null;
  partyId: string | null;
  saleDocumentId: string;
  /**
   * True when the sale posted inside a daily summary: summary sales book
   * anonymously, so the refund must too — the return engine matches every
   * restock line's source customer against the document's party.
   */
  saleAnonymous: boolean;
  lines: RefundLineMatch[];
  tenders: RefundTenderMatch[];
  shippingMinor: bigint;
  shippingAccountId: string;
  shippingTaxMinor: bigint;
  shippingTaxes: RefundLineMatch["taxes"];
  discountAccountId: string;
  merchantTotalMinor: bigint;
  roundingMinor: bigint;
  roundingAccountId: string | null;
}

function parseQuantity(raw: string, label: string): { numerator: bigint; denominator: bigint } {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(raw.trim());
  if (!match) {
    park("tax_mismatch", `Refund ${label} carries an unreadable quantity.`, "Replay the refunds/create delivery from the storefront so every line arrives with a positive quantity, then post it again.");
  }
  const whole = BigInt(match[1]!);
  const frac = match[2] ?? "";
  if (whole === 0n && /^0*$/.test(frac)) {
    park("tax_mismatch", `Refund ${label} has zero quantity.`, "Replay the refunds/create delivery from the storefront so every line arrives with a positive quantity, then post it again.");
  }
  const denominator = 10n ** BigInt(frac.length);
  return { numerator: whole * denominator + (frac === "" ? 0n : BigInt(frac)), denominator };
}

/** Half-up pro-rata share of a minor-unit amount by quantity ratio. */
function prorate(amount: bigint, numerator: bigint, denominator: bigint, whole: bigint, wholeDenominator: bigint): bigint {
  if (whole === 0n) return 0n;
  const top = 2n * amount * numerator * wholeDenominator + denominator * whole;
  const bottom = 2n * denominator * whole;
  return top / bottom;
}

/** Map a channel account role, parking as unmapped_account (never a fallback) when unconfigured. */
async function mappedAccount(
  orgId: string,
  channelId: string,
  role: string,
  key: string,
  date: string,
): Promise<string> {
  try {
    return await resolveAccountMap(orgId, channelId, role, key, date);
  } catch (error) {
    if (error instanceof CommerceError && error.code === "channel_map_unmapped") {
      park("unmapped_account", error.message, error.remedy);
    }
    throw error;
  }
}

/** Stored refund payloads keep minor units as JSON strings; revive them to bigints on the way out. */
function asMinorUnits(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value as string);
}

export function reviveRefundPayload(payload: Record<string, unknown>): ChannelRefund {
  const lines = (payload.lines ?? []) as Array<Record<string, unknown>>;
  const tenders = (payload.tenders ?? []) as Array<Record<string, unknown>>;
  return {
    externalId: String(payload.externalId ?? ""),
    orderExternalId: String(payload.orderExternalId ?? ""),
    reason: typeof payload.reason === "string" ? payload.reason : null,
    restock: payload.restock === true,
    totalMinor: asMinorUnits(payload.totalMinor ?? "0"),
    lines: lines.map((line) => ({
      lineExternalId: typeof line.lineExternalId === "string" ? line.lineExternalId : null,
      sku: typeof line.sku === "string" ? line.sku : null,
      variantExternalId: typeof line.variantExternalId === "string" ? line.variantExternalId : null,
      quantity: String(line.quantity ?? "0"),
      amountMinor: asMinorUnits(line.amountMinor ?? "0"),
      taxMinor: line.taxMinor === undefined || line.taxMinor === null ? null : asMinorUnits(line.taxMinor),
      // Payloads stored before per-line restock inherit the refund's flag.
      restock: typeof line.restock === "boolean" ? line.restock : payload.restock === true,
    })),
    shippingMinor: payload.shippingMinor === undefined ? 0n : asMinorUnits(payload.shippingMinor),
    tenders: tenders.map((tender) => ({
      gateway: String(tender.gateway ?? ""),
      amountMinor: asMinorUnits(tender.amountMinor ?? "0"),
    })),
    refundedAt: String(payload.refundedAt ?? new Date().toISOString()),
  };
}

interface ChannelMeta {
  name: string;
  kind: string;
  externalAccount: string;
  currency: string;
  subsidiaryId: string | null;
}

async function loadRefundChannel(orgId: string, channelId: string): Promise<ChannelMeta> {
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

async function assertRefundPeriodOpen(
  orgId: string,
  subsidiaryId: string | null,
  date: string,
  refundId: string,
): Promise<void> {
  const bookId = await activePostingPrimaryBookId(orgId);
  if (!bookId) return;
  const period = await resolveCoveringPeriod(db, orgId, date);
  if (!period) return;
  let module: Parameters<typeof arePeriodModulesOpen>[1]["modules"][number];
  try {
    module = closeModuleForDocument("cash_refund");
  } catch (error) {
    if (error instanceof CloseError) return;
    throw error;
  }
  const open = await arePeriodModulesOpen(db, {
    orgId,
    periodId: period.id,
    bookId,
    subsidiaryIds: subsidiaryId ? [subsidiaryId] : [],
    modules: [module],
  });
  if (!open) {
    park(
      "closed_period",
      `Refund ${refundId} falls in closed period ${period.name}.`,
      "Reopen the period under Period close, or wait for an open-period refund date, then replay the refund.",
    );
  }
}

/** Money already returned for one order through posted cash refunds, in minor units. */
async function priorRefundedTotalMinor(orgId: string, orderId: string, currency: string): Promise<bigint> {
  const rows = (await db.execute<{ total: string }>(sql`
    select total::text as total from documents
     where org_id = ${orgId} and kind = 'cash_refund' and status = 'posted'
       and custom->>'channelOrderId' = ${orderId}`)).rows;
  let sum = 0n;
  for (const row of rows) {
    // Posted refund totals are exact ledger decimals, so the shared
    // provider-scale conversion lands them on minor units without floats.
    sum += BigInt(toMinorUnits(row.total, currency));
  }
  return sum;
}

/**
 * Quantities already returned per order-line key through posted refund
 * events. The event being resolved is still pending, so it never counts
 * itself — a replay observes its own posted document instead.
 */
async function priorRefundedQuantities(
  orgId: string,
  orderId: string,
): Promise<Map<string, { numerator: bigint; denominator: bigint }>> {
  const rows = (await db.execute<{ payload: Record<string, unknown> }>(sql`
    select payload from channel_order_events
     where org_id = ${orgId} and order_id = ${orderId} and kind = 'refund' and posting_status = 'posted'`)).rows;
  const totals = new Map<string, { numerator: bigint; denominator: bigint }>();
  for (const row of rows) {
    if (!row.payload) continue;
    let refund: ChannelRefund;
    try {
      refund = reviveRefundPayload(row.payload);
    } catch {
      continue;
    }
    for (const line of refund.lines) {
      const key = refundLineKey(line.variantExternalId, line.sku);
      const qty = looseQuantity(line.quantity);
      if (!qty) continue;
      const prior = totals.get(key);
      totals.set(key, prior ? addFractions(prior, qty) : qty);
    }
  }
  return totals;
}

function refundLineKey(variantExternalId: string | null, sku: string | null): string {
  return `v:${variantExternalId ?? ""}|s:${(sku ?? "").trim().toUpperCase()}`;
}

function looseQuantity(raw: string): { numerator: bigint; denominator: bigint } | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(raw.trim());
  if (!match) return null;
  const frac = match[2] ?? "";
  const denominator = 10n ** BigInt(frac.length);
  return { numerator: BigInt(match[1]!) * denominator + (frac === "" ? 0n : BigInt(frac)), denominator };
}

function addFractions(
  first: { numerator: bigint; denominator: bigint },
  second: { numerator: bigint; denominator: bigint },
): { numerator: bigint; denominator: bigint } {
  return {
    numerator: first.numerator * second.denominator + second.numerator * first.denominator,
    denominator: first.denominator * second.denominator,
  };
}

/** True when refunded + prior exceeds ordered (all scaled to a common denominator). */
function exceedsOrdered(
  ordered: { numerator: bigint; denominator: bigint },
  prior: { numerator: bigint; denominator: bigint } | undefined,
  refunded: { numerator: bigint; denominator: bigint },
): boolean {
  const total = prior ? addFractions(prior, refunded) : refunded;
  return total.numerator * ordered.denominator > ordered.numerator * total.denominator;
}

function fractionText(fraction: { numerator: bigint; denominator: bigint }): string {
  if (fraction.denominator === 1n) return fraction.numerator.toString();
  return `${fraction.numerator}/${fraction.denominator}`;
}

/**
 * Resolve one stored refund against its order's posted sale.
 *
 * The order's own resolution is reused wholesale (same items, tax codes,
 * accounts, promotions the sale posted with), then the refund carves its
 * quantities out of it: revenue at the booked unit gross, discount and tax
 * pro-rata by refunded quantity, tenders paying out per gateway. The
 * storefront's line amounts are authoritative for WHAT was refunded but
 * never for the books: a line amount that disagrees with its quantity at
 * booked prices parks with both figures instead of posting a plug.
 */
export async function resolveRefundForPosting(
  orgId: string,
  actor: string | null,
  runner: SqlExecutor,
  order: ChannelOrderDetail,
  refund: ChannelRefund,
  eventId: string,
): Promise<ResolvedRefund> {
  const channel = await loadRefundChannel(orgId, order.channelId);
  const documentDate = refund.refundedAt.slice(0, 10);
  if (!isIsoCalendarDate(documentDate)) {
    park(
      "tax_mismatch",
      `Refund ${refund.externalId} carries an unreadable refund date.`,
      "Replay the refunds/create delivery from the storefront so it arrives with its refunded-at timestamp, then post it again.",
    );
  }
  // No policy, no mode: the event stays failed with this refusal until
  // the operator chooses the channel's posting mode, then replays.
  const policy = await getPostingPolicy(orgId, order.channelId, documentDate);
  if (policy.mode !== "per_order" && policy.mode !== "daily_summary") {
    throw new CommerceError(
      "channel_policy_mode_unknown",
      `Refund ${refund.externalId} has no posting mode to follow.`,
      "Choose the channel's posting mode under Channels → Settings, then replay the refund.",
    );
  }
  if (order.shopCurrency !== channel.currency) {
    park(
      "currency_unsupported",
      `Refund ${refund.externalId} prices in ${order.shopCurrency} on a channel billing in ${channel.currency}.`,
      "Price the storefront in the channel currency, or connect a channel for the order's currency, then post the refund again.",
    );
  }
  // The refund reverses a posted sale: per-order cash sales, summary cash
  // sales, and nothing else. Anything earlier waits for the sale to post.
  let saleDocumentId: string | null = null;
  let saleAnonymous = false;
  if (order.postingDocumentId) {
    const sale = (await db.execute<{ kind: string; status: string }>(sql`
      select kind, status from documents where org_id = ${orgId} and id = ${order.postingDocumentId}`)).rows[0];
    if (sale?.kind === "cash_sale" && sale.status === "posted") saleDocumentId = order.postingDocumentId;
  }
  if (!saleDocumentId && order.summaryId) {
    const summary = (await db.execute<{ posting_document_id: string | null }>(sql`
      select s.posting_document_id from channel_daily_summaries s
       join documents d on d.org_id = s.org_id and d.id = s.posting_document_id
       where s.org_id = ${orgId} and s.id = ${order.summaryId} and d.status = 'posted'`)).rows[0];
    saleDocumentId = summary?.posting_document_id ?? null;
    saleAnonymous = saleDocumentId !== null;
  }
  if (!saleDocumentId) {
    park(
      "refund_unposted_order",
      `Refund ${refund.externalId} reverses order ${order.externalNumber}, whose sale has not posted yet.`,
      "Post the order first (replay it from the Orders tab), then replay the refund.",
    );
  }
  if (refund.totalMinor <= 0n) {
    park(
      "tax_mismatch",
      `Refund ${refund.externalId} moves no money.`,
      "Record a money-less stock return directly against the sale, or re-sync the refund so its payout transactions arrive, then post it again.",
    );
  }
  if (refund.tenders.length === 0) {
    park(
      "tax_mismatch",
      `Refund ${refund.externalId} carries no payout transactions, so no gateway can be paid out.`,
      "Re-sync the refund from the storefront so its payout transactions arrive, then post it again.",
    );
  }
  // Cumulative money cap: posted refunds plus this one can never exceed the
  // order's own total — the second full refund of one order is refused by
  // name, not posted twice.
  const priorTotal = await priorRefundedTotalMinor(orgId, order.id, order.shopCurrency);
  if (priorTotal + refund.totalMinor > order.totalMinor) {
    const remaining = order.totalMinor - priorTotal;
    park(
      "over_refund",
      `Refund ${refund.externalId} returns ${refund.totalMinor} but order ${order.externalNumber} has ${remaining >= 0n ? remaining : 0n} unrefunded of ${order.totalMinor} (${priorTotal} already returned).`,
      remaining > 0n
        ? `Refund at most ${remaining} for this order, then post the refund again.`
        : "This order is fully refunded already; record any further goodwill as a manual cash refund instead.",
    );
  }
  const resolved = await resolveOrderForPosting(orgId, actor, runner, order);
  const productLines = resolved.lines.filter((line) => line.kind === "product" || line.kind === "gift_issue");
  const orderProductLines = order.lines;
  if (productLines.length !== orderProductLines.length) {
    throw new Error("Channel order resolution changed shape while its refund resolved");
  }
  const priorQuantities = await priorRefundedQuantities(orgId, order.id);
  const lines: RefundLineMatch[] = [];
  let splitCount = 0;
  for (const refundLine of refund.lines) {
    const qty = parseQuantity(refundLine.quantity, `${refund.externalId} line "${refundLine.sku ?? "?"}"`);
    let matchIndex = -1;
    if (refundLine.variantExternalId) {
      matchIndex = orderProductLines.findIndex((line) => line.variantExternalId === refundLine.variantExternalId);
    }
    if (matchIndex < 0 && refundLine.sku) {
      const sku = refundLine.sku.trim().toUpperCase();
      matchIndex = orderProductLines.findIndex((line) => (line.sku ?? "").trim().toUpperCase() === sku);
    }
    if (matchIndex < 0) {
      park(
        "unmapped_item",
        `Refund ${refund.externalId} names SKU ${refundLine.sku ?? "(none)"}, which order ${order.externalNumber} never sold.`,
        "Re-sync the refund from the storefront so its lines match the order's lines, then post it again.",
      );
    }
    const orderLine = orderProductLines[matchIndex]!;
    const resolvedLine = productLines[matchIndex]!;
    const orderQty = parseQuantity(orderLine.quantity, `order ${order.externalNumber} line "${orderLine.title}"`);
    const key = refundLineKey(orderLine.variantExternalId, orderLine.sku);
    if (exceedsOrdered(orderQty, priorQuantities.get(key), qty)) {
      const prior = priorQuantities.get(key);
      park(
        "over_refund",
        `Refund ${refund.externalId} returns ${fractionText(qty)} of "${orderLine.title}" but order ${order.externalNumber} sold ${fractionText(orderQty)}${prior ? ` with ${fractionText(prior)} already returned` : ""}.`,
        `Refund at most the unreturned quantity of "${orderLine.title}", then post the refund again.`,
      );
    }
    // Quantity-anchored reversal at booked prices: the storefront's line
    // amount must agree with its quantity, never the other way round.
    const revenueMinor = prorate(resolvedLine.amountMinor, qty.numerator, qty.denominator, orderQty.numerator, orderQty.denominator);
    const discountLines = resolved.lines.filter(
      (line) => line.kind === "discount" && line.title.endsWith(`— ${orderLine.title}`),
    );
    const discountTotal = discountLines.reduce((sum, line) => sum + line.amountMinor, 0n);
    // Discount lines post negative, so the share reverses the sign back to a
    // positive reversal magnitude.
    const discountMinor = prorate(-discountTotal, qty.numerator, qty.denominator, orderQty.numerator, orderQty.denominator);
    const expectedNet = revenueMinor - discountMinor;
    if (refundLine.amountMinor < 0n || (expectedNet >= 0n && (refundLine.amountMinor > expectedNet + 1n || refundLine.amountMinor < expectedNet - 1n))) {
      park(
        "tax_mismatch",
        `Refund ${refund.externalId} line "${orderLine.title}" states ${refundLine.amountMinor} for ${fractionText(qty)} units, but the booked net is ${expectedNet}.`,
        "Re-sync the refund from the storefront so its line amounts agree with the order, or record a goodwill adjustment as a manual cash refund instead.",
      );
    }
    const merchantTaxTotal = resolvedLine.taxes
      .filter((tax) => tax.collectedBy === "merchant" || !tax.facilitatorNetMode)
      .reduce((sum, tax) => sum + tax.amountMinor, 0n);
    const marketplaceNetTotal = resolvedLine.taxes
      .filter((tax) => tax.collectedBy === "marketplace" && tax.facilitatorNetMode)
      .reduce((sum, tax) => sum + tax.amountMinor, 0n);
    let lineTaxes: RefundLineMatch["taxes"];
    let merchantTaxMinor = 0n;
    let marketplaceNetMinor = 0n;
    if (refundLine.taxMinor !== null) {
      // The provider states the refunded tax: spread it across the booked
      // components pro-rata so every penny stays on its own tax code.
      const stated = refundLine.taxMinor;
      if (merchantTaxTotal === 0n) {
        if (stated !== 0n) {
          park(
            "tax_mismatch",
            `Refund ${refund.externalId} line "${orderLine.title}" states ${stated} tax on a tax-free line.`,
            "Re-sync the refund from the storefront so its tax agrees with the order, then post it again.",
          );
        }
        lineTaxes = [];
      } else {
        lineTaxes = [];
        let allocated = 0n;
        const merchant = resolvedLine.taxes.filter((tax) => tax.collectedBy === "merchant" || !tax.facilitatorNetMode);
        merchant.forEach((tax, index) => {
          const share = index === merchant.length - 1
            ? stated - allocated
            : (2n * tax.amountMinor * stated + (merchantTaxTotal >= 0n ? merchantTaxTotal : -merchantTaxTotal)) / (2n * merchantTaxTotal);
          allocated += share;
          lineTaxes.push({ ...tax, amountMinor: share });
        });
        merchantTaxMinor = stated;
      }
      marketplaceNetMinor = prorate(marketplaceNetTotal, qty.numerator, qty.denominator, orderQty.numerator, orderQty.denominator);
    } else {
      lineTaxes = resolvedLine.taxes
        .filter((tax) => tax.collectedBy === "merchant" || !tax.facilitatorNetMode)
        .map((tax) => ({
          ...tax,
          amountMinor: prorate(tax.amountMinor, qty.numerator, qty.denominator, orderQty.numerator, orderQty.denominator),
        }));
      merchantTaxMinor = lineTaxes.reduce((sum, tax) => sum + tax.amountMinor, 0n);
      marketplaceNetMinor = prorate(marketplaceNetTotal, qty.numerator, qty.denominator, orderQty.numerator, orderQty.denominator);
    }
    splitCount += 1 + lineTaxes.length;
    lines.push({
      orderLineIndex: matchIndex,
      itemId: orderLine.giftCard ? null : resolvedLine.itemId,
      accountId: resolvedLine.accountId,
      title: orderLine.title,
      refundQuantity: qty,
      discountMinor,
      merchantTaxMinor,
      marketplaceNetMinor,
      promotionId: resolvedLine.promotionId,
      marketplaceFacilitator: resolvedLine.marketplaceFacilitator,
      taxes: lineTaxes,
      restock: refundLine.restock && !orderLine.giftCard,
      revenueMinor,
    });
  }

  // Shipping refunds arrive as one order-adjustment number: spread it across
  // the booked shipping lines pro-rata so each keeps its own income account
  // and tax code. The last line absorbs the rounding remainder, so the
  // split ties to the storefront's figure exactly.
  let shippingMinor = 0n;
  let shippingTaxMinor = 0n;
  let shippingMarketplaceNetMinor = 0n;
  const shippingTaxes: RefundLineMatch["taxes"] = [];
  let shippingAccountId = "";
  if (refund.shippingMinor > 0n) {
    // Zero-amount shipping lines carry no tax and take no share.
    const shipLines = resolved.lines.filter((line) => line.kind === "shipping" && line.amountMinor > 0n);
    const shipTotal = shipLines.reduce((sum, line) => sum + line.amountMinor, 0n);
    if (shipLines.length === 0 || shipTotal <= 0n) {
      park(
        "tax_mismatch",
        `Refund ${refund.externalId} returns ${refund.shippingMinor} shipping on order ${order.externalNumber} with no shippable charge.`,
        "Re-sync the refund from the storefront so its shipping agrees with the order, then post it again.",
      );
    }
    if (refund.shippingMinor > shipTotal) {
      park(
        "over_refund",
        `Refund ${refund.externalId} returns ${refund.shippingMinor} shipping but order ${order.externalNumber} charged ${shipTotal}.`,
        `Refund at most ${shipTotal} shipping for this order, then post the refund again.`,
      );
    }
    shippingAccountId = shipLines[0]!.accountId;
    let allocatedShip = 0n;
    for (let shipIndex = 0; shipIndex < shipLines.length; shipIndex += 1) {
      const ship = shipLines[shipIndex]!;
      const share = shipIndex === shipLines.length - 1
        ? refund.shippingMinor - allocatedShip
        : prorate(ship.amountMinor, refund.shippingMinor, shipTotal, 1n, 1n);
      allocatedShip += share;
      shippingMinor += share;
      if (share === 0n) continue;
      for (const tax of ship.taxes) {
        if (tax.collectedBy === "marketplace" && tax.facilitatorNetMode) {
          shippingMarketplaceNetMinor += prorate(tax.amountMinor, share, ship.amountMinor, 1n, 1n);
          continue;
        }
        const taxShare = prorate(tax.amountMinor, share, ship.amountMinor, 1n, 1n);
        const match = shippingTaxes.find(
          (candidate) => candidate.taxCodeId === tax.taxCodeId && (candidate.facilitatorName ?? "") === (tax.facilitatorName ?? ""),
        );
        if (match) match.amountMinor += taxShare;
        else shippingTaxes.push({ ...tax, amountMinor: taxShare });
      }
    }
    shippingTaxMinor = shippingTaxes.reduce((sum, tax) => sum + tax.amountMinor, 0n);
    splitCount += 1 + shippingTaxes.length;
  } else {
    const shipLines = resolved.lines.filter((line) => line.kind === "shipping");
    shippingAccountId = shipLines[0]?.accountId ?? await mappedAccount(orgId, order.channelId, "shipping_income", "", documentDate);
  }
  const discountAccountId = await mappedAccount(orgId, order.channelId, "discount", "", documentDate);

  // Tenders pay out per gateway: each refund transaction settles through the
  // gateway clearing its sale used, scaled to the merchant-booked total so
  // the document cross-foots exactly. A tender that entered on stored value
  // goes back onto the same card — the refund's post-commit effect tops it
  // up, exactly once per tender row.
  const merchantComputed = lines.reduce((sum, line) => sum + line.revenueMinor - line.discountMinor + line.merchantTaxMinor, 0n)
    + shippingMinor + shippingTaxMinor;
  const marketplaceComputed = lines.reduce((sum, line) => sum + line.marketplaceNetMinor, 0n) + shippingMarketplaceNetMinor;
  const residual = refund.totalMinor - marketplaceComputed - merchantComputed;
  let roundingMinor = 0n;
  let roundingAccountId: string | null = null;
  if (residual !== 0n) {
    // Only pure rounding drift may ride the rounding account: every split
    // above can drift half a minor unit. Anything larger is a real
    // disagreement with the storefront, parked with both figures.
    if (residual > BigInt(splitCount) || residual < -BigInt(splitCount)) {
      park(
        "tax_mismatch",
        `Refund ${refund.externalId} totals ${refund.totalMinor} but its lines compute ${merchantComputed} merchant plus ${marketplaceComputed} marketplace-kept (difference ${residual}).`,
        "Re-sync the refund from the storefront so its totals agree with the order's booked prices, then post it again.",
      );
    }
    roundingAccountId = await mappedAccount(orgId, order.channelId, "rounding", "", documentDate);
    roundingMinor = residual;
    splitCount += 1;
  }
  const merchantTotalMinor = merchantComputed + roundingMinor;
  const tenders: RefundTenderMatch[] = [];
  if (merchantTotalMinor > 0n) {
    let allocated = 0n;
    const total = refund.totalMinor;
    for (let index = 0; index < refund.tenders.length; index += 1) {
      const tender = refund.tenders[index]!;
      const gateway = cleanText(tender.gateway);
      if (!gateway) {
        park(
          "unmapped_account",
          `Refund ${refund.externalId} carries a payout with no gateway, so no clearing account can be resolved.`,
          "Re-sync the refund from the storefront so every payout names its gateway, then post it again.",
        );
      }
      const share = index === refund.tenders.length - 1
        ? merchantTotalMinor - allocated
        : (2n * tender.amountMinor * merchantTotalMinor + (total >= 0n ? total : -total)) / (2n * total);
      allocated += share;
      if (share <= 0n) continue;
      const orderTender = order.tenders.find(
        (candidate) => candidate.gateway.toLowerCase() === gateway.toLowerCase() && candidate.giftCardExternalId,
      ) ?? (gateway.toLowerCase() === "gift_card"
        ? order.tenders.find((candidate) => candidate.giftCardExternalId)
        : undefined);
      if (orderTender?.giftCardExternalId) {
        const linked = await findNative(orgId, {
          provider: channel.kind,
          externalAccount: channel.externalAccount,
          objectType: "gift_card",
          externalId: orderTender.giftCardExternalId,
        });
        const card = linked?.nativeTable === "stored_value_accounts"
          ? (await db.execute<{ id: string; currency: string }>(sql`
              select id, currency from stored_value_accounts
               where org_id = ${orgId} and id = ${linked.nativeId}`)).rows[0]
          : undefined;
        if (!card) {
          park(
            "unmapped_account",
            `Refund ${refund.externalId} pays back gift card "${orderTender.giftCardExternalId}", which is not linked to a stored-value account.`,
            "Link or issue the gift card under Stored value, then replay the refund.",
          );
        }
        if (card.currency !== order.shopCurrency) {
          park(
            "currency_unsupported",
            `Refund ${refund.externalId} pays back a ${card.currency} gift card against a ${order.shopCurrency} order.`,
            "Re-issue the card in the order's currency under Stored value, then replay the refund.",
          );
        }
        tenders.push({ gateway, amountMinor: share, giftCardAccountId: card.id, accountId: null });
        continue;
      }
      const accountId = await mappedAccount(orgId, order.channelId, "gateway_clearing", gateway, documentDate);
      tenders.push({ gateway, amountMinor: share, giftCardAccountId: null, accountId });
    }
    const paid = tenders.reduce((sum, tender) => sum + tender.amountMinor, 0n);
    if (paid !== merchantTotalMinor) {
      throw new Error("Channel refund tender split left while it allocated");
    }
  }
  await assertRefundPeriodOpen(orgId, channel.subsidiaryId, documentDate, refund.externalId);
  return {
    eventId,
    orderId: order.id,
    channelId: order.channelId,
    channelName: channel.name,
    provider: channel.kind,
    externalAccount: channel.externalAccount,
    externalId: refund.externalId,
    documentDate,
    currency: order.shopCurrency,
    subsidiaryId: channel.subsidiaryId,
    partyId: saleAnonymous ? null : resolved.customerPartyId,
    saleDocumentId: saleDocumentId!,
    saleAnonymous,
    lines,
    tenders,
    shippingMinor,
    shippingAccountId,
    shippingTaxMinor,
    shippingTaxes,
    discountAccountId,
    merchantTotalMinor,
    roundingMinor,
    roundingAccountId,
  };
}

interface RestockSlice {
  movementId: string;
  stockLocationId: string;
  /** Exact four-decimal units coming back on this slice. */
  quantity: string;
  lotId: string | null;
  serialId: string | null;
}

/** Exact fraction to four-decimal stock units; louder than a rounding guess below shelf precision. */
function toStockQuantity(fraction: { numerator: bigint; denominator: bigint }, label: string): string {
  const scaled = fraction.numerator * 10_000n;
  const whole = scaled / fraction.denominator;
  if (scaled % fraction.denominator !== 0n) {
    park(
      "tax_mismatch",
      `Refund ${label} returns a fractional quantity below stock precision.`,
      "Record the fractional stock return directly against the sale, then post the money refund again without restock.",
    );
  }
  const negative = whole < 0n;
  const digits = (negative ? -whole : whole).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function stockMinus(first: string, second: string): string {
  const scale = (value: string): bigint => {
    const [whole, frac = ""] = value.trim().split(".");
    return BigInt(`${whole}${(frac + "0000").slice(0, 4)}`);
  };
  const total = scale(first) - scale(second);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/**
 * Allocate one item's return quantity across the sale's posted issue
 * movements, oldest first. Each slice names its source movement, so the
 * return engine restores every unit at the cost it left at — never today's
 * cost. A sale that never issued (its fulfilment was never recorded) has no
 * source to name: the money is legitimate but the shelf is untouched, so the
 * refund parks until the fulfilment is recorded.
 */
async function allocateRestockSlices(
  orgId: string,
  runner: SqlExecutor,
  saleDocumentId: string,
  saleLineItemId: string,
  movementItemId: string,
  needText: string,
  label: string,
): Promise<{ slices: RestockSlice[]; stocked: boolean }> {
  const item = (await runner.execute<{ kind: string }>(sql`
    select kind from items where org_id = ${orgId} and id = ${movementItemId}`)).rows[0];
  const stocked = !!item && (item.kind === "inventory" || item.kind === "assembly" || item.kind === "kit");
  const candidates = (await runner.execute<MovementRow>(sql`
    select m.id, m.item_id as "itemId", m.stock_location_id as "stockLocationId",
           m.quantity::text as quantity, m.total_value::text as "totalValue",
           m.lot_id as "lotId", m.serial_id as "serialId", m.document_line_id as "documentLineId"
      from inventory_movements m
      join document_lines dl on dl.id = m.document_line_id and dl.org_id = m.org_id
     where m.org_id = ${orgId} and dl.document_id = ${saleDocumentId}
       and m.kind = 'issue' and m.status = 'posted'
       and m.item_id = ${movementItemId} and dl.item_id = ${saleLineItemId}
     order by m.moved_at, m.id`)).rows;
  if (candidates.length === 0) {
    return { slices: [], stocked };
  }
  const slices: RestockSlice[] = [];
  let need = needText;
  for (const candidate of candidates) {
    if (need === "0.0000") break;
    const shipped = stockMinus("0.0000", candidate.quantity);
    const alreadyReturned = await postedReturnQuantity(runner, orgId, {
      returnKind: "receipt",
      evidenceKey: "sourceIssueMovementId",
      sourceMovementId: candidate.id,
    });
    const open = stockMinus(shipped, alreadyReturned);
    if (open === "0.0000" || open.startsWith("-")) continue;
    const take = stockMinus(open, need).startsWith("-") ? open : need;
    slices.push({
      movementId: candidate.id,
      stockLocationId: candidate.stockLocationId,
      quantity: take,
      lotId: candidate.lotId,
      serialId: candidate.serialId,
    });
    need = stockMinus(need, take);
  }
  if (need !== "0.0000") {
    park(
      "over_refund",
      `Refund ${label} restocks ${needText} units but the sale shipped fewer unreturned units.`,
      "Restock at most the unreturned quantity, recording any extra units as a manual stock receipt instead.",
    );
  }
  return { slices, stocked };
}

export interface RefundDraftLine {
  title: string;
  itemId: string | null;
  accountId: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxAmount: string;
  promotionId: string | null;
  marketplaceFacilitator: string | null;
  stockLocationId: string | null;
  customJson: string;
  taxes: RefundLineMatch["taxes"];
}

export interface CashRefundDraft {
  provider: string;
  /** Dedupe key: the refund external id, or the batch refund scope. */
  externalRef: string;
  channelId: string;
  orderId: string;
  refundId: string;
  documentDate: string;
  currency: string;
  subsidiaryId: string | null;
  partyId: string | null;
  lines: RefundDraftLine[];
  tenders: RefundTenderMatch[];
  merchantTaxMinor: bigint;
  merchantTotalMinor: bigint;
}

/**
 * Expand one resolved refund into cash-refund document lines. Restocked
 * lines split per source-issue slice (each carries its own valuation
 * evidence and returns to the location its units left from); kit lines
 * explode into per-component evidence the return engine expands. Lines
 * carry positive amounts — the kernel's debit direction performs the
 * reversal — except discount lines, which stay negative like the sale's.
 */
export async function buildCashRefundLines(
  orgId: string,
  runner: SqlExecutor,
  resolved: ResolvedRefund,
): Promise<RefundDraftLine[]> {
  const lines: RefundDraftLine[] = [];
  const push = (
    line: Omit<RefundDraftLine, "taxAmount" | "taxes"> & { taxes: RefundDraftLine["taxes"] },
  ): void => {
    const taxMinor = line.taxes
      .filter((tax) => tax.collectedBy === "merchant" || !tax.facilitatorNetMode)
      .reduce((sum, tax) => sum + tax.amountMinor, 0n);
    lines.push({ ...line, taxAmount: minorToLedger(taxMinor, resolved.currency), taxes: line.taxes });
  };
  for (const line of resolved.lines) {
    const unitPrice = line.refundQuantity.denominator === 1n && line.refundQuantity.numerator > 0n
      ? minorToLedger(line.revenueMinor / line.refundQuantity.numerator, resolved.currency)
      : minorToLedger(line.revenueMinor, resolved.currency);
    const decimalQty = fractionToDecimalText(line.refundQuantity);
    if (!line.restock || !line.itemId) {
      // A commercial-only credit reverses money without naming an item: an
      // item line without a stock location cannot post, and with one it
      // would move stock the refund never claimed.
      push({
        title: line.title,
        itemId: null,
        accountId: line.accountId,
        quantity: decimalQty,
        unitPrice,
        amount: minorToLedger(line.revenueMinor, resolved.currency),
        promotionId: null,
        marketplaceFacilitator: line.marketplaceFacilitator,
        stockLocationId: null,
        customJson: "{}",
        taxes: line.taxes,
      });
    } else {
      const item = (await runner.execute<{ kind: string }>(sql`
        select kind from items where org_id = ${orgId} and id = ${line.itemId}`)).rows[0];
      if (!item) {
        park(
          "unmapped_item",
          `Refund ${resolved.externalId} line "${line.title}" no longer names a live item.`,
          "Restore the item under Products, or record the refund as a manual cash refund instead.",
        );
      }
      if (item.kind === "kit") {
        const components = await loadKitComponents(runner, orgId, line.itemId, resolved.documentDate);
        const kitLabelText = await kitLabel(runner, orgId, line.itemId);
        const kitQuantities = kitComponentQuantities(kitLabelText, quantity4dp(decimalQty), components);
        const kitSources: Array<{ sourceIssueMovementId: string; lotId: string | null; serialId: string | null }> = [];
        let kitLocation: string | null = null;
        for (const component of components) {
          const need = kitQuantities.find((entry) => entry.componentItemId === component.componentItemId)!.quantity;
          const { slices, stocked } = await allocateRestockSlices(
            orgId, runner, resolved.saleDocumentId, line.itemId, component.componentItemId,
            need, `${resolved.externalId} kit "${line.title}"`,
          );
          if (slices.length === 0) {
            if (!stocked) continue;
            park(
              "refund_unposted_order",
              `Refund ${resolved.externalId} restocks kit "${line.title}", but its sale never issued stock.`,
              "Record the order's fulfilment first, then replay the refund.",
            );
          }
          if (slices.length > 1) {
            // One kit line names one source per component: a component split
            // across shipments is a partial fulfilment the refund cannot
            // price as one line, so it parks instead of guessing.
            park(
              "over_refund",
              `Refund ${resolved.externalId} restocks kit "${line.title}" across several shipments.`,
              "Record the component returns directly against the sale, then post the money refund again without restock.",
            );
          }
          kitSources.push({
            sourceIssueMovementId: slices[0]!.movementId,
            lotId: slices[0]!.lotId,
            serialId: slices[0]!.serialId,
          });
          kitLocation = kitLocation ?? slices[0]!.stockLocationId;
        }
        // Components the sale never moved (non-stocked recipe lines) carry no
        // source and settle in money only: the return engine restores exactly
        // the stocked sources named here, so a mixed kit restocks what moved.
        if (kitSources.length === 0) {
          // No stocked components moved: the kit refund reverses money only.
          push({
            title: line.title,
            itemId: null,
            accountId: line.accountId,
            quantity: decimalQty,
            unitPrice,
            amount: minorToLedger(line.revenueMinor, resolved.currency),
            promotionId: null,
            marketplaceFacilitator: line.marketplaceFacilitator,
            stockLocationId: null,
            customJson: "{}",
            taxes: line.taxes,
          });
        } else {
          push({
            title: line.title,
            itemId: line.itemId,
            accountId: line.accountId,
            quantity: decimalQty,
            unitPrice,
            amount: minorToLedger(line.revenueMinor, resolved.currency),
            promotionId: null,
            marketplaceFacilitator: line.marketplaceFacilitator,
            stockLocationId: kitLocation,
            customJson: JSON.stringify({ inventoryReturn: { kitComponents: kitSources } }),
            taxes: line.taxes,
          });
        }
      } else {
        const need = toStockQuantity(line.refundQuantity, `${resolved.externalId} line "${line.title}"`);
        const { slices, stocked } = await allocateRestockSlices(
          orgId, runner, resolved.saleDocumentId, line.itemId, line.itemId,
          need, `${resolved.externalId} line "${line.title}"`,
        );
        if (slices.length === 0) {
          if (!stocked) {
            // A non-stocked item never moved inventory: the refund reverses
            // money only, like any commercial-only credit.
            push({
              title: line.title,
              itemId: null,
              accountId: line.accountId,
              quantity: decimalQty,
              unitPrice,
              amount: minorToLedger(line.revenueMinor, resolved.currency),
              promotionId: null,
              marketplaceFacilitator: line.marketplaceFacilitator,
              stockLocationId: null,
              customJson: "{}",
              taxes: line.taxes,
            });
            continue;
          }
          park(
            "refund_unposted_order",
            `Refund ${resolved.externalId} restocks "${line.title}", but its sale never issued stock.`,
            "Record the order's fulfilment first, then replay the refund.",
          );
        }
        // One document line per source slice: each names its own valuation
        // evidence and returns to the location its units left from. Money
        // and tax follow the slice pro-rata with the remainder on the last
        // slice, so split lines stay balanced; slices never merge.
        const needUnits = BigInt(need.replace(".", ""));
        let allocatedSlice = 0n;
        const allocatedTax = new Map<string, bigint>();
        for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
          const slice = slices[sliceIndex]!;
          const last = sliceIndex === slices.length - 1;
          const sliceUnits = BigInt(slice.quantity.replace(".", ""));
          const sliceAmount = last
            ? line.revenueMinor - allocatedSlice
            : (2n * line.revenueMinor * sliceUnits + needUnits) / (2n * needUnits);
          allocatedSlice += sliceAmount;
          push({
            title: slices.length === 1 ? line.title : `${line.title} (return ${sliceIndex + 1}/${slices.length})`,
            itemId: line.itemId,
            accountId: line.accountId,
            quantity: slice.quantity,
            unitPrice,
            amount: minorToLedger(sliceAmount, resolved.currency),
            promotionId: null,
            marketplaceFacilitator: line.marketplaceFacilitator,
            stockLocationId: slice.stockLocationId,
            customJson: JSON.stringify({
              inventoryReturn: {
                sourceIssueMovementId: slice.movementId,
                lotId: slice.lotId,
                serialId: slice.serialId,
              },
            }),
            // Tax follows the money slice so split lines stay balanced.
            taxes: line.taxes.map((tax, taxIndex) => {
              const key = `${taxIndex}`;
              const prior = allocatedTax.get(key) ?? 0n;
              const share = last
                ? tax.amountMinor - prior
                : (2n * tax.amountMinor * sliceUnits + needUnits) / (2n * needUnits);
              allocatedTax.set(key, prior + share);
              return { ...tax, amountMinor: share };
            }),
          });
        }
      }
    }
    if (line.discountMinor > 0n) {
      push({
        title: `Discount reversal — ${line.title}`,
        itemId: null,
        accountId: resolved.discountAccountId,
        quantity: "1",
        unitPrice: minorToLedger(-line.discountMinor, resolved.currency),
        amount: minorToLedger(-line.discountMinor, resolved.currency),
        promotionId: line.promotionId,
        // The reversal nets the refunded line's taxable base by the same
        // tax codes the sale's discount line carried, moving no tax.
        marketplaceFacilitator: line.marketplaceFacilitator,
        stockLocationId: null,
        customJson: "{}",
        taxes: discountTaxes(line.taxes),
      });
    }
  }
  if (resolved.shippingMinor > 0n) {
    push({
      title: "Shipping refund",
      itemId: null,
      accountId: resolved.shippingAccountId,
      quantity: "1",
      unitPrice: minorToLedger(resolved.shippingMinor, resolved.currency),
      amount: minorToLedger(resolved.shippingMinor, resolved.currency),
      promotionId: null,
      marketplaceFacilitator: null,
      stockLocationId: null,
      customJson: "{}",
      taxes: resolved.shippingTaxes,
    });
  }
  if (resolved.roundingMinor !== 0n && resolved.roundingAccountId) {
    push({
      title: "Refund rounding",
      itemId: null,
      accountId: resolved.roundingAccountId,
      quantity: "1",
      unitPrice: minorToLedger(resolved.roundingMinor, resolved.currency),
      amount: minorToLedger(resolved.roundingMinor, resolved.currency),
      promotionId: null,
      marketplaceFacilitator: null,
      stockLocationId: null,
      customJson: "{}",
      taxes: [],
    });
  }
  return lines;
}

function quantity4dp(decimal: string): string {
  const [whole, frac = ""] = decimal.trim().split(".");
  return `${whole}.${(frac + "0000").slice(0, 4)}`;
}

/** Exact fraction to decimal text (up to eight places, trailing zeros trimmed). */
function fractionToDecimalText(fraction: { numerator: bigint; denominator: bigint }): string {
  if (fraction.denominator === 1n) return fraction.numerator.toString();
  const scaled = fraction.numerator * 100_000_000n;
  const whole = scaled / fraction.denominator;
  if (scaled % fraction.denominator !== 0n) {
    throw new Error("Channel refund quantity exceeds stock precision");
  }
  const digits = whole.toString().padStart(9, "0");
  const head = digits.slice(0, -8).replace(/^(0+)(?=\d)/, "");
  const tail = digits.slice(-8).replace(/0+$/, "");
  return tail === "" ? head : `${head}.${tail}`;
}

interface BuiltRefundDocument {
  documentId: string;
  journalEntryId: string;
}

/**
 * Write one cash-refund draft and post it: numbered draft, lines with tax
 * components and return evidence, payout tenders, approval submission, then
 * the posting kernel. Restocks and gift-card top-ups ride the post-commit
 * effects, so a replay never moves stock or stored value twice. Idempotent
 * on (org, provider, external ref): a replay observes the posted document
 * instead of posting twice.
 */
export async function postCashRefundDraft(
  orgId: string,
  actor: string | null,
  draft: CashRefundDraft,
  idempotencyScope: string,
): Promise<BuiltRefundDocument> {
  const currency = draft.currency;
  let subtotalMinor = 0n;
  let taxMinor = 0n;
  for (const line of draft.lines) {
    // Draft amounts are exact ledger decimals produced from minor units, so
    // the shared conversion round-trips them without float math.
    subtotalMinor += BigInt(toMinorUnits(line.amount, currency));
    taxMinor += BigInt(toMinorUnits(line.taxAmount, currency));
  }
  const totalMinor = subtotalMinor + taxMinor;
  if (totalMinor !== draft.merchantTotalMinor) {
    throw new Error("Channel refund draft left while its lines balanced");
  }
  // Idempotency is per kind: the lookup must not observe a sibling
  // document sharing the storefront identity under another kind.
  const existing = (await db.execute<{ id: string; status: string; posted_entry_id: string | null }>(sql`
    select id, status, posted_entry_id from documents
     where org_id = ${orgId} and kind = 'cash_refund'
       and external_source = ${draft.provider} and external_ref = ${draft.externalRef}`)).rows[0];
  if (existing && existing.status === "posted" && existing.posted_entry_id) {
    return { documentId: existing.id, journalEntryId: existing.posted_entry_id };
  }
  let documentId: string;
  if (existing) {
    documentId = existing.id;
    await db.execute(sql`delete from document_line_tax_components where org_id = ${orgId} and document_line_id in (
      select id from document_lines where org_id = ${orgId} and document_id = ${documentId})`);
    const removed = await db.execute(sql`
      delete from document_lines where org_id = ${orgId} and document_id = ${documentId}`);
    void removed.rowCount;
  } else {
    const documentNumber = await allocateDocumentNumber(db, orgId, "cash_refund", "CR-");
    const inserted = await db.execute<{ id: string }>(sql`
      insert into documents
        (org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
         status, subtotal, tax_total, total, external_ref, external_source, source_channel_id, custom,
         created_by, updated_by)
      values (${orgId}, 'cash_refund', ${documentNumber}, ${draft.partyId}, ${draft.subsidiaryId},
        ${draft.documentDate}, ${currency}, 'draft',
        ${minorToLedger(subtotalMinor, currency)}, ${minorToLedger(taxMinor, currency)}, ${minorToLedger(totalMinor, currency)},
        ${draft.externalRef}, ${draft.provider}, ${draft.channelId},
        ${JSON.stringify({ channelOrderId: draft.orderId, channelRefundId: draft.refundId })}::jsonb,
        ${actor}, ${actor})
      returning id`);
    if (inserted.rows.length !== 1) throw new Error("Cash refund insert returned an unexpected row count");
    documentId = inserted.rows[0]!.id;
  }
  // Payout tenders ride document_tenders (never custom): the kernel's tender
  // assertion reads the table, and the post-commit effect tops up
  // stored-value tenders from it. Replaced on replay beside rebuilt lines.
  const tenderInputs: TenderInput[] = draft.tenders
    .filter((tender) => tender.amountMinor > 0n)
    .map((tender) => ({
      kind: tender.giftCardAccountId ? "stored_value" : "gateway",
      methodLabel: tender.gateway,
      accountId: tender.giftCardAccountId ? null : tender.accountId,
      storedValueAccountId: tender.giftCardAccountId,
      amount: minorToLedger(tender.amountMinor, currency),
      reference: null,
    }));
  await replaceDocumentTenders(db, orgId, documentId, tenderInputs, { actorId: actor });
  let lineNumber = 0;
  for (const line of draft.lines) {
    lineNumber += 1;
    const inserted = await db.execute<{ id: string }>(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, description, quantity,
         unit_price, amount, tax_amount, promotion_id, marketplace_facilitator, stock_location_id,
         custom, created_by, updated_by)
      values (${orgId}, ${documentId}, ${lineNumber}, ${line.itemId}, ${line.accountId},
        ${line.title}, ${line.quantity}, ${line.unitPrice}, ${line.amount},
        ${line.taxAmount}, ${line.promotionId}, ${line.marketplaceFacilitator},
        ${line.stockLocationId}, ${line.customJson}::jsonb, ${actor}, ${actor})
      returning id`);
    if (inserted.rows.length !== 1) throw new Error("Cash refund line insert returned an unexpected row count");
    const lineId = inserted.rows[0]!.id;
    let sequence = 0;
    for (const tax of line.taxes) {
      sequence += 1;
      await db.execute(sql`
        insert into document_line_tax_components
          (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
           tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
           collected_by, facilitator_name, collected_account_id, created_by, updated_by)
        values (${orgId}, ${lineId}, ${tax.taxCodeId}, ${sequence}, ${tax.ratePercent}, ${line.amount},
          ${minorToLedger(tax.amountMinor, currency)}, '0', ${minorToLedger(tax.amountMinor, currency)}, 'standard',
          ${tax.collectedBy}, ${tax.facilitatorName}, ${tax.liabilityAccountId}, ${actor}, ${actor})`);
    }
  }
  const submission = await submitAndReleaseIfUngated("cash_refund", documentId, actor);
  if (submission.gated) {
    // An approval policy holds the draft: the operator approves in the
    // document workflow, then replays the refund to post the approved draft.
    return { documentId, journalEntryId: "" };
  }
  if (submission.flowError) {
    throw new CommerceError(
      "channel_refund_approval_unroutable",
      `Cash refund approval could not be routed: ${submission.flowError}.`,
      "Route the cash-refund approval in the document workflow, then replay the refund.",
    );
  }
  const control = await loadRequiredControlAccounts(orgId);
  const journalEntryId = await postDocument(
    documentId,
    { control: { ar: control.ar, ap: control.ap, bank: control.bank } },
    { deferEffects: true, audit: { actorId: actor, source: "channel" } },
  );
  void idempotencyScope;
  return { documentId, journalEntryId };
}

/**
 * Post one stored refund event: resolve, then post one cash refund. A replay
 * never double-posts: a posted event returns its document, and the refund
 * draft is idempotent on the storefront refund identity. Summary-mode
 * refunds for today wait for tonight's batch; due days post now. Exceptions
 * park with code, reason and remedy; anything else propagates for retry.
 */
export async function postChannelRefund(
  orgId: string,
  actor: string | null,
  eventId: string,
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
    if (event.kind !== "refund") {
      throw new CommerceError(
        "channel_event_wrong_kind",
        `Channel event ${event.externalId} is a ${event.kind}, not a refund.`,
        "Post refunds from refund events and fulfilments from fulfilment events.",
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
        if (!live) throw new Error("Channel refund left while it posted");
        if (live.postingStatus === "posted") {
          return { status: "posted", documentId: live.postingDocumentId, effectsDocumentId: null as string | null };
        }
        if (live.postingStatus === "ignored") {
          return { status: "ignored", documentId: null as string | null, effectsDocumentId: null as string | null };
        }
        const order = await loadChannelOrder(orgId, live.orderId);
        if (!order) throw new Error("Channel refund order left while it posted");
        const refund = reviveRefundPayload(live.payload);
        const policy = await getPostingPolicy(orgId, order.channelId, refund.refundedAt.slice(0, 10));
        if (policy.mode === "daily_summary") {
          // Summary mode never parks a refund behind its sale: a pending
          // order waits for tonight's batch, and tonight's refunds join it.
          if (order.postingStatus === "pending" || order.postingStatus === "exception") {
            return { status: "pending", documentId: null as string | null, effectsDocumentId: null as string | null };
          }
          const shopToday = (await db.execute<{ day: string }>(sql`
            select ((now() at time zone ${policy.cutoffTz})::date)::text as day`)).rows[0]!.day;
          if (refund.refundedAt.slice(0, 10) >= shopToday) {
            return { status: "pending", documentId: null as string | null, effectsDocumentId: null as string | null };
          }
        }
        const resolved = await resolveRefundForPosting(orgId, actor, db, order, refund, eventId);
        const lines = await buildCashRefundLines(orgId, db, resolved);
        const merchantTaxMinor = lines.reduce((sum, line) => sum + BigInt(toMinorUnits(line.taxAmount, resolved.currency)), 0n);
        const built = await postCashRefundDraft(orgId, actor, {
          provider: resolved.provider,
          externalRef: resolved.externalId,
          channelId: resolved.channelId,
          orderId: resolved.orderId,
          refundId: resolved.externalId,
          documentDate: resolved.documentDate,
          currency: resolved.currency,
          subsidiaryId: resolved.subsidiaryId,
          partyId: resolved.partyId,
          lines,
          tenders: resolved.tenders,
          merchantTaxMinor,
          merchantTotalMinor: resolved.merchantTotalMinor,
        }, `channel-refund:${eventId}`);
        if (!built.journalEntryId) {
          // Approval-gated: hold the draft on the event without changing its
          // pending state, so the operator approves then replays.
          const held = await db.execute(sql`
            update channel_order_events
               set posting_document_id = ${built.documentId}, updated_by = ${actor}, updated_at = now()
             where org_id = ${orgId} and id = ${eventId} and posting_status in ('pending', 'exception')`);
          if (held.rowCount !== 1) {
            throw new Error("Channel refund hold matched no row; the event posted while it held");
          }
          return { status: "pending", documentId: built.documentId, effectsDocumentId: null as string | null };
        }
        await markChannelEventPosted(orgId, eventId, actor, built.documentId);
        await retireSiblingCancellations(orgId, order.id, actor);
        // A refunded cancellation completes the order's story: a governing
        // draft left behind closes with the refund that settled it.
        await maybeCloseGoverningOrder(orgId, actor, order.id);
        return { status: "posted", documentId: built.documentId, effectsDocumentId: built.documentId };
      });
      if (outcome.effectsDocumentId) {
        await runPostDocumentEffects(outcome.effectsDocumentId, "draft", { actorId: actor });
      }
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
      throw error;
    }
  });
}

/**
 * A paid cancellation is its refund: once the refund posts, a still-pending
 * sibling cancellation retires as ignored. A parked (exception) cancellation
 * keeps its own row — it has a problem of its own to solve.
 */
async function retireSiblingCancellations(orgId: string, orderId: string, actor: string | null): Promise<void> {
  await db.execute(sql`
    update channel_order_events
       set posting_status = 'ignored', updated_by = ${actor}, updated_at = now()
     where org_id = ${orgId} and order_id = ${orderId} and kind = 'cancellation' and posting_status = 'pending'`);
}

/**
 * Claim pending refund events for one channel day and currency, oldest
 * first, skipping rows another worker holds. The claim is the SELECT
 * itself: callers resolve each id through the batch document below, which
 * re-reads every row inside its own unit.
 */
export async function claimPendingRefundEvents(
  orgId: string,
  channelId: string,
  day: string,
  currency: string,
  cutoffTz: string,
  limit = 100,
): Promise<string[]> {
  const rows = (await db.execute<{ id: string }>(sql`
    select e.id from channel_order_events e
     join channel_orders o on o.org_id = e.org_id and o.id = e.order_id
     where e.org_id = ${orgId} and e.channel_id = ${channelId} and e.kind = 'refund'
       and e.posting_status = 'pending' and o.shop_currency = ${currency}
       and o.posting_status in ('posted', 'summarized')
       and ((e.occurred_at at time zone ${cutoffTz})::date)::text = ${day}
     order by e.occurred_at
     limit ${limit}
     for update of e skip locked`)).rows;
  return rows.map((row) => row.id);
}

export interface RefundBatchScope {
  channelId: string;
  provider: string;
  day: string;
  currency: string;
  subsidiaryId: string | null;
}

/**
 * Post one cash refund for a whole channel day: every claimed event's lines
 * land as their own lines (never merged, so restock evidence stays
 * per-refund), with one payout tender row per gateway and card. An event
 * that cannot resolve parks on its own and the rest still post. The batch
 * document is idempotent on its scope, and every event links to it — a
 * crash replays the scope instead of double-posting.
 */
export async function postRefundBatchDocument(
  orgId: string,
  actor: string | null,
  scope: RefundBatchScope,
  eventIds: string[],
): Promise<{ status: string; documentId: string | null; posted: number; parked: number }> {
  return withOrg(orgId, async () => {
    const outcome = await withOrgTransaction(orgId, async () => {
      await acquireOrgFeatureGateLock(db, orgId);
      if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
        throw new CommerceError("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
      }
      interface BatchedRefund {
        eventId: string;
        orderId: string;
        resolved: ResolvedRefund;
        eventLines: RefundDraftLine[];
      }
      const batched: BatchedRefund[] = [];
      let posted = 0;
      let parked = 0;
      for (const eventId of eventIds) {
        const live = await loadChannelEvent(orgId, eventId);
        if (!live || live.kind !== "refund" || live.postingStatus !== "pending") continue;
        const order = await loadChannelOrder(orgId, live.orderId);
        if (!order) continue;
        try {
          const refund = reviveRefundPayload(live.payload);
          const resolved = await resolveRefundForPosting(orgId, actor, db, order, refund, eventId);
          const eventLines = await buildCashRefundLines(orgId, db, resolved);
          batched.push({ eventId, orderId: order.id, resolved, eventLines });
          posted += 1;
        } catch (error) {
          if (error instanceof RefundPostException || error instanceof OrderPostException) {
            await markChannelEventException(orgId, eventId, actor, {
              code: error.code,
              reason: error.message,
              remedy: error.remedy,
            });
            parked += 1;
            continue;
          }
          throw error;
        }
      }
      if (batched.length === 0) {
        return { status: "empty", documentId: null as string | null, posted, parked, effectsDocumentIds: [] as string[] };
      }
      // One document per customer: the return engine matches every restock
      // line's source customer against the document's party, so anonymous
      // summary sales and named per-order sales never share a document.
      const groups = new Map<string, BatchedRefund[]>();
      for (const entry of batched) {
        const key = entry.resolved.saleAnonymous ? "walkin" : (entry.resolved.partyId ?? "walkin");
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
      }
      let firstDocumentId: string | null = null;
      const effectDocumentIds: string[] = [];
      let gated = false;
      for (const [key, entries] of groups) {
        const lines: RefundDraftLine[] = [];
        const tenders: RefundTenderMatch[] = [];
        for (const entry of entries) {
          for (const line of entry.eventLines) lines.push(line);
          for (const tender of entry.resolved.tenders) tenders.push(tender);
        }
        let merchantTaxMinor = 0n;
        let merchantTotalMinor = 0n;
        for (const line of lines) {
          merchantTaxMinor += BigInt(toMinorUnits(line.taxAmount, scope.currency));
          merchantTotalMinor += BigInt(toMinorUnits(line.amount, scope.currency));
        }
        merchantTotalMinor += merchantTaxMinor;
        const tenderTotal = tenders.reduce((sum, tender) => sum + tender.amountMinor, 0n);
        if (tenderTotal !== merchantTotalMinor) {
          throw new Error("Channel refund batch left while its tenders balanced");
        }
        const partyId = entries[0]!.resolved.saleAnonymous ? null : entries[0]!.resolved.partyId;
        const built = await postCashRefundDraft(orgId, actor, {
          provider: scope.provider,
          externalRef: `channel-refunds:${scope.channelId}:${scope.day}:${scope.currency}:${key === "walkin" ? "walkin" : key.slice(0, 8)}`,
          channelId: scope.channelId,
          orderId: entries[0]!.orderId,
          refundId: `batch:${scope.day}`,
          documentDate: scope.day,
          currency: scope.currency,
          subsidiaryId: scope.subsidiaryId,
          partyId,
          lines,
          tenders,
          merchantTaxMinor,
          merchantTotalMinor,
        }, `channel-refunds:${scope.channelId}:${scope.day}:${scope.currency}`);
        if (!built.journalEntryId) {
          for (const entry of entries) {
            const held = await db.execute(sql`
              update channel_order_events
                 set posting_document_id = ${built.documentId}, updated_by = ${actor}, updated_at = now()
               where org_id = ${orgId} and id = ${entry.eventId} and posting_status = 'pending'`);
            if (held.rowCount !== 1) {
              throw new Error("Channel refund batch hold matched no row; the event posted while it held");
            }
          }
          gated = true;
          firstDocumentId = firstDocumentId ?? built.documentId;
          continue;
        }
        for (const entry of entries) {
          await markChannelEventPosted(orgId, entry.eventId, actor, built.documentId);
        }
        firstDocumentId = firstDocumentId ?? built.documentId;
        effectDocumentIds.push(built.documentId);
      }
      const orderIds = new Set<string>();
      for (const entry of batched) orderIds.add(entry.orderId);
      for (const orderId of orderIds) {
        await retireSiblingCancellations(orgId, orderId, actor);
      }
      if (gated) {
        return { status: "pending", documentId: firstDocumentId, posted, parked, effectsDocumentIds: [] as string[] };
      }
      return { status: "posted", documentId: firstDocumentId, posted, parked, effectsDocumentIds: effectDocumentIds };
    });
    for (const documentId of outcome.effectsDocumentIds) {
      await runPostDocumentEffects(documentId, "draft", { actorId: actor });
    }
    return { status: outcome.status, documentId: outcome.documentId, posted: outcome.posted, parked: outcome.parked };
  });
}

/**
 * Post every due summary-mode refund batch: for each channel in
 * daily-summary mode, every shop day strictly before today with pending
 * refund events posts one cash refund beside the day's sales summary. A
 * crash replays the scope; claimed rows keep concurrent workers apart.
 */
export async function postDueRefundBatchesForOrg(
  orgId: string,
  actor: string | null,
): Promise<{ posted: number; parked: number }> {
  let posted = 0;
  let parked = 0;
  const channels = (await db.execute<{ channel_id: string }>(sql`
    select distinct e.channel_id from channel_order_events e
     where e.org_id = ${orgId} and e.kind = 'refund' and e.posting_status = 'pending'`)).rows;
  for (const channel of channels) {
    const meta = (await db.execute<{ kind: string; subsidiary_id: string | null }>(sql`
      select kind, subsidiary_id from sales_channels where org_id = ${orgId} and id = ${channel.channel_id}`)).rows[0];
    if (!meta) continue;
    let cutoffTz = "UTC";
    try {
      const today = (await db.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today;
      const policy = await getPostingPolicy(orgId, channel.channel_id, today);
      if (policy.mode !== "daily_summary") continue;
      cutoffTz = policy.cutoffTz;
    } catch {
      continue;
    }
    let shopToday: string;
    try {
      shopToday = (await db.execute<{ day: string }>(sql`
        select ((now() at time zone ${cutoffTz})::date)::text as day`)).rows[0]!.day;
    } catch {
      continue;
    }
    // The sweep only takes refunds whose sales already posted: refunds
    // behind still-pending orders join tonight's sales batch instead, so a
    // sales batch that has not run yet can never strand them as parked.
    const days = (await db.execute<{ day: string; currency: string }>(sql`
      select distinct ((e.occurred_at at time zone ${cutoffTz})::date)::text as day, o.shop_currency as currency
        from channel_order_events e
        join channel_orders o on o.org_id = e.org_id and o.id = e.order_id
       where e.org_id = ${orgId} and e.channel_id = ${channel.channel_id}
         and e.kind = 'refund' and e.posting_status = 'pending'
         and o.posting_status in ('posted', 'summarized')`)).rows;
    for (const day of days) {
      if (day.day >= shopToday) continue;
      const ids = await claimPendingRefundEvents(orgId, channel.channel_id, day.day, day.currency, cutoffTz);
      if (ids.length === 0) continue;
      const outcome = await postRefundBatchDocument(orgId, actor, {
        channelId: channel.channel_id,
        provider: meta.kind,
        day: day.day,
        currency: day.currency,
        subsidiaryId: meta.subsidiary_id,
      }, ids).catch(() => ({ status: "pending", documentId: null as string | null, posted: 0, parked: 0 }));
      if (outcome.status === "posted") posted += outcome.posted;
      parked += outcome.parked;
    }
  }
  return { posted, parked };
}
