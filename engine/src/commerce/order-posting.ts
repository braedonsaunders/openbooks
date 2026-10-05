import { sql } from "drizzle-orm";
import type { ChannelOrderLine } from "./contracts.ts";
import { CommerceError } from "./errors.ts";
import { markOrderEconomicsDirty, recomputeOrderEconomicsScoped } from "./economics.ts";
import { findNative } from "./external-links.ts";
import {
  claimPendingChannelOrders,
  linkOrderDocument,
  loadChannelOrder,
  markOrderException,
  markOrderPosted,
  resolveCustomer,
  type ChannelOrderDetail,
} from "./orders.ts";
import { getPostingPolicy, type ChannelPostingPolicy } from "./posting-policies.ts";
import { replaceDocumentTenders, type TenderInput } from "../sales/document-tenders.ts";
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
import { issueSalesOrder } from "../sales/sales-orders.ts";
import { fromMinorUnits } from "../payments/acceptance.ts";
import { arePeriodModulesOpen, closeModuleForDocument, CloseError } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { createPromotion, setPromotionStatus } from "../sales/promotions.ts";
import { attachDocumentIssue } from "../stored-value/accounts.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

/**
 * Order posting exception codes. Each parks the order on the Exceptions tab
 * with the reason and the one-click remedy below — an order that cannot post
 * is never dropped and never posted to a fallback account.
 */
export const CHANNEL_ORDER_EXCEPTION_CODES = [
  "unmapped_item",
  "unmapped_location",
  "unmapped_account",
  "closed_period",
  "tax_mismatch",
  "currency_unsupported",
] as const;

export type ChannelOrderExceptionCode = (typeof CHANNEL_ORDER_EXCEPTION_CODES)[number];

/** A computed refusal that must reach the operator: caught at the boundary and parked, never swallowed. */
export class OrderPostException extends CommerceError {
  constructor(code: ChannelOrderExceptionCode, message: string, remedy: string) {
    super(code, message, remedy, { status: 422 });
    this.name = "OrderPostException";
  }
}

