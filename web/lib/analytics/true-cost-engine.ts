/**
 * True Cost rate-engine calculation primitives (ALLOCATION_BASES,
 * calculateRate, formatRate,
 * calculateCompositeRate, category calculators, calculateScenario). Pure
 * functions, no DB — the data layer fetches the base values and feeds them in.
 *
 * The implementation is deterministic: allocation base × method → raw rate, formatted per
 * the category's rate format, blended into a composite by the configured
 * method. Category types beyond expense (time / manual / derived / formula)
 * use the same calculation pipeline.
 */

/* ─────────────────────────────────────────────── constants ── */

export type AllocationBase =
  | "billed_hours"
  | "total_hours"
  | "labor_dollars"
  | "headcount"
  | "revenue"
  | "direct_cost"
  | "square_feet"
  | "units"
  | "custom";

export type AllocationMethod = "simple" | "weighted" | "stepped";
export type RateFormat = "per_hour" | "percent_labor" | "percent_cost" | "per_fte" | "per_unit";
export type CompositeMethod = "sum" | "weighted" | "cascading";
export type CategoryType = "expense" | "time" | "manual" | "derived" | "formula";

export const ALLOCATION_BASES: Record<AllocationBase, { label: string; unit: string; format: "number" | "currency" }> = {
  billed_hours: { label: "Billed Hours", unit: "hrs", format: "number" },
  total_hours: { label: "Total Hours", unit: "hrs", format: "number" },
  labor_dollars: { label: "Labor Cost", unit: "currency", format: "currency" },
  headcount: { label: "Headcount", unit: "FTE", format: "number" },
  revenue: { label: "Revenue", unit: "currency", format: "currency" },
  direct_cost: { label: "Direct Cost", unit: "currency", format: "currency" },
  square_feet: { label: "Square Feet", unit: "sqft", format: "number" },
  units: { label: "Units Produced", unit: "units", format: "number" },
  custom: { label: "Custom Metric", unit: "custom", format: "number" },
};

export const ALLOCATION_METHODS: Record<AllocationMethod, { label: string; description: string }> = {
  simple: { label: "Simple Division", description: "Rate = Total Expense / Total Base" },
  weighted: { label: "Weighted", description: "Rate = Σ(Expense × Weight) / Σ(Base × Weight)" },
  stepped: { label: "Stepped/Tiered", description: "Different rates based on volume thresholds" },
};

export const RATE_FORMATS: Record<RateFormat, { label: string; suffix: string; prefix: string; decimals: number }> = {
  per_hour: { label: "Currency/Hour", suffix: "/hr", prefix: "", decimals: 2 },
  percent_labor: { label: "% of Labor", suffix: "%", prefix: "", decimals: 1 },
  percent_cost: { label: "% of Cost", suffix: "%", prefix: "", decimals: 1 },
  per_fte: { label: "Currency/FTE", suffix: "/FTE", prefix: "", decimals: 0 },
  per_unit: { label: "Currency/Unit", suffix: "/unit", prefix: "", decimals: 2 },
};

export const COMPOSITE_METHODS: Record<CompositeMethod, { label: string; description: string }> = {
  sum: { label: "Sum", description: "Add all category rates together" },
  weighted: { label: "Weighted", description: "Weight by expense volume" },
  cascading: { label: "Cascading/Wrap", description: "Each layer applies to running subtotal" },
};

/* ─────────────────────────────────────────────── base-value bundle ── */

/** Per-department + total value for one allocation base. */
export interface BaseValues {
  total: number;
  byDept: Record<string, number>;
}

/** Values for every supported allocation base. */
export interface AllocationBaseBundle {
  hours: { total: number; totalBilled: number; byDept: Record<string, { total: number; billed: number }> };
  laborDollars: BaseValues;
  headcount: BaseValues;
  revenue: BaseValues;
  directCost: BaseValues;
  squareFeet: BaseValues;
  units: BaseValues;
  custom: BaseValues;
  monthCount: number;
}

