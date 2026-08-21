/**
 * Idaho income-tax withholding — Percentage Computation Method (Rev. 07-23-2026).
 *
 * Source (fetched from tax.idaho.gov, not memory):
 *   Table for Percentage Computation Method of Withholding, revised 07-23-2026
 *     (Idaho Child Tax Credit sunset),
 *     https://tax.idaho.gov/wp-content/uploads/pubs/EPB00744/EPB00744_07-23-2026.pdf
 *     — per-period Single / Married thresholds; 5.3% of wages over the
 *       threshold; allowance amount is zero after the credit sunset.
 *   Computing Withholding (Idaho State Tax Commission),
 *     https://tax.idaho.gov/taxes/income-tax/withholding/computing/
 *     — official $1,212 biweekly / unmarried / 4-allowance example ($31);
 *       allowances × $0; round to the nearest whole dollar.
 *   Form ID W-4 (EFO00307 04-28-2025) — statuses A / B / C; Exempt on line 1.
 *
 * This engine is the July 23 2026 edition. Pay dates before 2026-07-23 are
 * refused: the April 2025 table still subtracted child-tax-credit allowances
 * and this pack does not carry that edition. Do not apply these zero-allowance
 * tables to an earlier pay date.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/id.ts";
const DOLLAR = 10_000n;
const ID_SUNSET_EDITION_FROM = "2026-07-23";

export type IdPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly" | "annual" | "daily";

export type IdFilingStatus = "single" | "married" | "married_single_rate";

const ID_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "annual", "daily",
];

export interface IdPeriodThresholds {
  single: string;
  married: string;
}

/**
 * Printed "More than / Less than" floors. Tax is 5.3% of the amount over the
 * threshold; wages at or below the threshold withhold zero.
 */
export const ID_THRESHOLDS_2026_07_23: Readonly<Record<IdPeriod, IdPeriodThresholds>> = {
  annual: { single: "16100", married: "32200" },
  monthly: { single: "1342", married: "2683" },
  semimonthly: { single: "671", married: "1342" },
  biweekly: { single: "619", married: "1238" },
  weekly: { single: "310", married: "619" },
  daily: { single: "62", married: "124" },
};

export interface IdYearRates {
  year: number;
  status: "published" | "draft";
  rate: string;
  /** ICTCAT amount after the Idaho Child Tax Credit sunset. */
  allowance: string;
  effectiveFrom: string;
}

export const ID_RATES_2026_07_23: IdYearRates = {
  year: 2026,
  status: "published",
  rate: pctToRate("5.3"),
  allowance: "0",
  effectiveFrom: ID_SUNSET_EDITION_FROM,
};

export const ID_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Idaho Table for Percentage Computation Method of Withholding (Rev. 07-23-2026)",
  effectiveFrom: ID_SUNSET_EDITION_FROM,
  citation:
    "Idaho State Tax Commission, Table for Percentage Computation Method of "
    + "Withholding, revised 07-23-2026 — child-tax-credit sunset, $0 ICTCAT "
    + "allowance, 5.3% over the printed per-period threshold, $1,212 biweekly "
    + "unmarried 4-allowance example ($31)",
  status: "published",
  region: "ID",
}];

export function idRatesForPayDate(payDate: string): IdYearRates {
  const year = Number(payDate.slice(0, 4));
  if (year !== ID_RATES_2026_07_23.year || ID_RATES_2026_07_23.status !== "published") {
    refuseUntranscribedYear(ID_WITHHOLDING, year);
  }
  if (payDate < ID_SUNSET_EDITION_FROM) {
    throw new Error(
      `Idaho income tax withholding for pay dates before ${ID_SUNSET_EDITION_FROM} is not loaded — `
      + "the April 2025 Table for Percentage Computation Method still subtracted Idaho Child Tax "
      + `Credit allowances. Transcribe that earlier edition into ${RATES_MODULE} if a `
      + "pre-July-23-2026 pay date must be calculated. Never apply the July 23 2026 "
      + "zero-allowance tables to an earlier pay date.",
    );
  }
  return ID_RATES_2026_07_23;
}

export function idRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

export function idUsesMarriedTable(status: IdFilingStatus): boolean {
  return status === "married";
}

export function idPeriodTax(wages: bigint, period: IdPeriod, married: boolean, rates: IdYearRates): bigint {
  const threshold = U(married ? ID_THRESHOLDS_2026_07_23[period].married : ID_THRESHOLDS_2026_07_23[period].single);
  const excess = max0(wages - threshold);
  if (excess === 0n) return 0n;
  return idRoundToDollar(mulRateCents(excess, rates.rate));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = idRatesForPayDate(input.payDate);
  const period = payPeriodFor(input.periodsPerYear);
  if (!period || !ID_PERIODS.includes(period) || (period === "daily" && input.periodsPerYear !== 260)) {
    refuseUnprintedPeriod(ID_WITHHOLDING, input.periodsPerYear);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("ID_EXEMPT", 1n);
    return { state: "ID", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as IdFilingStatus;
  const married = idUsesMarriedTable(status);
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("ID_WAGES", wages);

  // Computing Withholding: "Multiply the employee's number of Idaho
  // withholding allowances by zero."
  const allowance = U(rates.allowance) * BigInt(allowances);
  trace("ID_ALLOWANCES", allowance);
  const taxable = max0(wages - allowance);
  trace("ID_TAXABLE", taxable);

  const threshold = U(
    married ? ID_THRESHOLDS_2026_07_23[period].married : ID_THRESHOLDS_2026_07_23[period].single,
  );
  trace("ID_THRESHOLD", threshold);

  const periodTax = idPeriodTax(taxable, period, married, rates);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("ID_WITHHELD", total);

  return {
    state: "ID",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const ID_WITHHOLDING: UsStateWithholdingEngine = {
  state: "ID",
  label: "Idaho income tax",
  certificateKey: "us_id_idw4",
  ratesModule: RATES_MODULE,
  editions: ID_TAX_YEAR_EDITIONS,
  printedPeriods: ID_PERIODS,
  compute,
};
