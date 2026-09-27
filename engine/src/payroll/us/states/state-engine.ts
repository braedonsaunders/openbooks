import { PayrollError } from "../../error.ts";
import { certificateFlag, type ResolvedCertificate } from "../../certificates.ts";
import { D } from "../../../money/payroll-decimal.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

export const US_STATE_PAY_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "quarterly", "semiannual", "annual", "daily",
];

export interface StateRateEdition<Rates extends { year: number; status: "published" | "draft" }> {
  year: number;
  rates: Rates;
  edition: PayrollTaxYearEdition;
}

export function pairStateRateEditions<Rates extends { year: number; status: "published" | "draft" }>(
  rates: readonly Rates[],
  editions: readonly PayrollTaxYearEdition[],
): StateRateEdition<Rates>[] {
  return rates.map((yearRates) => {
    const matching = editions.filter((edition) => edition.year === yearRates.year);
    if (matching.length !== 1) {
      throw new PayrollError(
        `expected one tax-year citation for ${yearRates.year}; found ${matching.length}`,
      );
    }
    return { year: yearRates.year, rates: yearRates, edition: matching[0]! };
  });
}

export interface StateExemptOptions {
  certificate?: ResolvedCertificate;
  flagKey?: string;
  flagKeys?: readonly string[];
  factorKey?: string;
  factorFormat?: "flag" | "decimal";
  extraFactors?: Readonly<Record<string, string>>;
}

export interface StateEngineContext<Rates> {
  readonly rates: Rates;
  readonly factors: Record<string, string>;
  trace(key: string, value: bigint): void;
  requirePeriodsPerYear(periodsPerYear?: number): number;
  requirePrintedPeriod(
    periodsPerYear?: number,
    printedPeriods?: readonly UsStatePayPeriod[],
    dailyPeriods?: number | readonly number[],
    aliases?: Readonly<Record<number, UsStatePayPeriod>>,
  ): UsStatePayPeriod;
  printedPeriod(
    periodsPerYear?: number,
    printedPeriods?: readonly UsStatePayPeriod[],
    dailyPeriods?: number | readonly number[],
    aliases?: Readonly<Record<number, UsStatePayPeriod>>,
  ): UsStatePayPeriod | null;
  isExempt(options?: StateExemptOptions): boolean;
  exemptResult(options?: StateExemptOptions & {
    statutoryTax?: boolean;
    additionalWithholding?: boolean;
  }): UsStateWithholdingResult | null;
}