/** Resolve one allocation-base value for an organization or department. */
export function getAllocationBaseValue(baseType: AllocationBase, bases: AllocationBaseBundle, deptId: string): number {
  const over = deptId === "Overall";
  switch (baseType) {
    case "billed_hours":
      return over ? bases.hours.totalBilled : bases.hours.byDept[deptId]?.billed ?? 0;
    case "total_hours":
      return over ? bases.hours.total : bases.hours.byDept[deptId]?.total ?? 0;
    case "labor_dollars":
      return over ? bases.laborDollars.total : bases.laborDollars.byDept[deptId] ?? 0;
    case "headcount":
      return over ? bases.headcount.total : bases.headcount.byDept[deptId] ?? 0;
    case "revenue":
      return over ? bases.revenue.total : bases.revenue.byDept[deptId] ?? 0;
    case "direct_cost":
      return over ? bases.directCost.total : bases.directCost.byDept[deptId] ?? 0;
    case "square_feet":
      return over ? bases.squareFeet.total : bases.squareFeet.byDept[deptId] ?? 0;
    case "units":
      return over ? bases.units.total : bases.units.byDept[deptId] ?? 0;
    case "custom":
      return over ? bases.custom.total : bases.custom.byDept[deptId] ?? 0;
    default:
      return over ? bases.hours.totalBilled : bases.hours.byDept[deptId]?.billed ?? 0;
  }
}

const safeDiv = (a: number, b: number) => (b === 0 || !isFinite(b) ? 0 : a / b);

/* ─────────────────────────────────────────────── rate calculation ── */

export interface CategoryRateConfig {
  id: string;
  allocationBase?: AllocationBase;
  allocationMethod?: AllocationMethod;
  rateFormat?: RateFormat;
  includeInComposite?: boolean;
  allocationWeights?: Record<string, number>;
  allocationTiers?: { min?: number; max?: number; rate?: number | string }[];
}

/**
 * Calculate a category rate. `expenses`/`baseValue` are either scalars
 * (Overall) or per-dept maps (for weighted).
 */
export function calculateRate(
  category: CategoryRateConfig,
  expenses: number | Record<string, number>,
  baseValue: number | Record<string, number>,
  method?: AllocationMethod,
): number {
  if (typeof baseValue === "number" && baseValue === 0) return 0;
  if (typeof baseValue === "object" && !Object.values(baseValue).some((v) => v > 0)) return 0;

  const allocationMethod = method || category.allocationMethod || "simple";

  const sumVals = (o: number | Record<string, number>) =>
    typeof o === "object" ? Object.values(o).reduce((s, v) => s + (v || 0), 0) : o;

  switch (allocationMethod) {
    case "simple":
      return safeDiv(sumVals(expenses), sumVals(baseValue));

    case "weighted": {
      const weights = category.allocationWeights || {};
      let we = 0;
      let wb = 0;
      if (typeof expenses === "object" && typeof baseValue === "object") {
        for (const deptId of Object.keys(expenses)) {
          const w = Number(weights[deptId]) || 1.0;
          we += (expenses[deptId] || 0) * w;
          wb += (baseValue[deptId] || 0) * w;
        }
        return safeDiv(we, wb);
      }
      return safeDiv(sumVals(expenses), sumVals(baseValue));
    }

    case "stepped": {
      const tiers = category.allocationTiers || [];
      const baseVal = sumVals(baseValue);
      if (tiers.length > 0) {
        const sorted = [...tiers].sort((a, b) => (a.min || 0) - (b.min || 0));
        for (let i = sorted.length - 1; i >= 0; i--) {
          const t = sorted[i]!;
          const tMin = Number(t.min) || 0;
          const tMax = Number(t.max) || 999999;
          if (baseVal >= tMin && baseVal <= tMax && Number(t.rate) > 0) return Number(t.rate);
        }
      }
      return safeDiv(sumVals(expenses), baseVal);
    }

    default:
      return safeDiv(sumVals(expenses), sumVals(baseValue));
  }
}

/* ─────────────────────────────────────────────── rate formatting ── */

export interface FormattedRate {
  value: number;
  display: string;
  unit: string;
  rawRate: number;
}

