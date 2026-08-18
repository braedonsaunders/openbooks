/**
 * Georgia withholding — the PERCENTAGE METHOD from the Employer's Withholding
 * Tax Guide.
 *
 * Sources (fetched from dor.georgia.gov, not memory):
 *   Employer's Withholding Tax Guide 2026, REVISED: June 2026 — the 4.99% rate,
 *     Table E and Table F, and both worked examples (pp. 48–49).
 *   Employer's Withholding Tax Guide 2026, REVISED: December 2025 — the 5.19%
 *     rate and the pre-HB 463 standard deductions, with its own worked example
 *     (pp. 46–47). Still the governing edition for the first four months of the
 *     year, which is why it is transcribed rather than superseded.
 *   Form G-4 (Rev. 08/15/24) — the certificate's own lines.
 *
 * ---------------------------------------------------------------------------
 * A retroactive rate cut that is NOT retroactive to withholding
 * ---------------------------------------------------------------------------
 * House Bill 463 cut the rate from 5.19% to 4.99% "retroactive to taxable years
 * beginning on or after January 1, 2026", raised the standard deduction to
 * $30,000/$15,000 and the dependent allowance to $5,000. WITHHOLDING did not
 * move retroactively with it. The Department's own words:
 *
 *   "Employers must continue to withhold at the rate of 5.19% before the
 *    effective date of the change and can begin withholding at the new rate of
 *    4.99%, starting May 11, 2026."
 *
 * So 2026 has two Georgia editions, selected by PAY DATE, and an employer
 * running a March payroll at 4.99% is withholding at a rate that is right for
 * the return and wrong for the payroll. Both are transcribed.
 *
 * "CAN begin" is an election, and this engine takes it: from 11 May 2026 it
 * computes at 4.99% with the new deductions, which is what the June guide's own
 * tables and examples print. An employer who chooses to keep withholding at
 * 5.19% for the rest of the year is doing something Georgia permits and this
 * engine does not offer — recorded here rather than left to be discovered.
 *
 * ---------------------------------------------------------------------------
 * Tables E and F are the same table
 * ---------------------------------------------------------------------------
 * The guide prints "TABLE E — EXAMPLE #1" and "TABLE F — EXAMPLE #2" with
 * identical figures in every column of every payroll period, in both the
 * December and the June editions. They are one schedule printed twice, once
 * beside each worked example. One is stored; a conformance test pins the
 * agreement so an edition in which they diverge is caught rather than absorbed
 * — the same treatment New York City's identical Single and Married schedules
 * get.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateChoice, certificateCount, certificateFlag }
  from "../../certificates.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/ga.ts";

/** Georgia prints all eight payroll periods. */
type GaPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

const GA_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

/**
 * The three standard-deduction columns of Table E, and the dependent-allowance
 * column beside them.
 *
 * Column (2) and column (3) carry the same figure in every printed period —
 * "Single or Head of Household" and "Married Filing Separate" both take the
 * single deduction — and they are stored separately anyway, because the day
 * Georgia splits them the change belongs in this table and not in an `if`.
 */
interface GaTableRow {
  /** (1) Married Filing Joint. */
  marriedJoint: string;
  /** (2) Single or Head of Household. */
  singleOrHoh: string;
  /** (3) Married Filing Separate. */
  marriedSeparate: string;
  /** (4) Dependent Allowance, each. */
  allowance: string;
}

export interface GaEdition {
  /** Selected by PAY DATE. */
  effectiveFrom: string;
  /** Exclusive; null while current. */
  effectiveTo: string | null;
  label: string;
  citation: string;
  rate: string;
  tableE: Readonly<Record<GaPeriod, GaTableRow>>;
  /** Table F, which the guide prints identically. Stored for the pin test. */
  tableF: Readonly<Record<GaPeriod, GaTableRow>>;
}

