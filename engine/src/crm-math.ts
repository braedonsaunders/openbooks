import { cmp, fromUnits, roundDiv, sum, toUnits } from "./money.ts";

const SCALE = 10_000n;

export type CrmLifecycleStage = "lead" | "prospect" | "customer";
export type ForecastCategory = "omitted" | "worst_case" | "most_likely" | "upside";

const LIFECYCLE_RANK: Record<CrmLifecycleStage, number> = { lead: 0, prospect: 1, customer: 2 };

export function shouldPromoteLifecycle(current: CrmLifecycleStage, requested: CrmLifecycleStage): boolean {
  return LIFECYCLE_RANK[requested] > LIFECYCLE_RANK[current];
}

/** Exact numeric(19,4) multiplication, rounded half away from zero. */
export function multiplyDecimal(a: string, b: string): string {
  const product = toUnits(a) * toUnits(b);
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + SCALE / 2n) / SCALE;
  return fromUnits(negative ? -rounded : rounded);
}

/** Exact weighted amount at an integer close probability. */
export function weightAmount(amount: string, probability: number): string {
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new Error("probability must be an integer from 0 to 100");
  }
  const product = toUnits(amount) * BigInt(probability);
  const rounded = (product + 50n) / 100n;
  return fromUnits(rounded);
}

/**
 * Weight a signed amount by an integer probability, halves away from zero.
 *
 * `weightAmount` exists for revenue, which the schema constrains to be
 * non-negative, and its `(product + 50) / 100` rounds halves UP — correct for
 * a non-negative input, wrong for a negative one (it would round -0.5 to 0
 * rather than to -1, biasing a loss toward zero). Gross profit is signed, so
 * it weights through here instead. For non-negative inputs the two agree
 * exactly, so nothing about stored expected amounts changes.
 */
function weightSignedAmount(amount: string, probability: number): string {
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new Error("probability must be an integer from 0 to 100");
  }
  return fromUnits(roundDiv(toUnits(amount) * BigInt(probability), 100n));
}

/**
 * Gross margin as an exact percentage at money scale (4 decimals), or null
 * when the ratio has no meaning.
 *
 * Two distinct cases return null and a caller must not collapse them into a
 * number: a line nobody costed (`cost` is null) has no margin to report, and a
 * line with no revenue has no denominator. Zero revenue is null even when the
 * cost is positive — "infinitely negative margin" is not a figure anyone can
 * act on, and rendering it as a very large negative number would be a
 * fabricated quantity. Both surface as "not available", never as 0%, because
 * 0% is a real and very different claim.
 */
export function grossMarginPercent(revenue: string, cost: string | null): string | null {
  if (cost === null) return null;
  const revenueUnits = toUnits(revenue);
  // Revenue is non-negative by construction (line amounts are refused below
  // zero and the header is their sum), so this is exactly the no-denominator
  // case rather than a sign question.
  if (revenueUnits <= 0n) return null;
  const profitUnits = revenueUnits - toUnits(cost);
  // percent = profit / revenue * 100, carried at 1e4 units like every other
  // decimal in this module. Exact integer arithmetic throughout: no float
  // ever touches a figure a salesperson negotiates against.
  return fromUnits(roundDiv(profitUnits * 1_000_000n, revenueUnits));
}

export interface OpportunityLineMathInput {
  quantity: string;
  unitPrice: string;
  probability?: number | null;
  /** Expected cost per unit. null/undefined means "cost not recorded". */
  unitCost?: string | null;
}

