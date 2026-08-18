/**
 * North Carolina withholding — NC-30, the PERCENTAGE METHOD.
 *
 * Sources (fetched from ncdor.gov, not memory):
 *   NC-30, 2026 Income Tax Withholding Tables and Instructions for Employers —
 *     the percentage method formula tables (pp. 17–18) and their worked
 *     example, the annualized method (p. 19) and its worked example, the
 *     supplemental wage rule (§ 12), and the resident/nonresident rules (§ 5).
 *   Form NC-4, Employee's Withholding Allowance Certificate (Web 11-24).
 *
 * ---------------------------------------------------------------------------
 * The withholding rate is NOT the income tax rate, on purpose
 * ---------------------------------------------------------------------------
 * NC-30 prints it at the head of every formula table: "The withholding
 * calculations are based on the individual income tax rate of 3.99% plus 0.1%.
 * This results in a withholding tax rate of 4.09%." The extra tenth of a point
 * is deliberate over-withholding, so that an employee with no other adjustments
 * lands slightly in refund rather than slightly in debt. A payroll system that
 * "corrects" 4.09% to the statutory 3.99% under-withholds every North Carolina
 * employee by a quarter of a percent of gross, and every number in this module
 * would still look plausible.
 *
 * ---------------------------------------------------------------------------
 * Rounding to the DOLLAR, not the cent
 * ---------------------------------------------------------------------------
 * Also printed on every table: "Round off the final amount to the nearest whole
 * dollar." North Carolina is the only state in either tranche that does this,
 * and it is the last step, not an intermediate one — the annualized method's
 * own example carries $231.09 (a cent-rounded annual tax) through to $4.00 a
 * week. Rounding earlier or later reproduces neither example.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateChoice, certificateCount, certificateFlag }
  from "../../certificates.ts";
import { roundDiv } from "../../../money.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/nc.ts";

/** The four payroll periods NC-30 prints percentage-method tables for. */
type NcPeriod = "weekly" | "biweekly" | "semimonthly" | "monthly";

const NC_PERIODS: readonly UsStatePayPeriod[] = ["weekly", "biweekly", "semimonthly", "monthly"];

/** NC-30 prints two schedules, and only two. */
export type NcSchedule = "single_married_surviving" | "head_household";

interface NcPeriodValues {
  /** The period's portion of the N.C. standard deduction, per schedule. */
  standardDeduction: Readonly<Record<NcSchedule, string>>;
  /** The period's value of one NC-4 withholding allowance. */
  allowance: string;
}

export interface NcYearRates {
  year: number;
  status: "published" | "draft";
  /** The individual income tax rate, printed for the record — NOT withheld at. */
  incomeTaxRate: string;
  /** The rate actually withheld at: the income tax rate plus 0.1%. */
  withholdingRate: string;
  /** The annualized method's figures. */
  annual: {
    standardDeduction: Readonly<Record<NcSchedule, string>>;
    allowance: string;
  };
  periods: Readonly<Record<NcPeriod, NcPeriodValues>>;
}

export const NC_RATES_2026: NcYearRates = {
  year: 2026,
  status: "published",
  incomeTaxRate: "0.0399",
  withholdingRate: "0.0409",
  annual: {
    standardDeduction: { single_married_surviving: "12750.00", head_household: "19125.00" },
    allowance: "2500.00",
  },
  periods: {
    weekly: {
      standardDeduction: { single_married_surviving: "245.19", head_household: "367.79" },
      allowance: "48.08",
    },
    biweekly: {
      standardDeduction: { single_married_surviving: "490.38", head_household: "735.58" },
      allowance: "96.15",
    },
    semimonthly: {
      standardDeduction: { single_married_surviving: "531.25", head_household: "796.88" },
      allowance: "104.17",
    },
    monthly: {
      standardDeduction: { single_married_surviving: "1062.50", head_household: "1593.75" },
      allowance: "208.33",
    },
  },
};

const NC_EDITIONS_BY_YEAR: Record<number, NcYearRates> = {
  [NC_RATES_2026.year]: NC_RATES_2026,
};

export const NC_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "NC-30 (2026)",
  effectiveFrom: "2026-01-01",
  citation:
    "North Carolina Department of Revenue, NC-30, 2026 Income Tax Withholding Tables and "
    + "Instructions for Employers — percentage method formula tables (pp. 17–18) and annualized "
    + "method (p. 19), withholding rate 4.09% (income tax rate 3.99% plus 0.1%)",
  status: "published",
  region: "NC",
}];

export function ncRatesForPayDate(payDate: string): NcYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = NC_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(NC_WITHHOLDING, year);
  }
  return rates;
}

function ncPeriodFor(periodsPerYear: number): NcPeriod {
  const period = payPeriodFor(periodsPerYear);
  if (period == null || !NC_PERIODS.includes(period)) {
    refuseUnprintedPeriod(NC_WITHHOLDING, periodsPerYear);
  }
  return period as NcPeriod;
}

/**
 * Form NC-4's three filing statuses onto NC-30's two schedules.
 *
 * NC-4 offers "Single or Married Filing Separately", "Head of Household" and
 * "Married Filing Jointly or Surviving Spouse"; NC-30 prints one table headed
 * "Single Person, Married Person, or Surviving Spouse" and one headed "Head of
 * Household". The mapping is the tables' own heading, not an inference.
 *
 * "If you do not submit Form NC-4 to your employer, your employer must withhold
 * as if your filing status is 'Single' with no allowances" — the certificate's
 * declared default.
 */
