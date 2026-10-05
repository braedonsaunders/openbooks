import { toChartNumber } from '../chart-number';
/**
 * True Cost rate-engine calculation primitives (ALLOCATION_BASES,
 * calculateRate, formatRate,
 * calculateCompositeRate, category calculators). Pure
 * functions, no DB — the data layer fetches the base values and feeds them in.
 *
 * The implementation is deterministic: allocation base × method → raw rate, formatted per
 * the category's rate format, blended into a composite by the configured
 * method. Category types beyond expense (time / manual / derived / formula)
 * use the same calculation pipeline.
 */
import { add, cmp, div, fromUnits, mulDecimal, mulPercent, roundDiv, roundMoney, toUnits } from "@openbooks/engine/src/money/money.ts";
import {
  deriveOverheadOverallRate,
  deriveOverheadDeptComposite,
  deriveOverheadDisplayRate,
  OverheadCalculationError,
  quantizeOverheadMoney } from "@openbooks/engine/src/projects/overhead-rates.ts";

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
      return over ? bases.hours.totalBilled : (bases.hours.byDept[deptId]?.billed ?? 0);
    case "total_hours":
      return over ? bases.hours.total : (bases.hours.byDept[deptId]?.total ?? 0);
    case "labor_dollars":
      return over ? bases.laborDollars.total : (bases.laborDollars.byDept[deptId] ?? 0);
    case "headcount":
      return over ? bases.headcount.total : (bases.headcount.byDept[deptId] ?? 0);
    case "revenue":
      return over ? bases.revenue.total : (bases.revenue.byDept[deptId] ?? 0);
    case "direct_cost":
      return over ? bases.directCost.total : (bases.directCost.byDept[deptId] ?? 0);
    case "square_feet":
      return over ? bases.squareFeet.total : (bases.squareFeet.byDept[deptId] ?? 0);
    case "units":
      return over ? bases.units.total : (bases.units.byDept[deptId] ?? 0);
    case "custom":
      return over ? bases.custom.total : (bases.custom.byDept[deptId] ?? 0);
    default:
      return over ? bases.hours.totalBilled : (bases.hours.byDept[deptId]?.billed ?? 0);
  }
}

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
  const exactMap = (
    value: number | Record<string, number>): Record<string, string> =>
    typeof value === "number"
      ? { Overall: quantizeOverheadMoney(value) }
      : Object.fromEntries(
          Object.entries(value).map(([id, amount]) => [
            id,
            quantizeOverheadMoney(amount),
          ]),
        );
  return toChartNumber(
    deriveOverheadOverallRate({
      id: category.id,
      allocationMethod: method ?? category.allocationMethod ?? "simple",
      allocationTiers: category.allocationTiers,
      allocationWeights: category.allocationWeights,
      expenseByDept: exactMap(expenses),
      baseByDept: exactMap(baseValue),
    }));
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
  rawRate: number | string,
  format: RateFormat | undefined,
  periodData: { laborDollars?: { total: number | string } | number | string;
    directCost?: { total: number | string } | number | string;
    units?: { total: number | string }; monthCount?: number; annualFteHours?: string | null },
  category: { totalExpense?: number | string;
    expenseOverall?: number | string;
  },
  money: (value: number | string, options?: RateMoneyOptions) => string,
): FormattedRate {
  const rateFormat = format ?? "per_hour";
  const def = RATE_FORMATS[rateFormat];
  const base = (
    value: { total: number | string } | number | string | undefined,
  ) =>
    value === undefined
      ? undefined
      : quantizeOverheadMoney(typeof value === "object" ? value.total : value);
  const exact = deriveOverheadDisplayRate({
    rawRate: quantizeOverheadMoney(rawRate),
    rateFormat,
    expense: quantizeOverheadMoney(
      category.totalExpense ?? category.expenseOverall ?? 0,
    ),
    laborDollars: base(periodData.laborDollars),
    directCost: base(periodData.directCost),
    units: base(periodData.units),
    annualFteHours: periodData.annualFteHours ?? undefined,
  });
  if (exact === null)
    throw new OverheadCalculationError(
      `Cannot calculate ${rateFormat}: its allocation base is missing or not positive. Check the category's allocation base and period before retrying.`,
    );
  const display =
    rateFormat === "percent_labor" || rateFormat === "percent_cost"
      ? `${roundMoney(exact, def.decimals)}%`
      : `${money(exact, { minimumFractionDigits: def.decimals, maximumFractionDigits: def.decimals })}${def.suffix}`;
  return { value: toChartNumber(exact), display, unit:
      rateFormat === "per_hour"
        ? "hour"
        : rateFormat === "per_fte"
          ? "fte"
          : rateFormat === "per_unit"
            ? "unit"
            : "percent", rawRate: Number(rawRate),
  }
}