type RateMoneyOptions = {
  notation?: 'standard' | 'compact';
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

/** Format a raw rate using one of the five supported output formats. */
export function formatRate(
  rawRate: number,
  format: RateFormat | undefined,
  periodData: { laborDollars?: { total: number } | number; directCost?: { total: number } | number; units?: { total: number }; monthCount?: number },
  category: { totalExpense?: number; expenseOverall?: number },
  money: (value: number, options?: RateMoneyOptions) => string,
): FormattedRate {
  const rateFormat = format || "per_hour";
  const def = RATE_FORMATS[rateFormat] || RATE_FORMATS.per_hour;
  const totalExpense = category.totalExpense ?? category.expenseOverall ?? 0;

  switch (rateFormat) {
    case "per_hour":
      return { value: rawRate, display: `${money(rawRate, { minimumFractionDigits: def.decimals, maximumFractionDigits: def.decimals })}/hr`, unit: "hour", rawRate };

    case "percent_labor": {
      const laborBase = (typeof periodData.laborDollars === "object" ? periodData.laborDollars.total : periodData.laborDollars) || 1;
      const pct = laborBase > 0 ? (totalExpense / laborBase) * 100 : 0;
      return { value: pct, display: `${pct.toFixed(def.decimals)}%`, unit: "percent", rawRate };
    }

    case "percent_cost": {
      const costBase = (typeof periodData.directCost === "object" ? periodData.directCost.total : periodData.directCost) || 1;
      const pct = costBase > 0 ? (totalExpense / costBase) * 100 : 0;
      return { value: pct, display: `${pct.toFixed(def.decimals)}%`, unit: "percent", rawRate };
    }

    case "per_fte": {
      const monthCount = periodData.monthCount || 1;
      const annualizationFactor = 12 / monthCount;
      const fteRate = rawRate * (2080 / 12) * monthCount * annualizationFactor;
      return { value: fteRate, display: `${money(fteRate, { notation: 'compact', maximumFractionDigits: 1 })}/FTE`, unit: "fte", rawRate };
    }

    case "per_unit": {
      const unitCount = periodData.units?.total || 1;
      const unitRate = safeDiv(totalExpense, unitCount);
      return { value: unitRate, display: `${money(unitRate, { minimumFractionDigits: def.decimals, maximumFractionDigits: def.decimals })}/unit`, unit: "unit", rawRate };
    }

    default:
      return { value: rawRate, display: `${money(rawRate, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/hr`, unit: "hour", rawRate };
  }
}

/* ─────────────────────────────────────────────── composite blend ── */

export interface CompositeCategory {
  id: string;
  rateValue: number; // the formatted rate value
  totalExpense: number;
  rateFormat?: RateFormat;
  includeInComposite?: boolean;
}

export interface CompositeConfig {
  method?: CompositeMethod;
  includeCategories?: string[];
  excludeCategories?: string[];
  cascadeOrder?: string[];
  baseLaborRate?: number | string;
}

/** Calculate a composite rate using sum, weighted, or cascading behavior. */
export function calculateCompositeRate(
  categories: CompositeCategory[],
  compositeConfig: CompositeConfig,
  periodData: { avgLaborRate?: number } = {},
): { value: number; method: CompositeMethod; includedCategories: string[]; categoryCount: number } {
  const method = compositeConfig.method || "sum";
  const includeCategories = compositeConfig.includeCategories || categories.map((c) => c.id);
  const excludeCategories = compositeConfig.excludeCategories || [];

  const included = categories.filter((c) => {
    if (c.includeInComposite === false) return false;
    if (excludeCategories.includes(c.id)) return false;
    if (includeCategories.length > 0 && !includeCategories.includes(c.id)) return false;
    return true;
  });

  let value = 0;
  switch (method) {
    case "sum":
      value = included.reduce((s, c) => s + (c.rateValue || 0), 0);
      break;

    case "weighted": {
      const total = included.reduce((s, c) => s + (c.totalExpense || 0), 0);
      if (total > 0) {
        value = included.reduce((s, c) => s + (c.rateValue || 0) * ((c.totalExpense || 0) / total), 0);
      }
      break;
    }

    case "cascading": {
      const baseLabor = Number(periodData.avgLaborRate || compositeConfig.baseLaborRate || 50);
      let running = baseLabor;
      const order = compositeConfig.cascadeOrder || includeCategories;
      for (const catId of order) {
        const c = included.find((x) => x.id === catId);
        if (!c) continue;
        const rate = c.rateValue || 0;
        if (c.rateFormat === "percent_labor" || c.rateFormat === "percent_cost") running = running * (1 + rate / 100);
        else running += rate;
      }
      value = running - baseLabor;
      break;
    }

    default:
      value = included.reduce((s, c) => s + (c.rateValue || 0), 0);
  }

  return { value, method, includedCategories: included.map((c) => c.id), categoryCount: included.length };
}

/* ─────────────────────────────────── manual / derived / formula ── */

/** Calculate manual category values in fixed-total, department, or per-unit mode. */
export function calculateManualCategoryData(
  manualConfig: { entryMode?: "fixed_total" | "by_dept" | "per_unit"; fixedTotal?: number | string; byDeptAmounts?: Record<string, number | string>; unitType?: AllocationBase; perUnitRate?: number | string },
  allocationBase: AllocationBase,
  deptIds: string[],
  bases: AllocationBaseBundle,
): { expense: Record<string, number>; totalExpense: number } {
  const entryMode = manualConfig.entryMode || "fixed_total";
  const expense: Record<string, number> = {};
  for (const id of deptIds) expense[id] = 0;
  let totalExpense = 0;

  if (entryMode === "fixed_total") {
    totalExpense = Number(manualConfig.fixedTotal) || 0;
    const totalBase = getAllocationBaseValue(allocationBase, bases, "Overall");
    for (const id of deptIds) {
      const deptBase = getAllocationBaseValue(allocationBase, bases, id);
      const pct = totalBase > 0 ? deptBase / totalBase : 0;
      expense[id] = totalExpense * pct;
    }
  } else if (entryMode === "by_dept") {
    const byDept = manualConfig.byDeptAmounts || {};
    for (const id of deptIds) {
      const amt = Number(byDept[id]) || 0;
      expense[id] = amt;
      totalExpense += amt;
    }
  } else if (entryMode === "per_unit") {
    const unitType = manualConfig.unitType || "headcount";
    const perUnitRate = Number(manualConfig.perUnitRate) || 0;
    const isPercent = unitType === "revenue" || unitType === "direct_cost";
    for (const id of deptIds) {
      const unitBase = getAllocationBaseValue(unitType, bases, id);
      const exp = isPercent ? unitBase * (perUnitRate / 100) : unitBase * perUnitRate;
      expense[id] = exp;
      totalExpense += exp;
    }
  }

  expense["Overall"] = totalExpense;
  return { expense, totalExpense };
}

/** Calculate a category as a percentage of another category. */
export function calculateDerivedCategoryData(
  derivedConfig: { sourceCategory?: string; percentage?: number | string; allocationBase?: AllocationBase | "same" },
  categoryTotals: Record<string, { expenseOverall: number }>,
  allocationBase: AllocationBase,
  deptIds: string[],
  bases: AllocationBaseBundle,
): { expense: Record<string, number>; totalExpense: number } {
  const expense: Record<string, number> = { Overall: 0 };
  for (const id of deptIds) expense[id] = 0;

  const sourceId = derivedConfig.sourceCategory;
  const percentage = Number(derivedConfig.percentage ?? 100);
  if (!sourceId || !categoryTotals[sourceId]) return { expense, totalExpense: 0 };

  const totalDerived = (categoryTotals[sourceId]!.expenseOverall || 0) * (percentage / 100);
  const base = derivedConfig.allocationBase && derivedConfig.allocationBase !== "same" ? derivedConfig.allocationBase : allocationBase;
  const totalBase = getAllocationBaseValue(base, bases, "Overall");

  for (const id of deptIds) {
    const deptBase = getAllocationBaseValue(base, bases, id);
    const share = totalBase > 0 ? deptBase / totalBase : 0;
    expense[id] = totalDerived * share;
  }
  expense["Overall"] = totalDerived;
  return { expense, totalExpense: totalDerived };
}

/**
 * Evaluate a formula with
 * cat.<id> / cat["id"] and base.<name> references against category totals and
 * base values, then allocates by base. Evaluation is a guarded arithmetic
 * parser (no `eval`) — see evaluateFormula.
 */
export function calculateFormulaCategoryData(
  formulaConfig: { formula?: string },
  categoryTotals: Record<string, { expenseOverall: number }>,
  allocationBase: AllocationBase,
  deptIds: string[],
  bases: AllocationBaseBundle,
): { expense: Record<string, number>; totalExpense: number; error?: string } {
  const expense: Record<string, number> = { Overall: 0 };
  for (const id of deptIds) expense[id] = 0;

  const formula = formulaConfig.formula || "";
  if (!formula) return { expense, totalExpense: 0 };

  const catVals: Record<string, number> = {};
  for (const id of Object.keys(categoryTotals)) catVals[id] = categoryTotals[id]!.expenseOverall || 0;
  const baseVals: Record<string, number> = {
    billed_hours: bases.hours.totalBilled,
    total_hours: bases.hours.total,
    headcount: bases.headcount.total,
    revenue: bases.revenue.total,
    labor_dollars: bases.laborDollars.total,
    direct_cost: bases.directCost.total,
  };

  let evalFormula = formula;
  evalFormula = evalFormula.replace(/cat\["([^"]+)"\]/g, (_m, id) => String(catVals[id] ?? 0));
  evalFormula = evalFormula.replace(/cat\.([a-zA-Z0-9_]+)/g, (_m, id) => String(catVals[id] ?? 0));
  evalFormula = evalFormula.replace(/base\.([a-zA-Z0-9_]+)/g, (_m, id) => String(baseVals[id] ?? 0));

  const calc = evaluateFormula(evalFormula);
  if (calc === null || isNaN(calc) || !isFinite(calc)) return { expense, totalExpense: 0, error: "Invalid formula result" };

  const totalExpense = Math.max(0, calc);
  const totalBase = getAllocationBaseValue(allocationBase, bases, "Overall");
  for (const id of deptIds) {
    const deptBase = getAllocationBaseValue(allocationBase, bases, id);
    const share = totalBase > 0 ? deptBase / totalBase : 0;
    expense[id] = totalExpense * share;
  }
  expense["Overall"] = totalExpense;
  return { expense, totalExpense };
}

/**
 * Safe arithmetic evaluator for formulas — supports
 * + − × ÷, parentheses, and decimal numbers only. No identifiers, no calls,
 * so a stored formula can't execute code. Returns null on parse failure.
 */
export function evaluateFormula(expr: string): number | null {
  const clean = expr.replace(/\s+/g, "");
  if (!/^[0-9+\-*/().]*$/.test(clean) || clean === "") return null;
  let pos = 0;
  const peek = () => clean[pos];
  const parseNumber = (): number | null => {
    let s = "";
    while (pos < clean.length && /[0-9.]/.test(clean[pos]!)) s += clean[pos++];
    if (s === "" || s === ".") return null;
    const n = Number(s);
    return isNaN(n) ? null : n;
  };
  let factor: () => number | null;
  const parenOrNum = (): number | null => {
    if (peek() === "(") {
      pos++;
      const v = expression();
      if (peek() !== ")") return null;
      pos++;
      return v;
    }
    if (peek() === "-") { pos++; const v = factor(); return v === null ? null : -v; }
    if (peek() === "+") { pos++; return factor(); }
    return parseNumber();
  };
  factor = parenOrNum;
  const term = (): number | null => {
    let v = factor();
    if (v === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = clean[pos++];
      const r = factor();
      if (r === null) return null;
      v = op === "*" ? v * r : r === 0 ? NaN : v / r;
    }
    return v;
  };
  function expression(): number | null {
    let v = term();
    if (v === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = clean[pos++];
      const r = term();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const result = expression();
  return pos === clean.length ? result : null;
}

/* ─────────────────────────────────────────────── scenario modeler ── */

export type ScenarioType = "hire" | "terminate" | "win_contract" | "lose_contract" | "cost_change" | "utilization_change";

export interface ScenarioInput {
  scenarioType: ScenarioType;
  employeeCount?: number;
  avgSalary?: number;
  expectedUtilization?: number; // 0..1
  annualHours?: number;
  changeType?: "increase" | "decrease";
  amount?: number;
  newUtilization?: number; // 0..1
}

export interface ScenarioCurrent {
  currentRate: number;
  currentExpense: number;
  currentHours: number; // billed hours (monthly)
  currentUtilization: number; // 0..1
  fringeRate: number; // default 0.25
}

export interface ScenarioImpact {
  currentRate: number;
  projectedRate: number;
  change: number;
  changePercent: number;
  insight: string;
  breakdown: Record<string, number>;
  breakeven: { hoursNeeded: number; atCurrentHours: number };
  fringeRate: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Calculate six scenario types, including annualized hours and fringe. */
export function calculateScenario(
  input: ScenarioInput,
  cur: ScenarioCurrent,
  formatCurrency: (value: number) => string = (value) => `${round2(value)} currency units`,
): ScenarioImpact {
  const { currentRate, currentExpense, currentHours, currentUtilization, fringeRate } = cur;
  let projectedRate = 0;
  let insight = "";
  let breakdown: Record<string, number> = {};

  switch (input.scenarioType) {
    case "hire": {
      const count = input.employeeCount || 1;
      const util = input.expectedUtilization ?? 0.75;
      const salary = input.avgSalary || 75000;
      const newHours = (count * util * 2080) / 12;
      const projectedHours = currentHours + newHours;
      const fringeCost = (count * salary * fringeRate) / 12;
      const projectedExpense = currentExpense + fringeCost;
      projectedRate = safeDiv(projectedExpense, projectedHours);
      insight = `Adding ${count} employee(s) at ${(util * 100).toFixed(0)}% utilization adds ${round2(newHours)} monthly billable hours.`;
      breakdown = { hoursChange: newHours, expenseChange: fringeCost, projectedHours, projectedExpense };
      break;
    }
    case "terminate": {
      const count = input.employeeCount || 1;
      const util = input.expectedUtilization ?? 0.75;
      const salary = input.avgSalary || 75000;
      const lostHours = (count * util * 2080) / 12;
      const projectedHours = Math.max(currentHours - lostHours, 1);
      const savings = (count * salary * fringeRate) / 12;
      const projectedExpense = currentExpense - savings;
      projectedRate = safeDiv(projectedExpense, projectedHours);
      insight = `Reducing ${count} employee(s) saves ${formatCurrency(savings)} in overhead but loses ${round2(lostHours)} billable hours.`;
      breakdown = { hoursChange: -lostHours, expenseChange: -savings, projectedHours, projectedExpense };
      break;
    }
    case "win_contract": {
      const contractHours = (input.annualHours || 0) / 12;
      const projectedHours = currentHours + contractHours;
      projectedRate = safeDiv(currentExpense, projectedHours);
      insight = `Winning contract adds ${round2(contractHours)} monthly hours, spreading overhead across more volume.`;
      breakdown = { hoursChange: contractHours, projectedHours };
      break;
    }
    case "lose_contract": {
      const lostHours = (input.annualHours || 0) / 12;
      const projectedHours = Math.max(currentHours - lostHours, 1);
      projectedRate = safeDiv(currentExpense, projectedHours);
      insight = `Losing contract removes ${round2(lostHours)} monthly hours, concentrating overhead on fewer hours.`;
      breakdown = { hoursChange: -lostHours, projectedHours };
      break;
    }
    case "cost_change": {
      const delta = input.changeType === "decrease" ? -(input.amount || 0) : input.amount || 0;
      const projectedExpense = currentExpense + delta;
      projectedRate = safeDiv(projectedExpense, currentHours);
      insight = `${input.changeType === "decrease" ? "Reducing" : "Adding"} ${formatCurrency(Math.abs(delta))} in overhead costs.`;
      breakdown = { expenseChange: delta, projectedExpense };
      break;
    }
    case "utilization_change": {
      const newUtil = input.newUtilization ?? 0.8;
      const totalHrs = currentUtilization > 0 ? currentHours / currentUtilization : currentHours;
      const newBilled = totalHrs * newUtil;
      projectedRate = safeDiv(currentExpense, newBilled);
      insight = `Changing utilization from ${(currentUtilization * 100).toFixed(0)}% to ${(newUtil * 100).toFixed(0)}% ${newUtil > currentUtilization ? "increases" : "decreases"} billable hours.`;
      breakdown = { currentUtilization: currentUtilization * 100, newUtilization: newUtil * 100, hoursChange: newBilled - currentHours, totalHrs, newBilledHrs: newBilled };
      break;
    }
  }

  const change = projectedRate - currentRate;
  return {
    currentRate,
    projectedRate,
    change,
    changePercent: safeDiv(change, currentRate) * 100,
    insight,
    breakdown,
    breakeven: { hoursNeeded: currentExpense > 0 ? safeDiv(currentExpense, currentRate) : 0, atCurrentHours: currentHours },
    fringeRate,
  };
}
