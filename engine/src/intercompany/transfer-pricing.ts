import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { roundDiv } from "../money/money.ts";
import { selectQuantityPrice } from "../sales/item-pricing.ts";
import { IntercompanyError } from "./errors.ts";

/**
 * Transfer pricing: the effective-dated price one entity charges a sister
 * entity. A policy belongs to a selling entity and optionally one buying
 * entity (a buyer-specific policy wins over the seller's general one), and
 * prices either from a price level's item price schedules or as the item's
 * cost plus a markup. It also names the eliminated revenue and cost accounts
 * the intercompany cross-charge posts to. Policies are configured in Setup;
 * a policy that has priced a charge keeps its terms (the storage guard), so
 * changing a transfer price means ending one policy and starting another.
 */

export type TransferPricingMethod = "price_level" | "cost_plus";

export type TransferPricingPolicy = {
  id: string;
  code: string;
  name: string;
  sellerSubsidiaryId: string;
  buyerSubsidiaryId: string | null;
  method: TransferPricingMethod;
  priceLevelId: string | null;
  markupPercent: string | null;
  revenueAccountId: string;
  costAccountId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

/**
 * The policy in effect for a seller, buyer and date: the buyer-specific one
 * when it exists, otherwise the seller's general policy; null when none.
 */
export async function transferPricingPolicyInEffect(
  runner: SqlExecutor,
  orgId: string,
  input: { sellerSubsidiaryId: string; buyerSubsidiaryId: string; date: string },
): Promise<TransferPricingPolicy | null> {
  const row = (
    await runner.execute<TransferPricingPolicy>(
      sql`
    select id, code, name, seller_subsidiary_id as "sellerSubsidiaryId", buyer_subsidiary_id as "buyerSubsidiaryId",
           method, price_level_id as "priceLevelId", markup_percent::text as "markupPercent",
           revenue_account_id as "revenueAccountId", cost_account_id as "costAccountId",
           effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
      from intercompany_transfer_pricing_policies
     where org_id = ${orgId} and is_active
       and seller_subsidiary_id = ${input.sellerSubsidiaryId}
       and (buyer_subsidiary_id = ${input.buyerSubsidiaryId} or buyer_subsidiary_id is null)
       and effective_from <= ${input.date}::date
       and (effective_to is null or effective_to >= ${input.date}::date)
     order by (buyer_subsidiary_id is null), effective_from desc
     limit 1
     for share`,
      "objects",
    )
  )[0];
  return row ?? null;
}

function scaledUnits(value: string, scale: number): bigint {
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const units =
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  return value.startsWith("-") ? -units : units;
}

/** Cost plus markup per unit, rounded half away from zero to eight decimals. */
export function costPlusUnitPrice(unitCost: string, markupPercent: string): string {
  const cost = canonicalDecimal(unitCost, 8);
  const markup = canonicalDecimal(markupPercent, 4);
  if (cost === null || compareDecimal(cost, "0") < 0)
    throw new IntercompanyError("the unit cost to mark up must be a non-negative amount");
  if (markup === null || compareDecimal(markup, "0") < 0)
    throw new IntercompanyError("the transfer pricing markup must be a non-negative percentage");
  // price = cost × (100 + markup) / 100, at cost scale 1e8 and markup scale 1e4.
  const costUnits = scaledUnits(cost, 8);
  const markupUnits = scaledUnits(markup, 4);
  const priceUnits = roundDiv(costUnits * (1_000_000n + markupUnits), 1_000_000n);
  const whole = priceUnits / 100_000_000n;
  const fraction = (priceUnits % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
}

/**
 * The item's unit price on a price level, in a currency, on a date, for a
 * quantity: the item's own schedule wins over its family's, and the latest
 * schedule in effect applies its quantity breaks. Null when the level has no
 * price for the item in that currency.
 */
export async function priceLevelUnitPrice(
  runner: SqlExecutor,
  orgId: string,
  input: { priceLevelId: string; itemId: string; currency: string; quantity: string; date: string },
): Promise<string | null> {
  const schedule = (
    await runner.execute<{ id: string }>(
      sql`
    select schedule.id
      from item_price_schedules schedule
      join price_levels level
        on level.org_id = schedule.org_id and level.id = schedule.price_level_id and level.is_active
     where schedule.org_id = ${orgId} and schedule.is_active
       and schedule.price_level_id = ${input.priceLevelId} and schedule.customer_id is null
       and schedule.currency = ${input.currency}
       and schedule.effective_from <= ${input.date}::date
       and (schedule.effective_to is null or schedule.effective_to >= ${input.date}::date)
       and (schedule.item_id = ${input.itemId}
            or (schedule.family_id is not null
                and schedule.family_id = (select family_id from items where org_id = ${orgId} and id = ${input.itemId})))
     order by (schedule.item_id = ${input.itemId}) desc nulls last, schedule.effective_from desc, schedule.revision desc
     limit 1`,
      "objects",
    )
  )[0];
  if (!schedule) return null;
  const breaks = await runner.execute<{ minimumQuantity: string; unitPrice: string }>(
    sql`
    select minimum_quantity::text as "minimumQuantity", unit_price::text as "unitPrice"
      from item_price_breaks
     where org_id = ${orgId} and schedule_id = ${schedule.id}`,
    "objects",
  );
  if (breaks.length === 0) return null;
  // A quantity below the smallest break prices at the smallest break.
  const selected =
    selectQuantityPrice(input.quantity, breaks) ??
    [...breaks].sort((a, b) => compareDecimal(a.minimumQuantity, b.minimumQuantity))[0]!;
  return selected.unitPrice;
}

/**
 * Price one transfer under a policy. `unitCost` is the seller's cost per unit
 * in its functional currency (the relieved cost for a fulfillment); a
 * price-level policy prices in `currency`. Refuses, naming the remedy, when
 * the level has no price for the item.
 */
export async function transferUnitPrice(
  runner: SqlExecutor,
  orgId: string,
  policy: TransferPricingPolicy,
  input: {
    itemId: string;
    itemLabel: string;
    quantity: string;
    date: string;
    currency: string;
    unitCost: string;
  },
): Promise<string> {
  if (policy.method === "cost_plus") {
    return costPlusUnitPrice(input.unitCost, policy.markupPercent ?? "0");
  }
  const price = await priceLevelUnitPrice(runner, orgId, {
    priceLevelId: policy.priceLevelId!,
    itemId: input.itemId,
    currency: input.currency,
    quantity: input.quantity,
    date: input.date,
  });
  if (price === null) {
    throw new IntercompanyError(
      `transfer pricing policy ${policy.code} prices from a price level with no ${input.currency} price for ${input.itemLabel} on ${input.date}; add the item to that price level or change the policy in Setup → Accounting → Transfer pricing`,
    );
  }
  return price;
}

export interface TransferPricingPolicyWrite {
  sellerSubsidiaryId?: unknown;
  buyerSubsidiaryId?: unknown;
  method?: unknown;
  priceLevelId?: unknown;
  markupPercent?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
}

/**
 * Validation a Setup write of a transfer pricing policy must pass before the
 * storage guard; returns the refusal to show, or null. Account eligibility,
 * active entities and the overlap rule are enforced again by storage.
 */
export function transferPricingPolicyRefusal(input: TransferPricingPolicyWrite): string | null {
  const seller = typeof input.sellerSubsidiaryId === "string" ? input.sellerSubsidiaryId : "";
  const buyer =
    typeof input.buyerSubsidiaryId === "string" && input.buyerSubsidiaryId
      ? input.buyerSubsidiaryId
      : null;
  if (!isUuid(seller)) return "Choose the selling subsidiary";
  if (buyer && !isUuid(buyer)) return "Choose a valid buying subsidiary";
  if (buyer === seller)
    return "A subsidiary cannot set transfer prices for sales to itself; choose a different buying subsidiary";
  const method = input.method;
  if (method !== "price_level" && method !== "cost_plus")
    return "Choose how transfer prices are set: a price level or cost plus a markup";
  const level =
    typeof input.priceLevelId === "string" && input.priceLevelId ? input.priceLevelId : null;
  const markup =
    input.markupPercent === null || input.markupPercent === undefined || input.markupPercent === ""
      ? null
      : canonicalDecimal(input.markupPercent, 4);
  if (method === "price_level") {
    if (!level) return "Choose the price level transfer prices come from";
    if (markup !== null)
      return "A price-level policy takes its prices from the level; clear the markup";
  } else {
    if (level) return "A cost-plus policy prices from cost; clear the price level";
    if (markup === null) return "Enter the markup percentage added to cost";
    if (compareDecimal(markup, "0") < 0 || compareDecimal(markup, "1000") > 0)
      return "The markup must be between 0 and 1000 percent";
  }
  const from = typeof input.effectiveFrom === "string" ? input.effectiveFrom : "";
  const to = typeof input.effectiveTo === "string" && input.effectiveTo ? input.effectiveTo : null;
  if (!isIsoCalendarDate(from)) return "Enter the date the policy takes effect";
  if (to && (!isIsoCalendarDate(to) || to < from))
    return "The end date must be on or after the start date";
  return null;
}