const GA_TABLE_DEC_2025: Readonly<Record<GaPeriod, GaTableRow>> = {
  weekly: { marriedJoint: "461.54", singleOrHoh: "230.77", marriedSeparate: "230.77", allowance: "76.92" },
  biweekly: { marriedJoint: "923.08", singleOrHoh: "461.54", marriedSeparate: "461.54", allowance: "153.85" },
  semimonthly: { marriedJoint: "1000.00", singleOrHoh: "500.00", marriedSeparate: "500.00", allowance: "166.67" },
  monthly: { marriedJoint: "2000.00", singleOrHoh: "1000.00", marriedSeparate: "1000.00", allowance: "333.33" },
  quarterly: { marriedJoint: "6000.00", singleOrHoh: "3000.00", marriedSeparate: "3000.00", allowance: "1000.00" },
  semiannual: { marriedJoint: "12000.00", singleOrHoh: "6000.00", marriedSeparate: "6000.00", allowance: "2000.00" },
  annual: { marriedJoint: "24000.00", singleOrHoh: "12000.00", marriedSeparate: "12000.00", allowance: "4000.00" },
  daily: { marriedJoint: "65.75", singleOrHoh: "32.88", marriedSeparate: "32.88", allowance: "10.96" },
};

const GA_TABLE_JUN_2026: Readonly<Record<GaPeriod, GaTableRow>> = {
  weekly: { marriedJoint: "576.92", singleOrHoh: "288.46", marriedSeparate: "288.46", allowance: "96.15" },
  biweekly: { marriedJoint: "1153.85", singleOrHoh: "576.92", marriedSeparate: "576.92", allowance: "192.31" },
  semimonthly: { marriedJoint: "1250.00", singleOrHoh: "625.00", marriedSeparate: "625.00", allowance: "208.33" },
  monthly: { marriedJoint: "2500.00", singleOrHoh: "1250.00", marriedSeparate: "1250.00", allowance: "416.67" },
  quarterly: { marriedJoint: "7500.00", singleOrHoh: "3750.00", marriedSeparate: "3750.00", allowance: "1250.00" },
  semiannual: { marriedJoint: "15000.00", singleOrHoh: "7500.00", marriedSeparate: "7500.00", allowance: "2500.00" },
  annual: { marriedJoint: "30000.00", singleOrHoh: "15000.00", marriedSeparate: "15000.00", allowance: "5000.00" },
  daily: { marriedJoint: "82.19", singleOrHoh: "41.10", marriedSeparate: "41.10", allowance: "13.70" },
};

export const GA_EDITIONS: readonly GaEdition[] = [
  {
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-05-11",
    label: "Georgia Employer's Withholding Tax Guide 2026, revised December 2025 (5.19%)",
    citation:
      "Georgia Department of Revenue, Employer's Withholding Tax Guide 2026 (REVISED: December "
      + "2025), Percentage Method for Employee Withholding, Tables E and F (pp. 46–47)",
    rate: "0.0519",
    tableE: GA_TABLE_DEC_2025,
    tableF: GA_TABLE_DEC_2025,
  },
  {
    effectiveFrom: "2026-05-11",
    effectiveTo: null,
    label: "Georgia Employer's Withholding Tax Guide 2026, revised June 2026 (4.99%, HB 463)",
    citation:
      "Georgia Department of Revenue, Employer's Withholding Tax Guide 2026 (REVISED: June 2026), "
      + "Percentage Method for Employee Withholding, Tables E and F (pp. 48–49); House Bill 463",
    rate: "0.0499",
    tableE: GA_TABLE_JUN_2026,
    tableF: GA_TABLE_JUN_2026,
  },
];

const GA_LOADED_YEARS = new Set([2026]);

export const GA_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Georgia Employer's Withholding Tax Guide 2026 (December 2025 and June 2026 revisions)",
  effectiveFrom: "2026-01-01",
  citation: GA_EDITIONS.map((edition) => edition.citation).join("; "),
  status: "published",
  region: "GA",
}];

export function gaEditionForPayDate(payDate: string): GaEdition {
  const year = Number(payDate.slice(0, 4));
  if (!GA_LOADED_YEARS.has(year)) refuseUntranscribedYear(GA_WITHHOLDING, year);
  const edition = GA_EDITIONS.find((candidate) =>
    payDate >= candidate.effectiveFrom
    && (candidate.effectiveTo == null || payDate < candidate.effectiveTo));
  if (!edition) {
    throw new Error(
      `no Georgia withholding edition is loaded for a pay date of ${payDate} — ${RATES_MODULE}`,
    );
  }
  return edition;
}