export function computeOpportunityTotals(lines: OpportunityLineMathInput[], probability: number) {
  const calculated = lines.map((line) => {
    const amount = multiplyDecimal(line.quantity, line.unitPrice);
    if (cmp(amount, "0") < 0) throw new Error("opportunity line amount cannot be negative");
    const lineProbability = line.probability ?? probability;
    // Cost is optional and, when present, extends exactly as price does, so a
    // reader reconciling the stored cost_amount reproduces the writer's
    // rounding rather than its own.
    const unitCost = line.unitCost ?? null;
    if (unitCost !== null && cmp(unitCost, "0") < 0) {
      throw new Error("opportunity line unit cost cannot be negative");
    }
    const costAmount = unitCost === null ? null : multiplyDecimal(line.quantity, unitCost);
    // Deliberately NOT clamped at zero: a line sold below cost reports a
    // negative gross profit, which is the fact the margin report exists for.
    const grossProfit = costAmount === null ? null : fromUnits(toUnits(amount) - toUnits(costAmount));
    return {
      ...line,
      amount,
      probability: lineProbability,
      expectedAmount: weightAmount(amount, lineProbability),
      unitCost,
      costAmount,
      grossProfit,
      grossMarginPercent: grossMarginPercent(amount, costAmount),
    };
  });
  const projectedAmount = sum(calculated.map((line) => line.amount));
  // A header cost is only honest when every line carries one. Summing the
  // costed lines alone would present a partial cost as the deal's cost and
  // flatter the margin by exactly the lines nobody has priced out yet, so the
  // rollup reports null and the counts let a caller explain why.
  const costedLines = calculated.filter((line) => line.costAmount !== null);
  const isFullyCosted = calculated.length > 0 && costedLines.length === calculated.length;
  const totalCost = isFullyCosted ? sum(costedLines.map((line) => line.costAmount!)) : null;
  const grossProfit = totalCost === null ? null : fromUnits(toUnits(projectedAmount) - toUnits(totalCost));
  return {
    lines: calculated,
    projectedAmount,
    // Weighted follows the line detail: each line's own probability override,
    // else the header probability. Applying the header rate wholesale would
    // contradict the stored per-line expected_amounts.
    weightedAmount: sum(calculated.map((line) => line.expectedAmount)),
    totalCost,
    grossProfit,
    grossMarginPercent: grossMarginPercent(projectedAmount, totalCost),
    // Weighted profit follows the same line-by-line rule as weighted revenue,
    // so a deal whose lines close at different probabilities cannot report a
    // profit its own lines do not add up to.
    weightedGrossProfit: totalCost === null
      ? null
      : sum(calculated.map((line) => weightSignedAmount(line.grossProfit!, line.probability))),
    lineCount: calculated.length,
    costedLineCount: costedLines.length,
    isFullyCosted,
  };
}

/**
 * What a stage declares it requires (crm_opportunity_statuses, migration
 * 0175). Deliberately just the flags: the resolver must not be able to reach
 * for a stage's name or key, because the moment it can, an organization that
 * renames "Proposal" gets different rules than one that did not.
 */
export interface OpportunityStagePolicy {
  requiresLines: boolean;
  requiresPrimaryContact: boolean;
  requiresPositiveAmount: boolean;
  requiresWinLossReason: boolean;
}

/** The opportunity as it will stand AFTER the write being validated. */
export interface OpportunityStageSubject {
  lineCount: number;
  hasPrimaryContact: boolean;
  projectedAmount: string;
  winLossReason?: string | null;
}

/**
 * Stable machine codes, not sentences. The engine has no locale; each caller
 * maps these to its own message so the API, the board and the drawer can word
 * the same refusal for their own surface.
 */
export type OpportunityStageRefusal =
  | "lines_required"
  | "primary_contact_required"
  | "positive_amount_required"
  | "win_loss_reason_required";

/**
 * The single stage gate. Every writer — the edit API, the pipeline board, data
 * import, user scripts, the assistant — calls this, so a transition refused on
 * one surface is refused on all of them for the same reason.
 *
 * This is a stage INVARIANT, not a one-time entry check: it is evaluated
 * against the state a write would leave behind, every time, exactly as the
 * hard-coded loss-reason rule it replaces already behaved. The consequence is
 * worth stating plainly, because it surprises people: turning a requirement on
 * means existing deals already sitting in that stage without it must satisfy
 * it on their next save. That is the honest reading of "this stage requires a
 * contact" — the alternative silently exempts precisely the records the
 * administrator turned the rule on for.
 *
 * Returns null when the transition is allowed. Order is fixed so the same
 * violation always reports the same way.
 */