/* ─────────────────────────────────────────────── composite blend ── */

export interface CompositeCategory {
  id: string;
  /** Display name for refusal messages; falls back to the id. */
  name?: string;
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
): {
  value: number;
  method: CompositeMethod;
  includedCategories: string[];
  categoryCount: number;
} {
  const method = compositeConfig.method || "sum";
  const includeCategories =
    compositeConfig.includeCategories || categories.map((c) => c.id);
  const excludeCategories = compositeConfig.excludeCategories || [];

  const included = categories.filter((c) => {
    if (c.includeInComposite === false) return false;
    if (excludeCategories.includes(c.id)) return false;
    if (includeCategories.length > 0 && !includeCategories.includes(c.id))
      return false;
    return true;
  });

  const value = Number(
    deriveOverheadDeptComposite({
      compositeMethod: method,
      cascadeOrder:
        compositeConfig.cascadeOrder ??
        (includeCategories.length > 0 ? includeCategories : undefined),
      baseLaborRate: periodData.avgLaborRate ?? compositeConfig.baseLaborRate,
      categories: included.map((category) => ({
        id: category.id,
        name: category.name,
        rate: quantizeOverheadMoney(category.rateValue),
        expense: quantizeOverheadMoney(category.totalExpense),
        rateFormat: category.rateFormat ?? "per_hour",
        includeInComposite: true,
      })),
    }),
  );
  return {
    value,
    method,
    includedCategories: included.map((c) => c.id),
    categoryCount: included.length,
  };
}

/* ─────────────────────────────────── manual / derived / formula ── */

/**
 * Stored configuration must be readable; corrupt amounts cannot become
 * zero. Absent values in a sparse per-department map mean no amount for
 * that department (a normal map, not corruption); every other required
 * amount must parse or the category refuses instead of zeroing.
 */
function exactConfigMoney(value: unknown): string {
  if (value === undefined || value === null) return "0.0000";
  try {
    if (typeof value !== "number" && typeof value !== "string")
      throw new Error("not a decimal");
    return quantizeOverheadMoney(value);
  } catch {
    throw new OverheadCalculationError(
      `The overhead model contains an unreadable amount "${String(value)}". Correct the stored category amount before retrying.`,
      "unreadableAmount",
    );
  }
}

/**
 * A required stored amount: missing is corrupt, not zero. Sparse
 * per-department entries keep the tolerant reader above; totals, rates and
 * percentages fail closed so a half-saved category never prices at zero.
 */
function requiredConfigMoney(value: unknown): string {
  if (value === undefined || value === null)
    throw new OverheadCalculationError(
      "The overhead model contains a category with a missing amount. Correct the stored category amount before retrying.",
      "unreadableAmount",
    );
  return exactConfigMoney(value);
}

/**
 * Exact department share of an allocation base (decimal string, 0 when empty).
 * When the caller passes exact per-department base maps, shares divide those
 * directly; the float bundle is only a fallback for callers without one.
 */
function exactBaseShare(
  base: AllocationBase,
  bases: AllocationBaseBundle,
  deptId: string,
  exactBases?: Partial<Record<AllocationBase, Record<string, string>>>,
): string {
  const exactMap = exactBases?.[base];
  if (exactMap) {
    let total = "0.0000";
    for (const key of Object.keys(exactMap)) total = add(total, exactMap[key] ?? "0.0000");
    if (cmp(total, "0") <= 0) return "0";
    return div(exactMap[deptId] ?? "0.0000", total);
  }
  const totalBase = exactConfigMoney(getAllocationBaseValue(base, bases, "Overall"));
  if (cmp(totalBase, "0") <= 0) return "0";
  return div(exactConfigMoney(getAllocationBaseValue(base, bases, deptId)), totalBase);
}

