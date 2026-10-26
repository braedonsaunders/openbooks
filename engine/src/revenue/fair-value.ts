import { canonicalDecimal, fixedDecimal } from "../money/exact-decimal.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";
import {
  add,
  cmp,
  mulPercent,
  fromUnits,
  toUnits,
  roundDiv,
  fitsLedgerRange,
  neg,
  sum,
} from "../money/money.ts";
import { allocateByRelativeSSP } from "./recognition-apportionment.ts";

export type FairValueMethod = "fixed" | "percent_of_list" | "cost_plus";
export interface FairValuePolicy {
  method: FairValueMethod;
  unitPrice: string;
  formulaPercent: string | null;
  listPrice: string | null;
  unitCost: string | null;
}

/** Formula inputs are currency-scoped, effective-dated policy values. A
 * calculated selling price is captured with the obligation, never re-evaluated
 * when rebuilding a posted contract. No executable user code enters pricing. */
export function calculatedFairValue(policy: FairValuePolicy): string {
  if (policy.method === "fixed") {
    if (cmp(policy.unitPrice, "0") < 0)
      throw new RevenueRecognitionError("Fair value must be non-negative");
    return policy.unitPrice;
  }
  if (policy.formulaPercent === null || cmp(policy.formulaPercent, "0") < 0) {
    throw new RevenueRecognitionError("A non-negative formula percentage is required");
  }
  const basis =
    policy.method === "percent_of_list"
      ? policy.listPrice
      : policy.method === "cost_plus"
        ? policy.unitCost
        : null;
  if (basis === null || cmp(basis, "0") < 0)
    throw new RevenueRecognitionError(
      "The dated fair-value formula requires its list price or unit cost",
    );
  const value = mulPercent(
    basis,
    policy.method === "cost_plus" ? add("100", policy.formulaPercent) : policy.formulaPercent,
  );
  if (!fitsLedgerRange(value))
    throw new RevenueRecognitionError(
      "Calculated fair value exceeds the ledger amount range; revise the dated formula terms",
    );
  return value;
}

export interface AllocationElement {
  allocation: string;
  ssp: string | null;
  booked: string;
  quantity: string | null;
}

/** Observable elements receive their extended VSOE; the non-negative residual
 * is apportioned over unobservable software elements by their booked weights.
 * Excluded elements retain their booked price outside the bundle. */
export function allocateRevenueBundle(elements: AllocationElement[]): string[] {
  const included = elements.filter((e) => e.allocation !== "exclude");
  const total = sum(included.map((e) => e.booked));
  if (!included.some((e) => e.allocation === "software")) {
    const allocated = allocateByRelativeSSP(total, included);
    let i = 0;
    return elements.map((e) => (e.allocation === "exclude" ? e.booked : allocated[i++]!));
  }
  const observable = included.filter((e) => e.allocation !== "software");
  const prices = observable.map((e) => {
    if (e.ssp === null || cmp(e.ssp, "0") <= 0)
      throw new RevenueRecognitionError(
        "Residual software allocation requires observable VSOE for every other element",
      );
    const quantity = canonicalDecimal(e.quantity ?? "1", 8);
    if (quantity === null || quantity.startsWith("-"))
      throw new RevenueRecognitionError("Revenue quantities require non-negative exact decimals");
    return fromUnits(
      roundDiv(toUnits(e.ssp) * BigInt(fixedDecimal(quantity, 8).replace(".", "")), 100_000_000n),
    );
  });
  const residual = add(total, neg(sum(prices)));
  if (cmp(residual, "0") < 0)
    throw new RevenueRecognitionError(
      "Observable VSOE exceeds bundle consideration; revise the agreement before recognition",
    );
  const unobservable = included.filter((e) => e.allocation === "software");
  const residualPrices = allocateByRelativeSSP(
    residual,
    unobservable.map((e) => ({ booked: e.booked })),
  );
  let observedIndex = 0,
    residualIndex = 0;
  return elements.map((e) =>
    e.allocation === "exclude"
      ? e.booked
      : e.allocation === "software"
        ? residualPrices[residualIndex++]!
        : prices[observedIndex++]!,
  );
}
