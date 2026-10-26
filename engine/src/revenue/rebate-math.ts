import { add, cmp, fromUnits, roundDiv, mulPercent, neg, sum, toUnits } from "../money/money.ts";
import { canonicalDecimal, fixedDecimal, compareDecimal } from "../money/exact-decimal.ts";

export class RebateError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "RebateError";
    this.status = status;
  }
}
export type RebateMethod = "percent" | "per_unit" | "fixed_cost" | "guaranteed_margin";
export interface RebateTier {
  threshold: string;
  rate: string;
}
export interface RebateTerms {
  method: RebateMethod;
  tierBasis: "amount" | "quantity";
  tiers: RebateTier[];
  targetUnitCost: string | null;
  marginPercent: string | null;
}
export interface RebateLineBasis {
  id: string;
  amount: string;
  quantity: string;
  cost: string | null;
  marginRevenue?: string | null;
}
function exact(value: unknown, label: string, scale = 4): string {
  const canonical = canonicalDecimal(value, scale);
  if (canonical === null || canonical.startsWith("-"))
    throw new RebateError(`${label} requires a non-negative exact decimal`);
  return canonical;
}
export function validateRebateTerms(terms: RebateTerms) {
  if (
    !["percent", "per_unit", "fixed_cost", "guaranteed_margin"].includes(terms.method) ||
    !["amount", "quantity"].includes(terms.tierBasis)
  )
    throw new RebateError("Choose a supported rebate method and cumulative tier basis");
  if (!Array.isArray(terms.tiers) || terms.tiers.length > 100)
    throw new RebateError("Rebate tiers require at most one hundred rows");
  let last: string | null = null;
  for (const tier of terms.tiers) {
    const threshold = exact(tier.threshold, "Tier threshold");
    const rate = exact(tier.rate, "Tier rate");
    if (last !== null && cmp(threshold, last) <= 0)
      throw new RebateError("Rebate thresholds must increase strictly");
    if (terms.method === "percent" && cmp(rate, "100") > 0)
      throw new RebateError("A rebate percentage cannot exceed 100");
    last = threshold;
  }
  if (["percent", "per_unit"].includes(terms.method) && !terms.tiers.length)
    throw new RebateError("Configure at least one rebate tier");
  if (terms.method === "fixed_cost") exact(terms.targetUnitCost, "Guaranteed unit cost");
  if (
    terms.method === "guaranteed_margin" &&
    cmp(exact(terms.marginPercent, "Guaranteed margin"), "100") >= 0
  )
    throw new RebateError("Guaranteed margin must be less than 100 percent");
}

/** Retrospective tiers apply the earned tier to the full earning-period basis.
 * Negative returns lower that basis; posted accruals change only via deltas. */
function quantityUnits(value: string): bigint {
  const canonical = canonicalDecimal(value, 8);
  if (canonical === null)
    throw new RebateError("Rebate quantity requires an exact decimal with at most eight places");
  return BigInt(fixedDecimal(canonical, 8).replace(".", ""));
}
function quantityAmount(value: string, quantity: string): string {
  return fromUnits(roundDiv(toUnits(value) * quantityUnits(quantity), 100_000_000n));
}
export function earnedRebates(terms: RebateTerms, lines: RebateLineBasis[]): Map<string, string> {
  validateRebateTerms(terms);
  const qty = lines.reduce((n, l) => n + quantityUnits(l.quantity), 0n);
  const volume =
    terms.tierBasis === "amount"
      ? sum(lines.map((l) => l.amount))
      : `${qty < 0n ? "-" : ""}${(qty < 0n ? -qty : qty) / 100_000_000n}.${((qty < 0n ? -qty : qty) % 100_000_000n).toString().padStart(8, "0")}`;
  const tier = terms.tiers.filter((t) => compareDecimal(volume, t.threshold) >= 0).at(-1);
  const result = new Map<string, string>();
  for (const l of lines) {
    if (terms.method === "percent") result.set(l.id, tier ? mulPercent(l.amount, tier.rate) : "0");
    else if (terms.method === "per_unit")
      result.set(l.id, tier ? quantityAmount(tier.rate, l.quantity) : "0");
    else {
      if (l.cost === null)
        throw new RebateError(
          "Guaranteed-cost and margin rebates require posted inventory cost or an approved cost attestation",
        );
      if (terms.method === "guaranteed_margin" && l.marginRevenue == null)
        throw new RebateError("Guaranteed margin requires documented downstream resale revenue");
      const guarantee =
        terms.method === "fixed_cost"
          ? quantityAmount(terms.targetUnitCost!, l.quantity)
          : mulPercent(l.marginRevenue!, add("100", neg(terms.marginPercent!)));
      const rebate = add(l.cost, neg(guarantee));
      result.set(
        l.id,
        cmp(l.amount, "0") >= 0 && quantityUnits(l.quantity) >= 0n
          ? cmp(rebate, "0") > 0
            ? rebate
            : "0"
          : cmp(rebate, "0") < 0
            ? rebate
            : "0",
      );
    }
  }
  return result;
}
export interface RebateCandidate {
  agreementId: string;
  lineId: string;
  amount: string;
  stacking: "stack" | "best";
  selectionGroup: string;
}

/** Best-deal groups compete per line, separately for the customer's rebates
 * and each funding vendor. Stable identity breaks exact ties deterministically.
 * Stack agreements combine with the winning best-deal agreement. */
export function selectRebateDeals(candidates: RebateCandidate[]): RebateCandidate[] {
  const stacked = candidates.filter((c) => c.stacking === "stack");
  const groups = new Map<string, RebateCandidate>();
  for (const candidate of candidates
    .filter((c) => c.stacking === "best")
    .sort((a, b) => a.agreementId.localeCompare(b.agreementId))) {
    if (!candidate.selectionGroup.trim())
      throw new RebateError("A best-deal selection group is required");
    const key = `${candidate.lineId}:${candidate.selectionGroup}`;
    const winner = groups.get(key);
    // On a return, the most beneficial original deal is the greatest absolute rebate.
    const magnitude = toUnits(candidate.amount) < 0n ? neg(candidate.amount) : candidate.amount;
    const current = winner && (toUnits(winner.amount) < 0n ? neg(winner.amount) : winner.amount);
    if (!winner || cmp(magnitude, current!) > 0) groups.set(key, candidate);
  }
  return [...stacked, ...groups.values()];
}