/** Calculate manual category values in fixed-total, department, or per-unit mode. */
export function calculateManualCategoryData(
  manualConfig: { entryMode?: "fixed_total" | "by_dept" | "per_unit"; fixedTotal?: number | string; byDeptAmounts?: Record<string, number | string>; unitType?: AllocationBase; perUnitRate?: number | string },
  allocationBase: AllocationBase,
  deptIds: string[],
  bases: AllocationBaseBundle,
  exactBases?: Partial<Record<AllocationBase, Record<string, string>>>,
): { expense: Record<string, number>; expenseExact?: Record<string, string>; totalExpense: number } {
  const entryMode = manualConfig.entryMode || "fixed_total";
  const expense: Record<string, number> = {};
  for (const id of deptIds) expense[id] = 0;
  let totalExpense = 0;
  let expenseExact: Record<string, string> | undefined;

  if (entryMode === "fixed_total") {
    const fixedTotalUnits = toUnits(requiredConfigMoney(manualConfig.fixedTotal));
    totalExpense = toChartNumber(fromUnits(fixedTotalUnits));
    const weightUnits = (value: number | string): bigint => {
      if (typeof value === "number" && (!Number.isFinite(value) || value < 0))
        throw new Error("fixed-total allocation requires finite, non-negative department bases.");
      const raw = String(value);
      if (raw.startsWith("-"))
        throw new Error("fixed-total allocation requires finite, non-negative department bases.");
      const [coefficient, exponentText] = raw.toLowerCase().split("e");
      const exponent = Number(exponentText ?? 0);
      const [whole = "0", fraction = ""] = coefficient!.split(".");
      const digits = BigInt(`${whole}${fraction}` || "0");
      const decimalPlaces = fraction.length - exponent;
      if (decimalPlaces > 18) throw new Error("fixed-total allocation base exceeds supported decimal precision.");
      return digits * 10n ** BigInt(18 - decimalPlaces);
    };
    // Department weights come from the exact base maps when the caller passes
    // them, so a float bundle can never skew a fixed-total split.
    const exactWeights = exactBases?.[allocationBase];
    const weights = deptIds.map((id) => ({ id, weight: weightUnits(exactWeights?.[id] ?? getAllocationBaseValue(allocationBase, bases, id)) }));
    const weightTotal = weights.reduce((sum, item) => sum + item.weight, 0n);
    expenseExact = Object.fromEntries(deptIds.map((id) => [id, "0.0000"]));
    if (weightTotal > 0n) {
      const sign = fixedTotalUnits < 0n ? -1n : 1n;
      const magnitude = fixedTotalUnits < 0n ? -fixedTotalUnits : fixedTotalUnits;
      const shares = weights.map(({ id, weight }) => {
        const numerator = magnitude * weight;
        return { id, units: numerator / weightTotal, remainder: numerator % weightTotal };
      });
      let unassigned = magnitude - shares.reduce((sum, share) => sum + share.units, 0n);
      const residualOrder = [...shares].sort((a, b) =>
        a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1,
      );
      for (let index = 0; unassigned > 0n; index += 1, unassigned -= 1n) {
        residualOrder[index % residualOrder.length]!.units += 1n;
      }
      for (const share of shares) {
        const exact = fromUnits(share.units * sign);
        expenseExact[share.id] = exact;
        expense[share.id] = toChartNumber(exact);
      }
    }
  } else if (entryMode === "by_dept") {
    const byDept = manualConfig.byDeptAmounts || {};
    expenseExact = Object.fromEntries(deptIds.map((id) => [id, "0.0000"]));
    let exactTotal = "0.0000";
    for (const id of deptIds) {
      const amt = exactConfigMoney(byDept[id]);
      expenseExact[id] = amt;
      expense[id] = toChartNumber(amt);
      exactTotal = add(exactTotal, amt);
    }
    totalExpense = toChartNumber(exactTotal);
  } else if (entryMode === "per_unit") {
    const unitType = manualConfig.unitType || "headcount";
    const perUnitRate = requiredConfigMoney(manualConfig.perUnitRate);
    const isPercent = unitType === "revenue" || unitType === "direct_cost";
    const rate = isPercent ? div(perUnitRate, "100") : perUnitRate;
    expenseExact = Object.fromEntries(deptIds.map((id) => [id, "0.0000"]));
    let exactTotal = "0.0000";
    for (const id of deptIds) {
      // A per-unit base that cannot be read is corrupt configuration, never
      // a zero expense: the failure names the category at the loader, which
      // attaches it before surfacing the refusal.
      let exp: string;
      try {
        // The exact per-department unit count when the caller passes one; the
        // float bundle is only a fallback for callers without exact maps.
        const units = exactBases?.[unitType]?.[id] ?? quantizeOverheadMoney(getAllocationBaseValue(unitType, bases, id));
        exp = mulDecimal(units, rate);
      } catch {
        throw new OverheadCalculationError(
          "A per-unit category's department base is unreadable. Correct the stored category base before retrying.",
          "unreadableAmount",
        );
      }
      expenseExact[id] = exp;
      expense[id] = toChartNumber(exp);
      exactTotal = add(exactTotal, exp);
    }
    totalExpense = toChartNumber(exactTotal);
  }

  expense["Overall"] = totalExpense;
  return { expense, ...(expenseExact ? { expenseExact } : {}), totalExpense };
}