export function ncScheduleFor(filingStatus: string | null): NcSchedule {
  return filingStatus === "head_household" ? "head_household" : "single_married_surviving";
}

const DOLLAR = 10_000n; // one dollar in money.ts's 1e4 units

/** "Round off the final amount to the nearest whole dollar." */
export function ncRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

/**
 * The percentage method — NC-30 pp. 17–18.
 *
 * Line by line: wages, less (the period's standard deduction portion plus the
 * allowances × the period's allowance value), times 4.09%, rounded to the
 * dollar.
 */
export function ncPercentageMethod(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
  schedule: NcSchedule;
  allowances: number;
}): { tax: bigint; factors: Record<string, string> } {
  const rates = ncRatesForPayDate(input.payDate);
  const period = ncPeriodFor(input.periodsPerYear);
  const values = rates.periods[period];
  const factors: Record<string, string> = { NC_METHOD: "percentage", NC_SCHEDULE: input.schedule };

  const deduction = U(values.standardDeduction[input.schedule]);
  const allowances = U(values.allowance) * BigInt(Math.max(input.allowances, 0));
  factors.NC_STANDARD_DEDUCTION = D(deduction);
  factors.NC_ALLOWANCES = D(allowances);

  const net = max0(U(input.wages) - deduction - allowances);
  factors.NC_NET_WAGES = D(net);

  const tax = ncRoundToDollar(mulRateCents(net, rates.withholdingRate));
  factors.NC_TAX = D(tax);
  return { tax, factors };
}

/**
 * The annualized method — NC-30 p. 19.
 *
 * Published alongside the percentage method and NOT wired into `compute`, for
 * the reason California's annualized method is not: both are the state's, they
 * are an employer's election, and an engine that chose between them on its own
 * would be unreproducible. It answers for any pay frequency, which the
 * percentage method's four printed periods do not, so it is exported for a
 * caller who needs one.
 *
 * The conformance test runs NC-30's own example through both and gets $4.00
 * twice.
 */
export function ncAnnualizedMethod(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
  schedule: NcSchedule;
  allowances: number;
}): { tax: string; annualTax: string } {
  const rates = ncRatesForPayDate(input.payDate);
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear < 1) {
    throw new Error(`invalid pay periods per year for North Carolina: ${input.periodsPerYear}`);
  }
  const annualWages = U(input.wages) * BigInt(input.periodsPerYear);
  const deduction = U(rates.annual.standardDeduction[input.schedule])
    + U(rates.annual.allowance) * BigInt(Math.max(input.allowances, 0));
  const net = max0(annualWages - deduction);
  // Line 8 of the worked example prints $231.09 for 5,650 × .0409 = 231.085 —
  // the annual tax is rounded to the CENT before line 10 rounds the per-period
  // figure to the dollar.
  const annualTax = mulRateCents(net, rates.withholdingRate);
  const perPeriod = ncRoundToDollar(annualTax / BigInt(input.periodsPerYear));
  return { tax: D(perPeriod), annualTax: D(annualTax) };
}

/**
 * NC-30 § 12 method (a) — the flat supplemental rate.
 *
 * Exported rather than applied: § 12 gives the employer a choice between
 * withholding a flat 4.09% on the supplemental payment and adding it to the
 * regular wages for the period, and it makes method (b) mandatory when no tax
 * was withheld from the regular wages. `compute` therefore aggregates, which is
 * method (b) and is always permitted.
 */
export function ncSupplementalFlat(payDate: string, supplemental: string): string {
  const rates = ncRatesForPayDate(payDate);
  return D(ncRoundToDollar(mulRateCents(U(supplemental), rates.withholdingRate)));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = ncRatesForPayDate(input.payDate);

  // NC-4 EZ line 3 / NC-4 NRA: the employee certifies no liability, or claims
  // the Servicemembers Civil Relief Act military-spouse exemption.
  if (certificateFlag(input.certificate, "exempt")) {
    return {
      state: "NC", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      factors: { NC_EXEMPT: "1" },
    };
  }

  const schedule = ncScheduleFor(certificateChoice(input.certificate, "filing_status"));
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  // § 12 method (b): "Add the supplemental and regular wages for the most
  // recent payroll period this year. Then figure the income tax as if the total
  // were a single payment."
  const wages = U(input.wages) + U(input.supplemental ?? "0");

  const { tax, factors } = ncPercentageMethod({
    payDate: input.payDate,
    periodsPerYear: input.periodsPerYear,
    wages: D(wages),
    schedule,
    allowances,
  });

  // NC-4 line 2 — "Additional amount, if any, you want withheld from each pay
  // period (Enter whole dollars)".
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  return {
    state: "NC",
    year: rates.year,
    tax: D(tax + extra),
    taxSupplemental: D(0n),
    factors,
  };
}

export const NC_WITHHOLDING: UsStateWithholdingEngine = {
  state: "NC",
  label: "North Carolina income tax",
  certificateKey: "us_nc_nc4",
  ratesModule: RATES_MODULE,
  editions: NC_TAX_YEAR_EDITIONS,
  // NC-30's percentage method prints weekly, biweekly, semimonthly and monthly
  // and nothing else. A quarterly payroll is refused rather than scaled; the
  // exported annualized method is the state's own answer for one.
  printedPeriods: NC_PERIODS,
  compute,
};