function park(code: ChannelOrderExceptionCode, message: string, remedy: string): never {
  throw new OrderPostException(code, message, remedy);
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Minor units to ledger decimal through the shared provider-scale conversion (signed-safe). */
function minorToLedger(minor: bigint, currency: string): string {
  return fromMinorUnits(minor, currency);
}

/** Format aggregated minor units back to a ledger decimal for summary lines and tenders. */
export function formatLedgerMinor(minor: bigint, currency: string): string {
  return fromMinorUnits(minor, currency);
}



interface ResolvedTax {
  jurisdiction: string;
  collectedBy: "merchant" | "marketplace";
  facilitatorName: string | null;
  facilitatorNetMode: boolean;
  taxCodeId: string;
  /** Merchant jurisdiction liability; null for marketplace-collected (facilitator clearing). */
  liabilityAccountId: string | null;
  ratePercent: string;
  /** Minor units, shop currency. */
  amountMinor: bigint;
}

interface ResolvedLine {
  title: string;
  itemId: string | null;
  accountId: string;
  quantity: string;
  unitPrice: string;
  /** Signed ledger amount, shop currency. */
  amount: string;
  /** Signed minor units behind the ledger amount. */
  amountMinor: bigint;
  kind: "product" | "shipping" | "discount" | "gift_issue";
  promotionId: string | null;
  marketplaceFacilitator: string | null;
  taxes: ResolvedTax[];
}

interface ResolvedTender {
  gateway: string;
  accountId: string;
  /** Ledger amount in the shop currency. */
  amount: string;
  amountMinor: bigint;
  giftCardAccountId: string | null;
  giftCardExternalId: string | null;
  reference: string | null;
}

export interface ResolvedOrder {
  order: ChannelOrderDetail;
  channelName: string;
  provider: string;
  externalAccount: string;
  subsidiaryId: string | null;
  policy: ChannelPostingPolicy;
  documentDate: string;
  stockLocationId: string;
  /** Who relieves the stock: OpenBooks at sale posting, or the storefront later through an inbound fulfilment. */
  fulfilledBy: "openbooks" | "storefront";
  customerPartyId: string | null;
  lines: ResolvedLine[];
  tenders: ResolvedTender[];
  /** Merchant-collected tax only; marketplace tax in net mode never reaches the merchant books. */
  merchantTaxMinor: bigint;
  marketplaceTaxMinor: bigint;
  merchantTotalMinor: bigint;
  paid: boolean;
  giftIssues: Array<{ amountMinor: bigint }>;
}

function orderDateOf(order: ChannelOrderDetail): string {
  const date = order.orderedAt.slice(0, 10);
  if (!isIsoCalendarDate(date)) {
    park(
      "tax_mismatch",
      `Order ${order.externalNumber} carries an unreadable order date.`,
      "Re-sync the order from the storefront so it arrives with its placed-at timestamp, then replay it.",
    );
  }
  return date;
}

async function loadPostChannel(
  orgId: string,
  channelId: string,
): Promise<{ name: string; kind: string; externalAccount: string; currency: string; subsidiaryId: string | null }> {
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
 * Resolve the shelf behind a channel sale, and who fulfils from it. When
 * OpenBooks fulfils, the sale issues at posting as usual. When the
 * storefront fulfils (a 3PL shelf with fulfils_orders off), the sale posts
 * governed by a sales order instead: the cash carries the 3PL shelf on its
 * lines for costing context, the kernel skips sale-time issue effects, and
 * the inbound fulfilment later issues exactly the unrelieved remainder —
 * so stock moves exactly once and a sale posted without issue is the
 * normal shape, not an error. Zero shelves or several both park: the remedy
 * names the Locations tab.
 */
async function resolveStockLocation(
  orgId: string,
  channelId: string,
  channelName: string,
): Promise<{ stockLocationId: string; fulfilledBy: "openbooks" | "storefront" }> {
  const links = (await db.execute<{ stock_location_id: string | null; fulfils_orders: boolean }>(sql`
    select stock_location_id, fulfils_orders from sales_channel_locations
     where org_id = ${orgId} and channel_id = ${channelId} and stock_location_id is not null`)).rows;
  const fulfil = links
    .filter((link) => link.fulfils_orders && link.stock_location_id)
    .map((link) => link.stock_location_id!);
  if (fulfil.length === 1) return { stockLocationId: fulfil[0]!, fulfilledBy: "openbooks" };
  const mapped = links.map((link) => link.stock_location_id).filter((id): id is string => !!id);
  if (fulfil.length === 0 && mapped.length === 1) return { stockLocationId: mapped[0]!, fulfilledBy: "storefront" };
  park(
    "unmapped_location",
    mapped.length === 0
      ? `Channel "${channelName}" has no fulfilment location, so order stock has nowhere to issue from.`
      : `Channel "${channelName}" has no single shelf to relieve, so order stock has no single place to issue from.`,
    "Map exactly one fulfilment location under Channels → Settings → Locations, then replay the order.",
  );
}

async function resolveItem(
  orgId: string,
  provider: string,
  externalAccount: string,
  line: ChannelOrderLine,
  orderNumber: string,
): Promise<{ itemId: string; incomeAccountId: string | null }> {
  if (line.variantExternalId) {
    const linked = await findNative(orgId, {
      provider,
      externalAccount,
      objectType: "variant",
      externalId: line.variantExternalId,
    });
    if (linked?.nativeTable === "items") {
      const item = (await db.execute<{ id: string; income_account_id: string | null }>(sql`
        select id, income_account_id from items
         where org_id = ${orgId} and id = ${linked.nativeId} and is_active`)).rows[0];
      if (item) return { itemId: item.id, incomeAccountId: item.income_account_id };
    }
  }
  const sku = cleanText(line.sku);
  if (sku) {
    const item = (await db.execute<{ id: string; income_account_id: string | null }>(sql`
      select id, income_account_id from items
       where org_id = ${orgId} and code = ${sku} and is_active
       order by created_at limit 1`)).rows[0];
    if (item) return { itemId: item.id, incomeAccountId: item.income_account_id };
  }
  park(
    "unmapped_item",
    `Order ${orderNumber} line "${line.title}" names SKU ${sku ?? "(none)"} with no matching item.`,
    `Match the storefront variant to an item under Channels → Products, or create the item from the exception row, then replay the order. Fixing one offers to fix every order blocked by the same SKU.`,
  );
}

function sanitizeJurisdiction(jurisdiction: string, orderNumber: string): string {
  const clean = jurisdiction.trim().toUpperCase().replaceAll(/[^A-Z0-9-]/g, "");
  if (!clean) {
    park(
      "tax_mismatch",
      `Order ${orderNumber} carries a tax line with no jurisdiction.`,
      "Re-sync the order from the storefront so every tax line names its jurisdiction, then replay it.",
    );
  }
  return clean;
}

/** Find or mint the sales tax code for a storefront jurisdiction. Same meaning, so a raced duplicate is benign. */
async function ensureChannelTaxCode(
  orgId: string,
  actor: string | null,
  jurisdiction: string,
  liabilityAccountId: string | null,
): Promise<string> {
  const code = `SHOP-${jurisdiction}`;
  const existing = (await db.execute<{ id: string }>(sql`
    select id from tax_codes where org_id = ${orgId} and code = ${code} limit 1`)).rows[0];
  if (existing) return existing.id;
  // A raced duplicate keeps the first row's meaning (same jurisdiction, same
  // liability), so re-read the winner instead of refusing a duplicate.
  const inserted = await db.execute<{ id: string }>(sql`
    insert into tax_codes (org_id, code, name, applies_to, collected_account_id, custom, created_by, updated_by)
    values (${orgId}, ${code}, ${`Storefront tax ${jurisdiction}`}, 'sale',
      ${liabilityAccountId}, '{}'::jsonb, ${actor}, ${actor})
    on conflict do nothing
    returning id`);
  const id = inserted.rows[0]?.id ?? (await db.execute<{ id: string }>(sql`
    select id from tax_codes where org_id = ${orgId} and code = ${code} limit 1`)).rows[0]?.id;
  if (!id) throw new Error(`Tax code ${code} could not be ensured; the jurisdiction mapping was lost`);
  return id;
}

async function facilitatorMode(
  orgId: string,
  facilitatorName: string,
): Promise<{ accountId: string; mode: string } | null> {
  const row = (await db.execute<{ clearing_account_id: string; collection_mode: string }>(sql`
    select clearing_account_id, collection_mode from marketplace_facilitators
     where org_id = ${orgId} and lower(name) = lower(${facilitatorName}) and is_active
     limit 1`)).rows[0];
  return row ? { accountId: row.clearing_account_id, mode: row.collection_mode } : null;
}

async function resolvePromotion(
  orgId: string,
  actor: string | null,
  runner: SqlExecutor,
  code: string,
  amountMinor: bigint,
  currency: string,
  discountAccountId: string,
  channelName: string,
  createOnMiss: boolean,
): Promise<string | null> {
  const clean = cleanText(code);
  if (!clean) return null;
  const existing = (await db.execute<{ id: string }>(sql`
    select id from promotions where org_id = ${orgId} and lower(code) = lower(${clean}) limit 1`)).rows[0];
  if (existing) return existing.id;
  // Creating a promotion is an attributed merchandising act: the unattended
  // scan leaves the discount unlinked and the operator's replay creates it.
  if (!createOnMiss || !actor) return null;
  let promotion;
  try {
    promotion = await createPromotion(runner, orgId, actor, {
      code: clean,
      name: `Storefront ${clean}`,
      description: `Created from storefront discount code ${clean} on channel ${channelName}.`,
      kind: "amount",
      amountMinor,
      currency,
      discountAccountId,
    });
  } catch (error) {
    if (error instanceof CommerceError) throw error;
    const refusal = error as { code?: string; status?: number };
    if (refusal?.code === "feature_disabled") return null;
    throw error;
  }
  try {
    await setPromotionStatus(runner, orgId, actor, promotion.id, "active");
  } catch {
    return promotion.id;
  }
  return promotion.id;
}

function parseQuantity(raw: string, orderNumber: string, title: string): { numerator: bigint; denominator: bigint; text: string } {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(raw.trim());
  if (!match) {
    park(
      "tax_mismatch",
      `Order ${orderNumber} line "${title}" carries an unreadable quantity.`,
      "Re-sync the order from the storefront so every line arrives with a positive quantity, then replay it.",
    );
  }
  const whole = BigInt(match[1]!);
  const frac = match[2] ?? "";
  if (whole === 0n && /^0+$/.test(frac)) {
    park(
      "tax_mismatch",
      `Order ${orderNumber} line "${title}" has zero quantity.`,
      "Re-sync the order from the storefront so every line arrives with a positive quantity, then replay it.",
    );
  }
  const denominator = 10n ** BigInt(frac.length);
  return { numerator: whole * denominator + (frac === "" ? 0n : BigInt(frac)), denominator, text: raw.trim() };
}

/** Line total in minor units, half-up on fractional quantities. */
function lineTotalMinor(priceMinor: bigint, numerator: bigint, denominator: bigint): bigint {
  return (2n * priceMinor * numerator + denominator) / (2n * denominator);
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

interface TaxAccumulators {
  merchantTaxMinor: bigint;
  marketplaceNetMinor: bigint;
  marketplaceGrossMinor: bigint;
}

async function resolveLineTaxes(
  orgId: string,
  actor: string | null,
  order: ChannelOrderDetail,
  line: ChannelOrderLine,
): Promise<{ taxes: ResolvedTax[]; acc: TaxAccumulators }> {
  const taxes: ResolvedTax[] = [];
  const acc: TaxAccumulators = { merchantTaxMinor: 0n, marketplaceNetMinor: 0n, marketplaceGrossMinor: 0n };
  for (const tax of line.taxLines) {
    const jurisdiction = sanitizeJurisdiction(tax.jurisdiction, order.externalNumber);
    const marketplace = tax.collectedBy.trim().toLowerCase() === "marketplace";
    let facilitatorName: string | null = null;
    let netMode = false;
    let liabilityAccountId: string | null = null;
    if (marketplace) {
      facilitatorName = tax.collectedBy.trim();
      const facilitator = await facilitatorMode(orgId, facilitatorName);
      if (!facilitator) {
        park(
          "unmapped_account",
          `Order ${order.externalNumber} carries marketplace-collected tax for "${jurisdiction}" with no matching facilitator.`,
          "Add the marketplace facilitator in Setup → Taxes → Marketplace facilitators (named exactly as the storefront reports it), then replay the order.",
        );
      }
      netMode = facilitator.mode === "net";
    } else {
      liabilityAccountId = await mappedAccount(orgId, order.channelId, "sales_tax_liability", jurisdiction, orderDateOf(order));
    }
    const taxCodeId = await ensureChannelTaxCode(orgId, actor, jurisdiction, liabilityAccountId);
    taxes.push({
      jurisdiction,
      collectedBy: marketplace ? "marketplace" : "merchant",
      facilitatorName,
      facilitatorNetMode: netMode,
      taxCodeId,
      liabilityAccountId,
      ratePercent: tax.ratePercent ?? "0",
      amountMinor: tax.amountMinor,
    });
    if (marketplace && netMode) acc.marketplaceNetMinor += tax.amountMinor;
    else if (marketplace) acc.marketplaceGrossMinor += tax.amountMinor;
    else acc.merchantTaxMinor += tax.amountMinor;
  }
  return { taxes, acc };
}

/**
 * Resolve one stored order into postable lines, tenders and totals.
 * Throws OrderPostException to park (the boundary records it), or
 * CommerceError to propagate (missing policy, unknown channel: the event
 * retries after the operator fixes configuration).
 */
export async function resolveOrderForPosting(
  orgId: string,
  actor: string | null,
  runner: SqlExecutor,
  order: ChannelOrderDetail,
): Promise<ResolvedOrder> {
  const channel = await loadPostChannel(orgId, order.channelId);
  const documentDate = orderDateOf(order);
  const policy = await getPostingPolicy(orgId, order.channelId, documentDate);
  if (order.shopCurrency !== channel.currency) {
    park(
      "currency_unsupported",
      `Order ${order.externalNumber} prices in ${order.shopCurrency} on a channel billing in ${channel.currency}.`,
      "Price the storefront in the channel currency, or connect a channel for the order's currency, then replay the order.",
    );
  }
  // Totals cross-foot: the storefront's arithmetic must agree with itself
  // before any journal reads it. Any disagreement parks as tax_mismatch
  // with the exact figures, never a plug.
  const footed = order.subtotalMinor + order.taxMinor + order.shippingMinor - order.discountMinor;
  if (footed !== order.totalMinor) {
    park(
      "tax_mismatch",
      `Order ${order.externalNumber} does not cross-foot (subtotal ${order.subtotalMinor} + tax ${order.taxMinor} + shipping ${order.shippingMinor} − discount ${order.discountMinor} ≠ total ${order.totalMinor}).`,
      "Re-sync the order from the storefront so its totals agree, then replay it.",
    );
  }
  let statedTaxMinor = 0n;
  for (const line of [...order.lines, ...order.shippingLines]) {
    for (const tax of line.taxLines) statedTaxMinor += tax.amountMinor;
  }
  if (statedTaxMinor !== order.taxMinor) {
    park(
      "tax_mismatch",
      `Order ${order.externalNumber} tax lines total ${statedTaxMinor} against the order tax total ${order.taxMinor}.`,
      "Re-sync the order from the storefront so its tax lines agree with its tax total, then replay it.",
    );
  }
  const { stockLocationId, fulfilledBy } = await resolveStockLocation(orgId, order.channelId, channel.name);
  const customerPartyId = await resolveCustomer(orgId, actor, {
    id: order.channelId,
    kind: channel.kind,
    name: channel.name,
    currency: channel.currency,
    externalAccount: channel.externalAccount,
  }, {
    externalId: order.externalId,
    number: order.externalNumber,
    customerExternalId: order.customerExternalId,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerAddress: order.customerAddress,
    tags: order.tags,
    source: order.source,
    shopCurrency: order.shopCurrency,
    presentmentCurrency: order.presentmentCurrency,
    subtotalMinor: order.subtotalMinor,
    taxMinor: order.taxMinor,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor,
    totalMinor: order.totalMinor,
    financialStatus: order.financialStatus,
    fulfilmentStatus: order.fulfilmentStatus,
    lines: order.lines,
    shippingLines: order.shippingLines,
    tenders: order.tenders,
    orderedAt: order.orderedAt,
    cancelledAt: order.cancelledAt,
  }, policy.guestCustomerPartyId);
  void runner;
  const revenueAccount = await mappedAccount(orgId, order.channelId, "revenue", "", documentDate);
  const discountAccount = await mappedAccount(orgId, order.channelId, "discount", "", documentDate);
  const shippingAccount = await mappedAccount(orgId, order.channelId, "shipping_income", "", documentDate);
  const giftLiabilityAccount = await mappedAccount(orgId, order.channelId, "gift_card_liability", "", documentDate);

  const lines: ResolvedLine[] = [];
  let merchantTaxMinor = 0n;
  let marketplaceNetMinor = 0n;
  let marketplaceGrossMinor = 0n;
  const giftIssues: Array<{ line: ChannelOrderLine; amountMinor: bigint }> = [];

  for (const line of order.lines) {
    const qty = parseQuantity(line.quantity, order.externalNumber, line.title);
    const grossMinor = lineTotalMinor(line.priceMinor, qty.numerator, qty.denominator);
    if (line.giftCard) {
      if (line.discountMinor !== 0n) {
        park(
          "tax_mismatch",
          `Order ${order.externalNumber} discounts a gift card purchase, which stored value cannot split.`,
          "Re-sync the order from the storefront without the gift card discount, then replay it.",
        );
      }
      const { taxes, acc } = await resolveLineTaxes(orgId, actor, order, line);
      merchantTaxMinor += acc.merchantTaxMinor;
      marketplaceNetMinor += acc.marketplaceNetMinor;
      marketplaceGrossMinor += acc.marketplaceGrossMinor;
      lines.push({
        title: line.title,
        itemId: null,
        accountId: giftLiabilityAccount,
        quantity: qty.text,
        unitPrice: minorToLedger(line.priceMinor, order.shopCurrency),
        amount: minorToLedger(grossMinor, order.shopCurrency),
        amountMinor: grossMinor,
        kind: "gift_issue",
        promotionId: null,
        marketplaceFacilitator: taxes.find((tax) => tax.collectedBy === "marketplace")?.facilitatorName ?? null,
        taxes,
      });
      giftIssues.push({ line, amountMinor: grossMinor });
      continue;
    }
    const { itemId, incomeAccountId } = await resolveItem(orgId, channel.kind, channel.externalAccount, line, order.externalNumber);
    // The line posts gross; the discount rides its own line below. The
    // kernel credits every line, so netting here would subtract it twice.
    if (line.discountMinor > grossMinor) {
      park(
        "tax_mismatch",
        `Order ${order.externalNumber} line "${line.title}" discounts below zero.`,
        "Re-sync the order from the storefront so no line discounts past free, then replay it.",
      );
    }
    const { taxes, acc } = await resolveLineTaxes(orgId, actor, order, line);
    merchantTaxMinor += acc.merchantTaxMinor;
    marketplaceNetMinor += acc.marketplaceNetMinor;
    marketplaceGrossMinor += acc.marketplaceGrossMinor;
    lines.push({
      title: line.title,
      itemId,
      accountId: incomeAccountId ?? revenueAccount,
      quantity: qty.text,
      unitPrice: minorToLedger(line.priceMinor, order.shopCurrency),
      amount: minorToLedger(grossMinor, order.shopCurrency),
      amountMinor: grossMinor,
      kind: "product",
      promotionId: null,
      marketplaceFacilitator: taxes.find((tax) => tax.collectedBy === "marketplace")?.facilitatorName ?? null,
      taxes,
    });
    if (line.discountMinor > 0n) {
      const promotionId = await resolvePromotion(
        orgId, actor, runner, line.discountCode ?? "", line.discountMinor,
        order.shopCurrency, discountAccount, channel.name, policy.createPromotionOnMatchMiss,
      );
      lines.push({
        title: `Discount${line.discountCode ? ` ${line.discountCode}` : ""} — ${line.title}`,
        itemId: null,
        accountId: discountAccount,
        quantity: "1",
        unitPrice: minorToLedger(-line.discountMinor, order.shopCurrency),
        amount: minorToLedger(-line.discountMinor, order.shopCurrency),
        amountMinor: -line.discountMinor,
        kind: "discount",
        promotionId,
        marketplaceFacilitator: null,
        taxes: [],
      });
    }
  }
  for (const ship of order.shippingLines) {
    if (ship.discountMinor > ship.amountMinor) {
      park(
        "tax_mismatch",
        `Order ${order.externalNumber} shipping "${ship.title}" discounts below zero.`,
        "Re-sync the order from the storefront so shipping never discounts past free, then replay it.",
      );
    }
    const { taxes, acc } = await resolveLineTaxes(orgId, actor, order, { ...ship, sku: null, variantExternalId: null, quantity: "1", priceMinor: ship.amountMinor, discountMinor: 0n, giftCard: false, promotionId: null, discountCode: null, title: ship.title });
    merchantTaxMinor += acc.merchantTaxMinor;
    marketplaceNetMinor += acc.marketplaceNetMinor;
    marketplaceGrossMinor += acc.marketplaceGrossMinor;
    lines.push({
      title: ship.title,
      itemId: null,
      accountId: shippingAccount,
      quantity: "1",
      unitPrice: minorToLedger(ship.amountMinor, order.shopCurrency),
      amount: minorToLedger(ship.amountMinor, order.shopCurrency),
      amountMinor: ship.amountMinor,
      kind: "shipping",
      promotionId: null,
      marketplaceFacilitator: taxes.find((tax) => tax.collectedBy === "marketplace")?.facilitatorName ?? null,
      taxes,
    });
    if (ship.discountMinor > 0n) {
      lines.push({
        title: `Discount — ${ship.title}`,
        itemId: null,
        accountId: discountAccount,
        quantity: "1",
        unitPrice: minorToLedger(-ship.discountMinor, order.shopCurrency),
        amount: minorToLedger(-ship.discountMinor, order.shopCurrency),
        amountMinor: -ship.discountMinor,
        kind: "discount",
        promotionId: null,
        marketplaceFacilitator: null,
        taxes: [],
      });
    }
  }

  // The merchant's books never touch net-mode marketplace tax: the
  // facilitator kept it. Tenders absorb it in order — what settled into the
  // merchant's clearing is what posts.
  const merchantTotalMinor = order.totalMinor - marketplaceNetMinor;
  let absorbNetMinor = marketplaceNetMinor;
  const tenders: ResolvedTender[] = [];
  let tenderMinor = 0n;
  for (const tender of order.tenders) {
    const gateway = cleanText(tender.gateway);
    if (!gateway) {
      park(
        "unmapped_account",
        `Order ${order.externalNumber} carries a tender with no gateway, so no clearing account can be resolved.`,
        "Re-sync the order from the storefront so every tender names its gateway, then replay it.",
      );
    }
    let amountMinor = tender.amountMinor;
    if (absorbNetMinor > 0n) {
      const cut = amountMinor < absorbNetMinor ? amountMinor : absorbNetMinor;
      amountMinor -= cut;
      absorbNetMinor -= cut;
    }
    if (tender.giftCardExternalId) {
      const linked = await findNative(orgId, {
        provider: channel.kind,
        externalAccount: channel.externalAccount,
        objectType: "gift_card",
        externalId: tender.giftCardExternalId,
      });
      const card = linked?.nativeTable === "stored_value_accounts"
        ? (await db.execute<{ id: string; balance_minor: string; currency: string }>(sql`
            select id, balance_minor, currency from stored_value_accounts
             where org_id = ${orgId} and id = ${linked.nativeId}`)).rows[0]
        : undefined;
      if (!card) {
        park(
          "unmapped_account",
          `Order ${order.externalNumber} tenders gift card "${tender.giftCardExternalId}", which is not linked to a stored-value account.`,
          "Link or issue the gift card under Stored value, then replay the order.",
        );
      }
      if (card.currency !== order.shopCurrency) {
        park(
          "currency_unsupported",
          `Order ${order.externalNumber} tenders a ${card.currency} gift card against a ${order.shopCurrency} order.`,
          "Tender the order in the gift card's currency, or issue a matching-currency card, then replay the order.",
        );
      }
      if (BigInt(card.balance_minor) < amountMinor) {
        // A card that cannot cover is an underpayment, not a refusal: the
        // order waits for the rest like any short tender.
        tenderMinor += 0n;
        tenders.push({
          gateway, accountId: giftLiabilityAccount, amount: "0", amountMinor: 0n,
          giftCardAccountId: null, giftCardExternalId: tender.giftCardExternalId, reference: tender.authorizationRef,
        });
        continue;
      }
      tenders.push({
        gateway, accountId: giftLiabilityAccount,
        amount: minorToLedger(amountMinor, order.shopCurrency), amountMinor,
        giftCardAccountId: card.id, giftCardExternalId: tender.giftCardExternalId, reference: tender.authorizationRef,
      });
      tenderMinor += amountMinor;
      continue;
    }
    const accountId = await mappedAccount(orgId, order.channelId, "gateway_clearing", gateway, documentDate);
    tenders.push({
      gateway, accountId,
      amount: minorToLedger(amountMinor, order.shopCurrency), amountMinor,
      giftCardAccountId: null, giftCardExternalId: null, reference: tender.authorizationRef,
    });
    tenderMinor += amountMinor;
  }
  if (absorbNetMinor > 0n) {
    park(
      "tax_mismatch",
      `Order ${order.externalNumber} marketplace tax exceeds its tenders, so the merchant share cannot be settled.`,
      "Re-sync the order from the storefront so its tenders cover its totals, then replay it.",
    );
  }
  const paid = tenderMinor === merchantTotalMinor;
  if (tenderMinor > merchantTotalMinor) {
    park(
      "tax_mismatch",
      `Order ${order.externalNumber} tenders ${tenderMinor} against its merchant total ${merchantTotalMinor}.`,
      "Re-sync the order from the storefront so its tenders match its totals, then replay it.",
    );
  }
  if (giftIssues.length > 0 && !(await findGiftCardProgram(orgId, order.shopCurrency))) {
    park(
      "unmapped_account",
      `Order ${order.externalNumber} sells a gift card with no gift card program to issue it from.`,
      "Create a gift card program in Setup → Sales → Stored value programs for this currency, then replay the order.",
    );
  }
  return {
    order,
    channelName: channel.name,
    provider: channel.kind,
    externalAccount: channel.externalAccount,
    subsidiaryId: channel.subsidiaryId,
    policy,
    documentDate,
    stockLocationId,
    fulfilledBy,
    customerPartyId,
    lines,
    tenders,
    merchantTaxMinor,
    marketplaceTaxMinor: marketplaceNetMinor + marketplaceGrossMinor,
    merchantTotalMinor,
    paid,
    giftIssues: giftIssues.map((issue) => ({ amountMinor: issue.amountMinor })),
  };
}

export interface CashSaleDraft {
  kind: "cash_sale";
  provider: string;
  /** Dedupe key: the order external id, or the summary batch id. */
  externalRef: string;
  channelId: string;
  documentDate: string;
  currency: string;
  subsidiaryId: string | null;
  partyId: string | null;
  stockLocationId: string;
  lines: ResolvedLine[];
  tenders: ResolvedTender[];
  merchantTaxMinor: bigint;
  merchantTotalMinor: bigint;
  giftIssues: Array<{ amountMinor: bigint }>;
}

/** One cash-sale draft per resolved order: tenders settle it in full, so the kernel cross-foots exactly. */
export function draftCashSaleForOrder(resolved: ResolvedOrder): CashSaleDraft {
  return {
    kind: "cash_sale",
    provider: resolved.provider,
    externalRef: resolved.order.externalId,
    channelId: resolved.order.channelId,
    documentDate: resolved.documentDate,
    currency: resolved.order.shopCurrency,
    subsidiaryId: resolved.subsidiaryId,
    partyId: resolved.customerPartyId,
    stockLocationId: resolved.stockLocationId,
    lines: resolved.lines,
    tenders: resolved.tenders,
    merchantTaxMinor: resolved.merchantTaxMinor,
    merchantTotalMinor: resolved.merchantTotalMinor,
    giftIssues: resolved.giftIssues,
  };
}

interface BuiltDocument {
  documentId: string;
  documentNumber: string;
  journalEntryId: string;
}

/**
 * Write one cash-sale draft and post it: numbered draft, lines with tax
 * components, tender evidence, approval submission, then the posting
 * kernel. Gift redemptions and issuances attach to the posted journal in
 * the same unit, so a replay never double-moves stored value. Idempotent
 * on (org, provider, external ref): a replay observes the posted document
 * instead of posting twice.
 */
export async function postCashSaleDraft(
  orgId: string,
  actor: string | null,
  draft: CashSaleDraft,
  idempotencyScope: string,
  options: { governFromSalesOrderIds?: string[] } = {},
): Promise<BuiltDocument> {
  const currency = draft.currency;
  // The subtotal is exact bigint minor-unit math from resolution — never
  // re-derived from rounded decimals.
  const subtotalMinor = draft.lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  const merchantTax = minorToLedger(draft.merchantTaxMinor, currency);
  const merchantTotal = minorToLedger(draft.merchantTotalMinor, currency);
  const merchantSubtotalLedger = minorToLedger(subtotalMinor, currency);

  // Idempotency is per kind: a governed sale's sibling sales order shares
  // the storefront order identity, so the lookup must not observe it.
  const existing = (await db.execute<{ id: string; status: string; posted_entry_id: string | null }>(sql`
    select id, status, posted_entry_id from documents
     where org_id = ${orgId} and kind = 'cash_sale'
       and external_source = ${draft.provider} and external_ref = ${draft.externalRef}`)).rows[0];
  if (existing && existing.status === "posted" && existing.posted_entry_id) {
    return { documentId: existing.id, documentNumber: "", journalEntryId: existing.posted_entry_id };
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
    const documentNumber = await allocateDocumentNumber(db, orgId, "cash_sale", "CS-");
    const inserted = await db.execute<{ id: string }>(sql`
      insert into documents
        (org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
         status, subtotal, tax_total, total, external_ref, external_source, source_channel_id, custom,
         created_by, updated_by)
      values (${orgId}, 'cash_sale', ${documentNumber}, ${draft.partyId}, ${draft.subsidiaryId},
        ${draft.documentDate}, ${currency}, 'draft',
        ${merchantSubtotalLedger}, ${merchantTax}, ${merchantTotal},
        ${draft.externalRef}, ${draft.provider}, ${draft.channelId},
        '{}'::jsonb, ${actor}, ${actor})
      returning id`);
    if (inserted.rows.length !== 1) throw new Error("Cash sale insert returned an unexpected row count");
    documentId = inserted.rows[0]!.id;
  }
  // Paid-at-sale tenders ride the document_tenders table (never custom):
  // the kernel's tender assertion reads the table, so a draft without
  // these rows cannot post. Replaced on replay beside the rebuilt lines.
  const tenderInputs: TenderInput[] = draft.tenders
    .filter((tender) => tender.amountMinor > 0n)
    .map((tender) => ({
      kind: tender.giftCardAccountId ? "stored_value" : "gateway",
      methodLabel: tender.gateway,
      accountId: tender.giftCardAccountId ? null : tender.accountId,
      storedValueAccountId: tender.giftCardAccountId,
      amount: tender.amount,
      reference: tender.reference,
    }));
  await replaceDocumentTenders(db, orgId, documentId, tenderInputs, { actorId: actor });
  let lineNumber = 0;
  const giftLineIds: string[] = [];
  for (const line of draft.lines) {
    lineNumber += 1;
    const lineTaxMinor = line.taxes
      .filter((tax) => tax.collectedBy === "merchant" || !tax.facilitatorNetMode)
      .reduce((sum, tax) => sum + tax.amountMinor, 0n);
    const inserted = await db.execute<{ id: string }>(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, description, quantity,
         unit_price, amount, tax_amount, promotion_id, marketplace_facilitator, stock_location_id,
         created_by, updated_by)
      values (${orgId}, ${documentId}, ${lineNumber}, ${line.itemId}, ${line.accountId},
        ${line.title}, ${line.quantity}, ${line.unitPrice}, ${line.amount},
        ${minorToLedger(lineTaxMinor, currency)}, ${line.promotionId}, ${line.marketplaceFacilitator},
        ${line.itemId ? draft.stockLocationId : null}, ${actor}, ${actor})
      returning id`);
    if (inserted.rows.length !== 1) throw new Error("Cash sale line insert returned an unexpected row count");
    const lineId = inserted.rows[0]!.id;
    if (line.kind === "gift_issue") giftLineIds.push(lineId);
    let sequence = 0;
    for (const tax of line.taxes) {
      sequence += 1;
      const taxable = line.amount;
      const componentTax = minorToLedger(tax.amountMinor, currency);
      await db.execute(sql`
        insert into document_line_tax_components
          (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
           tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
           collected_by, facilitator_name, collected_account_id, created_by, updated_by)
        values (${orgId}, ${lineId}, ${tax.taxCodeId}, ${sequence}, ${tax.ratePercent}, ${taxable},
          ${componentTax}, '0', ${componentTax}, 'standard',
          ${tax.collectedBy}, ${tax.facilitatorName}, ${tax.liabilityAccountId}, ${actor}, ${actor})`);
    }
  }
  // Storefront-fulfilled sales post governed: a 'bills' edge from each
  // sales order marks the cash fulfilment-governed, so the kernel skips
  // sale-time issue effects and the inbound fulfilment issues the stock
  // later. The edge is unique per (order, cash), so a replay re-observes
  // it instead of duplicating the governance.
  for (const salesOrderId of options.governFromSalesOrderIds ?? []) {
    await db.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
      values (${orgId}, ${salesOrderId}, ${documentId}, 'bills', ${actor}, ${actor})
      on conflict (org_id, from_document_id, to_document_id, link_type) do nothing`);
  }
  const submission = await submitAndReleaseIfUngated("cash_sale", documentId, actor);
  if (submission.gated) {
    // An approval policy holds the draft: the operator approves in the
    // document workflow, then replays the order to post the approved draft.
    return { documentId, documentNumber: "", journalEntryId: "" };
  }
  if (submission.flowError) {
    throw new CommerceError(
      "channel_order_approval_unroutable",
      `Cash sale approval could not be routed: ${submission.flowError}.`,
      "Route the cash-sale approval in the document workflow, then replay the order.",
    );
  }
  const control = await loadRequiredControlAccounts(orgId);
  const journalEntryId = await postDocument(
    documentId,
    { control: { ar: control.ar, ap: control.ap, bank: control.bank } },
    { deferEffects: true, audit: { actorId: actor, source: "channel" } },
  );
  // Stored-value tender redemptions ride the posting commit: it reads the
  // document_tenders table written above and redeems each exactly once, so
  // no direct redemption happens here (it would move the balance twice).
  const program = draft.giftIssues.length > 0 ? await findGiftCardProgram(orgId, currency) : null;
  if (draft.giftIssues.length > 0 && !program) {
    throw new OrderPostException(
      "unmapped_account",
      "The order sells a gift card with no gift card program to issue it from.",
      "Create a gift card program in Setup → Sales → Stored value programs for this currency, then replay the order.",
    );
  }
  let giftIndex = 0;
  for (const issue of draft.giftIssues) {
    giftIndex += 1;
    await attachDocumentIssue({
      orgId,
      programId: program!.id,
      amountMinor: issue.amountMinor,
      currency,
      customerPartyId: draft.partyId,
      sourceDocumentId: documentId,
      sourceLineId: giftLineIds[giftIndex - 1] ?? null,
      journalEntryId,
      idempotencyKey: `${idempotencyScope}:issue:${giftIndex}`,
      actorId: actor,
    });
  }
  return { documentId, documentNumber: "", journalEntryId };
}

async function findGiftCardProgram(orgId: string, currency: string): Promise<{ id: string } | null> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from stored_value_programs
     where org_id = ${orgId} and kind = 'gift_card' and is_active
       and (currency is null or currency = ${currency})
     order by created_at limit 1`)).rows[0];
  return row ? { id: row.id } : null;
}

async function assertPostingPeriodOpen(
  orgId: string,
  kind: string,
  subsidiaryId: string | null,
  date: string,
  orderNumber: string,
): Promise<void> {
  const bookId = await activePostingPrimaryBookId(orgId);
  if (!bookId) return;
  const period = await resolveCoveringPeriod(db, orgId, date);
  if (!period) return;
  let module: Parameters<typeof arePeriodModulesOpen>[1]["modules"][number];
  try {
    module = closeModuleForDocument(kind);
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
      `Order ${orderNumber} falls in closed period ${period.name}.`,
      "Reopen the period under Period close, or move the order date into an open period, then replay the order.",
    );
  }
}

async function summaryPostedForDay(
  orgId: string,
  channelId: string,
  day: string,
  currency: string,
): Promise<boolean> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from channel_daily_summaries
     where org_id = ${orgId} and channel_id = ${channelId}
       and summary_date = ${day} and currency = ${currency} and status = 'posted'
     limit 1`)).rows[0];
  return !!row;
}