export function validateOpportunityStageTransition(
  subject: OpportunityStageSubject,
  policy: OpportunityStagePolicy,
): OpportunityStageRefusal | null {
  if (policy.requiresLines && subject.lineCount < 1) return "lines_required";
  if (policy.requiresPrimaryContact && !subject.hasPrimaryContact) return "primary_contact_required";
  // Strictly positive. The schema already refuses a negative projected amount,
  // so the question this gate answers is "is it priced", not "is it sane".
  if (policy.requiresPositiveAmount && cmp(subject.projectedAmount, "0") <= 0) {
    return "positive_amount_required";
  }
  if (policy.requiresWinLossReason && !subject.winLossReason?.trim()) return "win_loss_reason_required";
  return null;
}

export function validateContributionTotal(contributions: string[]): void {
  if (contributions.length === 0) return;
  if (sum(contributions) !== "100.0000") throw new Error("sales-team contribution must total exactly 100%");
  if (contributions.some((value) => cmp(value, "0") <= 0)) throw new Error("sales-team contribution must be positive");
}

export interface ForecastOpportunity {
  amount: string;
  weightedAmount: string;
  category: ForecastCategory;
  closedWon?: boolean;
}

export function rollupForecast(opportunities: ForecastOpportunity[]) {
  const open = opportunities.filter((opportunity) => !opportunity.closedWon && opportunity.category !== "omitted");
  const byCategory = (category: ForecastCategory) =>
    sum(open.filter((opportunity) => opportunity.category === category).map((opportunity) => opportunity.amount));
  return {
    pipelineAmount: sum(open.map((opportunity) => opportunity.amount)),
    weightedAmount: sum(open.map((opportunity) => opportunity.weightedAmount)),
    worstCaseAmount: byCategory("worst_case"),
    mostLikelyAmount: byCategory("most_likely"),
    upsideAmount: byCategory("upside"),
    closedAmount: sum(opportunities.filter((opportunity) => opportunity.closedWon).map((opportunity) => opportunity.amount)),
  };
}

export type TerritoryRule = {
  field: "country" | "region" | "industry" | "lifecycleStage" | "leadSourceId" | "annualRevenue" | "employeeCount";
  operator: "equals" | "in" | "contains" | "gte" | "lte";
  value: string | string[] | number;
};

export interface TerritorySubject {
  country?: string | null;
  region?: string | null;
  industry?: string | null;
  lifecycleStage: CrmLifecycleStage;
  leadSourceId?: string | null;
  annualRevenue?: string | null;
  employeeCount?: number | null;
}

function matchRule(subject: TerritorySubject, rule: TerritoryRule): boolean {
  const raw = subject[rule.field];
  if (raw === null || raw === undefined) return false;
  if (rule.operator === "in") {
    return Array.isArray(rule.value) && rule.value.map((value) => String(value).toLocaleLowerCase()).includes(String(raw).toLocaleLowerCase());
  }
  if (rule.operator === "contains") return String(raw).toLocaleLowerCase().includes(String(rule.value).toLocaleLowerCase());
  if (rule.operator === "equals") return String(raw).toLocaleLowerCase() === String(rule.value).toLocaleLowerCase();
  if (rule.field === "annualRevenue") {
    const compared = cmp(String(raw), String(rule.value));
    return rule.operator === "gte" ? compared >= 0 : compared <= 0;
  }
  const numeric = Number(raw);
  const target = Number(rule.value);
  if (!Number.isFinite(numeric) || !Number.isFinite(target)) return false;
  return rule.operator === "gte" ? numeric >= target : numeric <= target;
}

export function matchesTerritory(subject: TerritorySubject, rules: TerritoryRule[], mode: "all" | "any"): boolean {
  if (rules.length === 0) return false;
  return mode === "all" ? rules.every((rule) => matchRule(subject, rule)) : rules.some((rule) => matchRule(subject, rule));
}
