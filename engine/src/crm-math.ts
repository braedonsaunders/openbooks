import { cmp, fromUnits, sum, toUnits } from "./money.ts";

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

export interface OpportunityLineMathInput {
  quantity: string;
  unitPrice: string;
  probability?: number | null;
}

export function computeOpportunityTotals(lines: OpportunityLineMathInput[], probability: number) {
  const calculated = lines.map((line) => {
    const amount = multiplyDecimal(line.quantity, line.unitPrice);
    if (cmp(amount, "0") < 0) throw new Error("opportunity line amount cannot be negative");
    const lineProbability = line.probability ?? probability;
    return { ...line, amount, probability: lineProbability, expectedAmount: weightAmount(amount, lineProbability) };
  });
  const projectedAmount = sum(calculated.map((line) => line.amount));
  return {
    lines: calculated,
    projectedAmount,
    weightedAmount: weightAmount(projectedAmount, probability),
  };
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
