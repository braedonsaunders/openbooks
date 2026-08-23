/**
 * North Dakota income-tax withholding — 2026 Section 2 percentage method
 * (Forms W-4 for 2020 and after).
 *
 * Source (fetched from tax.nd.gov, not memory):
 *   North Dakota Income Tax Withholding Rates and Instructions, wages paid
 *     in 2026,
 *     https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2026-iit/2026-income-tax-withholding-rates-booklet.pdf
 *     — Section 2 Percentage Method Worksheet; Annual Percentage Method
 *       Tables (Single / Married Filing Jointly / Head of Household);
 *       Payroll Period Table; no W-4 → treat as single; round the period
 *       amount to the nearest dollar.
 *
 * Automated payroll uses Section 2. Pre-2020 Form W-4 methods (Section 1)
 * are a different publication path and are refused rather than guessed.
 *
 * The booklet's Section 2 worked example prints line 4 as $734.00 on
 * $93,600 Single. The Single table's own figures on that same $93,600 are
 * $35,975 × 1.95% = $701.51. This engine follows the table, not the
 * worksheet typo. The wage-bracket cell for $1,800–$1,825 weekly Single
 * is the booklet's printed $14 — a different method.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money.ts";
import {
  certificateAmount, certificateChoice, certificateFlag, type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/nd.ts";
const DOLLAR = 10_000n;

const ND_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "daily",
];

export type NdFilingStatus = "single" | "married_joint" | "head_household";

interface NdBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

export interface NdYearRates {
  year: number;
  status: "published" | "draft";
  single: readonly NdBracket[];
  marriedJoint: readonly NdBracket[];
  headHousehold: readonly NdBracket[];
}

const R0 = pctToRate("0");
const R195 = pctToRate("1.95");
const R250 = pctToRate("2.50");

export const ND_RATES_2026: NdYearRates = {
  year: 2026,
  status: "published",
  single: [
    { over: "0", notOver: "57625", base: "0", rate: R0 },
    { over: "57625", notOver: "258450", base: "0", rate: R195 },
    { over: "258450", notOver: null, base: "3916.09", rate: R250 },
  ],
  marriedJoint: [
    { over: "0", notOver: "57500", base: "0", rate: R0 },
    { over: "57500", notOver: "168525", base: "0", rate: R195 },
    { over: "168525", notOver: null, base: "2164.99", rate: R250 },
  ],
  headHousehold: [
    { over: "0", notOver: "78475", base: "0", rate: R0 },
    { over: "78475", notOver: "289675", base: "0", rate: R195 },
    { over: "289675", notOver: null, base: "4118.40", rate: R250 },
  ],
};

const ND_EDITIONS_BY_YEAR: Record<number, NdYearRates> = {
  [ND_RATES_2026.year]: ND_RATES_2026,
};

export const ND_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "North Dakota Income Tax Withholding Rates and Instructions (2026) — Section 2",
  effectiveFrom: "2026-01-01",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026 — Section 2 percentage "
    + "method, Annual Percentage Method Tables, $1,800 weekly Single worksheet",
  status: "published",
  region: "ND",
}];

export function ndRatesForPayDate(payDate: string): NdYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = ND_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(ND_WITHHOLDING, year);
  }
  return rates;
}

export function ndRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

function bracketsFor(status: NdFilingStatus, rates: NdYearRates): readonly NdBracket[] {
  if (status === "married_joint") return rates.marriedJoint;
  if (status === "head_household") return rates.headHousehold;
  return rates.single;
}

export function ndAnnualTax(taxable: bigint, status: NdFilingStatus, rates: NdYearRates): bigint {
  if (taxable <= 0n) return 0n;
  const brackets = bracketsFor(status, rates);
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  if (chosen.rate === R0) return 0n;
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = ndRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  const period = payPeriodFor(P);
  if (!period || !ND_PERIODS.includes(period) || (period === "daily" && P !== 260)) {
    refuseUnprintedPeriod(ND_WITHHOLDING, P);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("ND_EXEMPT", 1n);
    return { state: "ND", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // Newly hired with no W-4: "treat as a single person".
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as NdFilingStatus;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("ND_ANNUAL_WAGES", annualWages);

  const annualTax = ndAnnualTax(annualWages, status, rates);
  trace("ND_ANNUAL_TAX", annualTax);
  const periodTax = ndRoundToDollar(divIntCents(annualTax, P));
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("ND_WITHHELD", total);

  return {
    state: "ND",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const ND_WITHHOLDING: UsStateWithholdingEngine = {
  state: "ND",
  label: "North Dakota income tax",
  certificateKey: "us_nd_w4",
  ratesModule: RATES_MODULE,
  editions: ND_TAX_YEAR_EDITIONS,
  printedPeriods: ND_PERIODS,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * North Dakota withholding declarations — federal Form W-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/**
 * North Dakota publishes no state withholding certificate. The 2026 booklet
 * withholds from the federal Form W-4. Section 2 (2020 and after) is the
 * automated-payroll method this pack computes.
 */
export const ND_CERTIFICATE: PayrollCertificate = {
  key: "us_nd_w4",
  form: "W-4",
  label: "Federal Form W-4 (North Dakota withholding)",
  scope: { level: "region", region: "ND" },
  purpose: "withholding",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026 — Section 2; federal Form W-4",
  summary:
    "North Dakota has no state W-4. Section 2 withholds from the federal W-4 "
    + "Step 1(c) filing status. A newly hired employee who has not submitted "
    + "a W-4 is treated as single.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Federal W-4 Step 1(c) — Filing status",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single or married filing separately" },
        { value: "married_joint", label: "Married filing jointly" },
        { value: "head_household", label: "Head of household" },
      ],
      help:
        "The filing status checked on Form W-4 Step 1(c). Section 2 prints "
        + "a separate Annual Percentage Method Table for each. Default Single "
        + "is the booklet's own rule when no W-4 is on file.",
    },
    {
      key: "additional_per_period",
      label: "Additional North Dakota withholding each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "The booklet asks the employer to accommodate an employee's request "
        + "for additional North Dakota withholding. Added AFTER the period "
        + "amount is rounded to the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Exempt from North Dakota withholding",
      kind: "flag",
      help:
        "A current exempt claim withholds zero. North Dakota publishes no "
        + "separate exemption form; dating any lapse is certificate "
        + "administration.",
    },
  ],
};

export const ND_REGION: PayrollRegionWithholding = {
  region: "ND",
  label: "North Dakota income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_nd_w4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026; federal Form W-4",
};