/**
 * Post one stored order: resolve, check the period, then post one cash sale
 * (paid), one sales order (unpaid with the setting), or wait (unpaid without
 * it; summary mode before its cut-off). A replay never double-posts: a
 * posted order returns its document, and the cash-sale draft is idempotent
 * on the storefront order identity. Exceptions park with code, reason and
 * remedy; anything else propagates for the event retry.
 */
export async function postChannelOrder(
  orgId: string,
  actor: string | null,
  orderId: string,
  options: { forcePerOrder?: boolean } = {},
): Promise<{ status: string; documentId: string | null; code?: string }> {
  return withOrg(orgId, async () => {
    const order = await loadChannelOrder(orgId, orderId);
    if (!order) {
      throw new CommerceError(
        "channel_order_unknown",
        "The channel order does not belong to this organization.",
        "Choose an order from this organization's channel subledger.",
        { field: "orderId" },
      );
    }
    if (order.postingStatus === "posted" || order.postingStatus === "summarized" || order.postingStatus === "excluded") {
      return { status: order.postingStatus, documentId: order.postingDocumentId };
    }
    try {
      const outcome = await withOrgTransaction(orgId, async () => {
        await acquireOrgFeatureGateLock(db, orgId);
        if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
          throw new CommerceError("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
        }
        const live = await loadChannelOrder(orgId, orderId);
        if (!live) throw new Error("Channel order left while it posted");
        if (live.postingStatus === "posted" || live.postingStatus === "summarized" || live.postingStatus === "excluded") {
          return { status: live.postingStatus, documentId: live.postingDocumentId, effectsDocumentId: null as string | null };
        }
        const resolved = await resolveOrderForPosting(orgId, actor, db, live);
        if (!resolved.paid) {
          if (!resolved.policy.unpaidCreatesSalesOrder) return { status: "pending", documentId: null as string | null, effectsDocumentId: null as string | null };
          // Issuing is an operator-attributed approval act: the scan leaves
          // the order pending and the operator (or API caller) replays it.
          if (!actor) return { status: "pending", documentId: null as string | null, effectsDocumentId: null as string | null };
          await assertPostingPeriodOpen(orgId, "sales_order", resolved.subsidiaryId, resolved.documentDate, live.externalNumber);
          const documentId = await postUnpaidSalesOrder(orgId, actor, resolved);
          await markOrderPosted(orgId, orderId, actor, documentId);
          return { status: "posted", documentId, effectsDocumentId: documentId };
        }
        await assertPostingPeriodOpen(orgId, "cash_sale", resolved.subsidiaryId, resolved.documentDate, live.externalNumber);
        if (resolved.policy.mode === "daily_summary" && !options.forcePerOrder) {
          const day = live.orderedAt.slice(0, 10);
          if (!(await summaryPostedForDay(orgId, live.channelId, day, live.shopCurrency))) {
            return { status: "pending", documentId: null as string | null, effectsDocumentId: null as string | null };
          }
        }
        // A storefront-fulfilled sale posts governed by its own sales
        // order: the draft carries the order's lines on the 3PL shelf, and
        // the 'bills' edge tells the kernel to skip sale-time issue
        // effects — the inbound fulfilment issues the stock later. A sale
        // OpenBooks fulfils issues at posting, as before.
        const governIds =
          resolved.fulfilledBy === "storefront"
            ? [(await buildSalesOrderDraft(orgId, actor, resolved, governedSalesOrderRef(resolved.order.externalId))).documentId]
            : [];
        const built = await postCashSaleDraft(orgId, actor, draftCashSaleForOrder(resolved), `channel-order:${orderId}`,
          governIds.length > 0 ? { governFromSalesOrderIds: governIds } : undefined);
        if (!built.journalEntryId) {
          await linkOrderDocument(orgId, orderId, actor, built.documentId);
          return { status: "pending", documentId: built.documentId, effectsDocumentId: null as string | null };
        }
        await markOrderPosted(orgId, orderId, actor, built.documentId);
        return { status: "posted", documentId: built.documentId, effectsDocumentId: built.documentId };
      });
      if (outcome.effectsDocumentId) {
        await runPostDocumentEffects(outcome.effectsDocumentId, "draft", { actorId: actor });
      }
      // Margin facts follow the posting and never block it: the stock issues
      // land in the effects above, so economics reads them here; a refusal
      // parks a restatement mark for the channel scan instead of failing
      // an order that already posted.
      if (outcome.status === "posted" && outcome.documentId) {
        try {
          await recomputeOrderEconomicsScoped(orgId, actor, orderId);
        } catch {
          await markOrderEconomicsDirty(orgId, orderId, "order posted").catch(() => null);
        }
      }
      return { status: outcome.status, documentId: outcome.documentId };
    } catch (error) {
      if (error instanceof OrderPostException) {
        await markOrderException(orgId, orderId, actor, { code: error.code, reason: error.message, remedy: error.remedy });
        return { status: "exception", documentId: null, code: error.code };
      }
      throw error;
    }
  });
}