/** Calculate a category as a percentage of another category. */
export function calculateDerivedCategoryData(
  derivedConfig: { sourceCategory?: string; percentage?: number | string; allocationBase?: AllocationBase | "same" },
  categoryTotals: Record<string, { expenseOverall: number | string }>,
  allocationBase: AllocationBase,
  deptIds: string[],
  bases: AllocationBaseBundle,
  exactBases?: Partial<Record<AllocationBase, Record<string, string>>>,
): { expense: Record<string, number>; expenseExact?: Record<string, string>; totalExpense: number } {
  const expense: Record<string, number> = { Overall: 0 };
  const expenseExact: Record<string, string> = { Overall: "0.0000" };
  for (const id of deptIds) {
    expense[id] = 0;
    expenseExact[id] = "0.0000";
  }

  const sourceId = derivedConfig.sourceCategory;
  // A derivation without a resolvable source is corrupt configuration, never
  // an empty category: the loader names the category before surfacing it.
  if (!sourceId || !categoryTotals[sourceId])
    throw new OverheadCalculationError(
      `A derived category refers to ${JSON.stringify(sourceId ?? null)}, which resolves to no category total. Correct the derivation source before retrying.`,
      "formulaReference",
      { reference: sourceId ?? "missing" },
    );
  if (derivedConfig.percentage === undefined || derivedConfig.percentage === null)
    throw new OverheadCalculationError(
      "A derived category is missing its percentage of the source category. Correct the derivation before retrying.",
      "formulaReference",
      { reference: "percentage" },
    );
  const percentage = exactConfigMoney(derivedConfig.percentage);

  const totalDerived = mulPercent(exactConfigMoney(categoryTotals[sourceId]!.expenseOverall), percentage);
  const base = derivedConfig.allocationBase && derivedConfig.allocationBase !== "same" ? derivedConfig.allocationBase : allocationBase;

  for (const id of deptIds) {
    const exact = mulDecimal(totalDerived, exactBaseShare(base, bases, id, exactBases));
    expenseExact[id] = exact;
    expense[id] = toChartNumber(exact);
  }
  expenseExact["Overall"] = totalDerived;
  const totalExpense = toChartNumber(totalDerived);
  expense["Overall"] = totalExpense;
  return { expense, expenseExact, totalExpense };
}

/**
 * Evaluate a formula with
 * cat.<id> / cat["id"] and base.<name> references against category totals and
 * base values, then allocates by base. Evaluation is a guarded arithmetic
 * parser (no `eval`) — see evaluateExactFormula.
 */