/** Build the shared lifecycle around a jurisdiction's published formula. */
export function defineStateEngine<Rates extends { year: number; status: "published" | "draft" }>(input: {
  state: { state: string; label: string; printedPeriods: readonly UsStatePayPeriod[] | null };
  editions: readonly StateRateEdition<Rates>[];
  compute(
    input: UsStateWithholdingInput,
    rates: Rates,
    context: StateEngineContext<Rates>,
  ): UsStateWithholdingResult;
}): {
  ratesForPayDate(payDate: string): Rates;
  requirePeriodsPerYear(periodsPerYear: number): number;
  requirePrintedPeriod(
    periodsPerYear: number,
    printedPeriods: readonly UsStatePayPeriod[],
    dailyPeriods?: number | readonly number[],
    aliases?: Readonly<Record<number, UsStatePayPeriod>>,
  ): UsStatePayPeriod;
  printedPeriod(
    periodsPerYear: number,
    printedPeriods: readonly UsStatePayPeriod[],
    dailyPeriods?: number | readonly number[],
    aliases?: Readonly<Record<number, UsStatePayPeriod>>,
  ): UsStatePayPeriod | null;
  compute(input: UsStateWithholdingInput): UsStateWithholdingResult;
} {
  const byYear = new Map<number, StateRateEdition<Rates>>();
  for (const edition of input.editions) {
    if (edition.year !== edition.rates.year || edition.edition.year !== edition.year) {
      throw new PayrollError(`${input.state.label} has an inconsistent year edition declaration`);
    }
    if (byYear.has(edition.year)) {
      throw new PayrollError(`${input.state.label} has more than one rate edition for ${edition.year}`);
    }
    byYear.set(edition.year, edition);
  }

  const ratesForPayDate = (payDate: string): Rates => {
    const year = Number(payDate.slice(0, 4));
    const edition = byYear.get(year);
    if (!edition || edition.rates.status !== "published" || edition.edition.status !== "published") {
      refuseUntranscribedYear({
        state: input.state.state,
        label: input.state.label,
        editions: input.editions.map((entry) => entry.edition),
      }, year);
    }
    return edition.rates;
  };

  const requirePeriodsPerYear = (periodsPerYear: number): number => {
    if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 2000) {
      throw new PayrollError(`invalid pay periods per year for ${input.state.label}: ${periodsPerYear}`);
    }
    return periodsPerYear;
  };
  const requirePrintedPeriod = (
    periodsPerYear: number,
    printedPeriods: readonly UsStatePayPeriod[],
    dailyPeriods: number | readonly number[] = 260,
    aliases: Readonly<Record<number, UsStatePayPeriod>> = {},
  ): UsStatePayPeriod => {
    const period = printedPeriod(periodsPerYear, printedPeriods, dailyPeriods, aliases);
    if (!period) refuseUnprintedPeriod({ label: input.state.label, printedPeriods }, periodsPerYear);
    return period;
  };
  const printedPeriod = (
    periodsPerYear: number,
    printedPeriods: readonly UsStatePayPeriod[],
    dailyPeriods: number | readonly number[] = 260,
    aliases: Readonly<Record<number, UsStatePayPeriod>> = {},
  ): UsStatePayPeriod | null => {
    const period = aliases[periodsPerYear] ?? payPeriodFor(periodsPerYear);
    const validDailyPeriods = typeof dailyPeriods === "number" ? [dailyPeriods] : dailyPeriods;
    if (
      !period || !printedPeriods.includes(period)
      || (period === "daily" && !validDailyPeriods.includes(periodsPerYear))
    ) return null;
    return period;
  };

  return {
    ratesForPayDate,
    requirePeriodsPerYear,
    requirePrintedPeriod,
    printedPeriod,
    compute(payrollInput) {
      const rates = ratesForPayDate(payrollInput.payDate);
      const factors: Record<string, string> = {};
      const trace = (key: string, value: bigint) => { factors[key] = D(value); };
      const requirePeriodsPerYearForInput = (periodsPerYear = payrollInput.periodsPerYear): number =>
        requirePeriodsPerYear(periodsPerYear);
      const requirePrintedPeriodForInput = (
        periodsPerYear = payrollInput.periodsPerYear,
        printedPeriods = input.state.printedPeriods ?? [],
        dailyPeriods: number | readonly number[] = 260,
        aliases: Readonly<Record<number, UsStatePayPeriod>> = {},
      ): UsStatePayPeriod => requirePrintedPeriod(periodsPerYear, printedPeriods, dailyPeriods, aliases);
      const printedPeriodForInput = (
        periodsPerYear = payrollInput.periodsPerYear,
        printedPeriods = input.state.printedPeriods ?? [],
        dailyPeriods: number | readonly number[] = 260,
        aliases: Readonly<Record<number, UsStatePayPeriod>> = {},
      ): UsStatePayPeriod | null => printedPeriod(periodsPerYear, printedPeriods, dailyPeriods, aliases);
      const isExempt: StateEngineContext<Rates>["isExempt"] = (options = {}) => {
        const certificate = options.certificate ?? payrollInput.certificate;
        const flagKeys = options.flagKeys ?? [options.flagKey ?? "exempt"];
        if (!flagKeys.some((flagKey) => certificateFlag(certificate, flagKey))) return false;
        const factorKey = options.factorKey ?? `${input.state.state}_EXEMPT`;
        factors[factorKey] = options.factorFormat === "decimal" ? D(1n) : "1";
        if (options.extraFactors) Object.assign(factors, options.extraFactors);
        return true;
      };
      const exemptResult: StateEngineContext<Rates>["exemptResult"] = (options = {}) => {
        if (!isExempt(options)) return null;
        const zero = D(0n);
        return {
          state: input.state.state,
          year: rates.year,
          tax: zero,
          ...(options.statutoryTax ? { statutoryTax: zero } : {}),
          ...(options.additionalWithholding ? { additionalWithholding: zero } : {}),
          taxSupplemental: zero,
          factors,
        };
      };
      return input.compute(payrollInput, rates, {
        rates,
        factors,
        trace,
        requirePeriodsPerYear: requirePeriodsPerYearForInput,
        requirePrintedPeriod: requirePrintedPeriodForInput,
        printedPeriod: printedPeriodForInput,
        isExempt,
        exemptResult,
      });
    },
  };
}