function gaPeriodFor(periodsPerYear: number): GaPeriod {
  const period = payPeriodFor(periodsPerYear);
  if (period == null) refuseUnprintedPeriod(GA_WITHHOLDING, periodsPerYear);
  return period as GaPeriod;
}

/**
 * Which standard-deduction column Form G-4's marital-status letter selects.
 *
 * G-4 line 3, and the NOTE printed under Table E: "Married couples, both having
 * income, should use the standard deduction allowed in column (3)". So B — the
 * two-earner married status — is column (3), not column (1), and reading it as
 * "married therefore joint" would give a two-earner couple twice the deduction
 * they are entitled to.
 *
 * "Failure to submit a properly completed Form G-4 results in the employer
 * withholding as though the employee is single with zero allowances", which is
 * the certificate's declared default rather than an assumption made here.
 */
export function gaStandardDeduction(row: GaTableRow, status: string | null): string {
  switch (status) {
    case "C": return row.marriedJoint;
    case "B": return row.marriedSeparate;
    case "D": return row.singleOrHoh;
    default: return row.singleOrHoh;
  }
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const edition = gaEditionForPayDate(input.payDate);
  const period = gaPeriodFor(input.periodsPerYear);
  const factors: Record<string, string> = {
    GA_EDITION: edition.effectiveFrom,
    GA_RATE: edition.rate,
  };

  // G-4 line 8 — exempt because there was no Georgia liability last year and
  // none is expected this year, or under the Servicemembers Civil Relief Act.
  if (certificateFlag(input.certificate, "exempt")) {
    factors.GA_EXEMPT = "1";
    return {
      state: "GA", year: Number(input.payDate.slice(0, 4)),
      tax: D(0n), taxSupplemental: D(0n), factors,
    };
  }

  const row = edition.tableE[period];
  const status = certificateChoice(input.certificate, "marital_status");
  const standardDeduction = gaStandardDeduction(row, status);
  factors.GA_STANDARD_DEDUCTION = standardDeduction;

  // G-4 line 7: "TOTAL ALLOWANCES (Total of Lines 4 - 5)" — the dependent
  // allowances of line 4 PLUS the Georgia adjustments allowances of line 5. The
  // percentage-method instruction names only "the appropriate dependent
  // amount", but the certificate totals the two lines into the one number the
  // employer uses with the tables, and the printed wage-bracket tables carry a
  // single allowance count. Recorded as an inference from the form, not a
  // citation from the instruction.
  const allowances = (certificateCount(input.certificate, "dependent_allowances") ?? 0)
    + (certificateCount(input.certificate, "adjustment_allowances") ?? 0);
  const allowanceValue = U(row.allowance) * BigInt(allowances);
  factors.GA_ALLOWANCES = String(allowances);
  factors.GA_ALLOWANCE_VALUE = D(allowanceValue);

  // The guide's steps 1–3. Step 4: "If zero exemption is claimed, subtract the
  // standard deduction only" — which is what a zero allowance count already
  // does, so there is no second branch.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const taxable = max0(wages - U(standardDeduction) - allowanceValue);
  factors.GA_TAXABLE = D(taxable);

  const tax = mulRateCents(taxable, edition.rate);
  factors.GA_TAX = D(tax);

  // G-4 line 6 — "ADDITIONAL WITHHOLDING", a flat amount after the rate.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  return {
    state: "GA",
    year: Number(input.payDate.slice(0, 4)),
    tax: D(tax + extra),
    taxSupplemental: D(0n),
    factors,
  };
}

export const GA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "GA",
  label: "Georgia income tax",
  certificateKey: "us_ga_g4",
  ratesModule: RATES_MODULE,
  editions: GA_TAX_YEAR_EDITIONS,
  printedPeriods: GA_PERIODS,
  compute,
};