/**
 * Find the sales order already governing a storefront order, if one
 * survived an earlier attempt: the gated-cash path commits the order row
 * before the operator approves the cash, so a replay must observe the
 * draft instead of billing the order twice.
 */
async function findGoverningSalesOrder(
  orgId: string,
  provider: string,
  externalRef: string,
): Promise<{ id: string; status: string } | null> {
  const row = (await db.execute<{ id: string; status: string }>(sql`
    select id, status from documents
     where org_id = ${orgId} and kind = 'sales_order'
       and external_source = ${provider} and external_ref = ${externalRef}
       and status != 'voided'
     order by created_at desc limit 1`)).rows[0];
  return row ?? null;
}

/**
 * External identity of the draft sales order governing a
 * storefront-fulfilled sale: namespaced so it never collides with the
 * sibling cash under the cross-kind (org, source, ref) unique key.
 */
export function governedSalesOrderRef(orderExternalId: string): string {
  return `channel-sales-order:${orderExternalId}`;
}

/**
 * Build the draft sales order behind a storefront order: the same lines,
 * parties and tax the cash carries, on the order's own shelf. The caller
 * decides what the draft governs — an unpaid order issues it as the open
 * order under the storefront order identity, a paid storefront-fulfilled
 * order leaves it draft under the governed ref and links it over its cash
 * so the kernel skips sale-time issue effects.
 */