export function calculateFormulaCategoryData(
  formulaConfig: { formula?: string },
  categoryTotals: Record<string, { expenseOverall: number | string }>,
  allocationBase: AllocationBase,
  deptIds: string[],
  bases: AllocationBaseBundle,
  exactBases?: Partial<Record<AllocationBase, Record<string, string>>>,
): { expense: Record<string, number>; expenseExact?: Record<string, string>; totalExpense: number } {
  const expense: Record<string, number> = { Overall: 0 };
  const expenseExact: Record<string, string> = { Overall: "0.0000" };
  for (const id of deptIds) {
    expense[id] = 0;
    expenseExact[id] = "0.0000";
  }

  const formula = formulaConfig.formula || "";
  if (!formula) return { expense, expenseExact, totalExpense: 0 };

  const catVals: Record<string, string> = {};
  for (const id of Object.keys(categoryTotals)) catVals[id] = exactConfigMoney(categoryTotals[id]!.expenseOverall);
  const safeBase = (value: number): string => {
    try {
      return quantizeOverheadMoney(value);
    } catch {
      return "0.0000";
    }
  };
  // Formula base references resolve against the exact per-department maps when
  // the caller passes them, so a float bundle can never skew a formula total.
  const exactOverall = (base: AllocationBase, fallback: number): string => {
    const map = exactBases?.[base];
    if (!map) return safeBase(fallback);
    let total = "0.0000";
    for (const key of Object.keys(map)) total = add(total, map[key] ?? "0.0000");
    return total;
  };
  const baseVals: Record<string, string> = {
    billed_hours: exactOverall("billed_hours", bases.hours.totalBilled),
    total_hours: exactOverall("total_hours", bases.hours.total),
    headcount: exactOverall("headcount", bases.headcount.total),
    revenue: exactOverall("revenue", bases.revenue.total),
    labor_dollars: exactOverall("labor_dollars", bases.laborDollars.total),
    direct_cost: exactOverall("direct_cost", bases.directCost.total),
    square_feet: exactOverall("square_feet", bases.squareFeet.total),
    units: exactOverall("units", bases.units.total),
    custom: exactOverall("custom", bases.custom.total),
  };

  // An unknown reference is corrupt configuration, never a zero: each
  // substitution names the offending reference, and the loader names the
  // category before surfacing the refusal.
  const unknownRefs: string[] = [];
  let evalFormulaText = formula;
  evalFormulaText = evalFormulaText.replace(/cat\["([^"]+)"\]/g, (_m, id) => {
    if (!(id in catVals)) unknownRefs.push(`cat["${id}"]`);
    return catVals[id] ?? "0.0000";
  });
  evalFormulaText = evalFormulaText.replace(/cat\.([a-zA-Z0-9_]+)/g, (_m, id) => {
    if (!(id in catVals)) unknownRefs.push(`cat.${id}`);
    return catVals[id] ?? "0.0000";
  });
  evalFormulaText = evalFormulaText.replace(/base\.([a-zA-Z0-9_]+)/g, (_m, id) => {
    if (!(id in baseVals)) unknownRefs.push(`base.${id}`);
    return baseVals[id] ?? "0.0000";
  });
  if (unknownRefs.length > 0)
    throw new OverheadCalculationError(
      `A formula category refers to ${unknownRefs.map((r) => JSON.stringify(r)).join(", ")}, which resolve to nothing. Correct the formula before retrying.`,
      "formulaReference",
      { reference: unknownRefs[0]! },
    );

  const calc = evaluateExactFormula(evalFormulaText);
  if (calc === null)
    throw new OverheadCalculationError(
      "A formula category cannot be evaluated. Correct the formula before retrying.",
      "formulaReference",
      { reference: formula.length > 60 ? `${formula.slice(0, 60)}…` : formula },
    );

  // A burden category cannot be negative: clamping would hide a sign error
  // behind a zero total.
  if (cmp(calc, "0") < 0)
    throw new OverheadCalculationError(
      `A formula category evaluates to ${calc}, and a burden category cannot be negative. Correct the formula before retrying.`,
      "formulaNegative",
      { amount: calc },
    );
  const totalExpenseExact = calc;
  for (const id of deptIds) {
    const exact = mulDecimal(totalExpenseExact, exactBaseShare(allocationBase, bases, id, exactBases));
    expenseExact[id] = exact;
    expense[id] = toChartNumber(exact);
  }
  expenseExact["Overall"] = totalExpenseExact;
  const totalExpense = toChartNumber(totalExpenseExact);
  expense["Overall"] = totalExpense;
  return { expense, expenseExact, totalExpense };
}

/**
 * Exact arithmetic evaluator for money formulas — supports
 * + − × ÷, parentheses, and decimal numbers only. No identifiers, no calls,
 * so a stored formula can't execute code. Operands evaluate as exact 4dp
 * ledger units (never binary floats) and the result returns as a canonical
 * decimal string; null on parse failure or division by zero.
 */
export function evaluateExactFormula(expr: string): string | null {
  const clean = expr.replace(/\s+/g, "");
  if (!/^[0-9+\-*/().]*$/.test(clean) || clean === "") return null;
  let pos = 0;
  const peek = () => clean[pos];
  const parseNumber = (): bigint | null => {
    let s = "";
    while (pos < clean.length && /[0-9.]/.test(clean[pos]!)) s += clean[pos++];
    if (s === "" || s === ".") return null;
    try {
      return toUnits(s);
    } catch {
      return null;
    }
  };
  const parenOrNum = (): bigint | null => {
    if (peek() === "(") {
      pos++;
      const v = expression();
      if (peek() !== ")") return null;
      pos++;
      return v;
    }
    if (peek() === "-") { pos++; const v = parenOrNum(); return v === null ? null : -v; }
    if (peek() === "+") { pos++; return parenOrNum(); }
    return parseNumber();
  };
  const term = (): bigint | null => {
    let v = parenOrNum();
    if (v === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = clean[pos++];
      const r = parenOrNum();
      if (r === null) return null;
      if (op === "*") v = roundDiv(v * r, 10_000n);
      else {
        if (r === 0n) return null;
        const scaled = r < 0n ? -v * 10_000n : v * 10_000n;
        v = roundDiv(scaled, r < 0n ? -r : r);
      }
    }
    return v;
  };
  function expression(): bigint | null {
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
  return pos === clean.length && result !== null ? fromUnits(result) : null;
}