export async function buildSalesOrderDraft(
  orgId: string,
  actor: string | null,
  resolved: ResolvedOrder,
  externalRef: string,
): Promise<{ documentId: string; preExisting: boolean }> {
  const reuse = await findGoverningSalesOrder(orgId, resolved.provider, externalRef);
  if (reuse) return { documentId: reuse.id, preExisting: true };
  const documentNumber = await allocateDocumentNumber(db, orgId, "sales_order", "SO-");
  const currency = resolved.order.shopCurrency;
  const docSubtotal = minorToLedger(resolved.lines.reduce((sum, line) => sum + line.amountMinor, 0n), currency);
  const docTax = minorToLedger(resolved.merchantTaxMinor, currency);
  const docTotal = minorToLedger(
    resolved.lines.reduce((sum, line) => sum + line.amountMinor, 0n) + resolved.merchantTaxMinor,
    currency,
  );
  const inserted = await db.execute<{ id: string }>(sql`
    insert into documents
      (org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
       status, subtotal, tax_total, total, external_ref, external_source, source_channel_id,
       created_by, updated_by)
    values (${orgId}, 'sales_order', ${documentNumber}, ${resolved.customerPartyId}, ${resolved.subsidiaryId},
      ${resolved.documentDate}, ${currency}, 'draft',
      ${docSubtotal}, ${docTax}, ${docTotal},
      ${externalRef}, ${resolved.provider}, ${resolved.order.channelId},
      ${actor}, ${actor})
    returning id`);
  if (inserted.rows.length !== 1) throw new Error("Sales order insert returned an unexpected row count");
  const documentId = inserted.rows[0]!.id;
  let lineNumber = 0;
  for (const line of resolved.lines) {
    lineNumber += 1;
    const lineTaxMinor = line.taxes
      .filter((tax) => tax.collectedBy === "merchant" || !tax.facilitatorNetMode)
      .reduce((sum, tax) => sum + tax.amountMinor, 0n);
    const insertedLine = await db.execute<{ id: string }>(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, description, quantity,
         unit_price, amount, tax_amount, promotion_id, marketplace_facilitator, stock_location_id,
         created_by, updated_by)
      values (${orgId}, ${documentId}, ${lineNumber}, ${line.itemId}, ${line.accountId},
        ${line.title}, ${line.quantity}, ${line.unitPrice}, ${line.amount},
        ${minorToLedger(lineTaxMinor, currency)}, ${line.promotionId}, ${line.marketplaceFacilitator},
        ${line.itemId ? resolved.stockLocationId : null}, ${actor}, ${actor})
      returning id`);
    if (insertedLine.rows.length !== 1) throw new Error("Sales order line insert returned an unexpected row count");
    const lineId = insertedLine.rows[0]!.id;
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
  return { documentId, preExisting: false };
}

/**
 * Post the open sales order for an unpaid storefront order the merchant
 * fulfils: build the draft (reusing one a replay left behind) and issue it
 * through the engine-owned boundary. An already-issued order is observed,
 * never issued twice.
 */
async function postUnpaidSalesOrder(orgId: string, actor: string, resolved: ResolvedOrder): Promise<string> {
  // The open order keeps the storefront order identity: shipment chains
  // match it back to the channel order through this ref.
  const built = await buildSalesOrderDraft(orgId, actor, resolved, resolved.order.externalId);
  if (built.preExisting) {
    const status = (await db.execute<{ status: string }>(sql`
      select status from documents where id = ${built.documentId} and org_id = ${orgId}`)).rows[0]?.status;
    if (status && status !== "draft") return built.documentId;
  }
  const token = (await db.execute<{ updated_at: string }>(sql`
    select revision_seq::text as updated_at from documents where id = ${built.documentId} and org_id = ${orgId}`)).rows[0];
  if (!token) throw new Error("Sales order left while it issued");
  await issueSalesOrder({ orgId, salesOrderId: built.documentId, actorId: actor, expectedUpdatedAt: token.updated_at });
  return built.documentId;
}

/** Post every pending order for one org, oldest first: posted, parked, or still waiting. */
export async function postPendingChannelOrders(
  orgId: string,
  actor: string | null,
  limit = 100,
): Promise<{ posted: number; parked: number; waiting: number }> {
  return withOrg(orgId, async () => {
    const ids = await claimPendingChannelOrders(orgId, limit);
    let posted = 0;
    let parked = 0;
    let waiting = 0;
    for (const id of ids) {
      const outcome = await postChannelOrder(orgId, actor, id);
      if (outcome.status === "posted") posted += 1;
      else if (outcome.status === "exception") parked += 1;
      else waiting += 1;
    }
    return { posted, parked, waiting };
  });
}


