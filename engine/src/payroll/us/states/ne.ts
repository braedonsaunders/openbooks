/**
 * Nebraska income-tax withholding — Circular EN percentage method.
 *
 * Source (fetched from revenue.nebraska.gov, not memory):
 *   Circular EN, Nebraska Income Tax Withholding for wages paid on or after
 *     January 1, 2026,
 *     https://revenue.nebraska.gov/sites/default/files/doc/business/Cir_En_2025/2026cir_en_whole.pdf
 *     — $2,440 annual allowance; Table 7 annual percentage-method brackets;
 *       no W-4 / W-4N → single, zero allowances.
 *   2026 Weekly Wage Bracket Table, Single Persons,
 *     https://revenue.nebraska.gov/sites/revenue.nebraska.gov/files/doc/business/Cir_En_2025/2026_weekly.pdf
 *     — official $500–$510 / 0-allowance cell ($14.38). Circular EN constructs
 *       non-shaded cells from the mid-point of the wage bracket; that mid-point
 *       is $505, and Table 7 on $505 × 52 reproduces the printed $14.38.
 *
 * The 1.5% special income-tax withholding procedure is gated on employer
 * headcount (more than 24 employees) and on employee documentation for a
 * lesser amount. This engine does not receive either fact, so it computes the
 * percentage method and does not invent the floor.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
  type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/ne.ts";

export type NeFilingStatus = "single" | "married";

const NE_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

interface NeBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

export interface NeYearRates {
  year: number;
  status: "published" | "draft";
  allowance: string;
  single: readonly NeBracket[];
  married: readonly NeBracket[];
}

const R226 = pctToRate("2.26");
const R322 = pctToRate("3.22");
const R421 = pctToRate("4.21");
const R435 = pctToRate("4.35");
const R448 = pctToRate("4.48");
const R460 = pctToRate("4.60");

export const NE_RATES_2026: NeYearRates = {
  year: 2026,
  status: "published",
  allowance: "2440",
  single: [
    { over: "0", notOver: "3430", base: "0", rate: pctToRate("0") },
    { over: "3430", notOver: "6710", base: "0.00", rate: R226 },
    { over: "6710", notOver: "21810", base: "74.13", rate: R322 },
    { over: "21810", notOver: "31610", base: "560.35", rate: R421 },
    { over: "31610", notOver: "40130", base: "972.93", rate: R435 },
    { over: "40130", notOver: "75370", base: "1343.55", rate: R448 },
    { over: "75370", notOver: null, base: "2922.30", rate: R460 },
  ],
  married: [
    { over: "0", notOver: "8190", base: "0", rate: pctToRate("0") },
    { over: "8190", notOver: "13010", base: "0.00", rate: R226 },
    { over: "13010", notOver: "32400", base: "108.93", rate: R322 },
    { over: "32400", notOver: "50400", base: "733.29", rate: R421 },
    { over: "50400", notOver: "62530", base: "1491.09", rate: R435 },
    { over: "62530", notOver: "82920", base: "2018.75", rate: R448 },
    { over: "82920", notOver: null, base: "2932.22", rate: R460 },
  ],
};

const NE_EDITIONS_BY_YEAR: Record<number, NeYearRates> = {
  [NE_RATES_2026.year]: NE_RATES_2026,
};

export const NE_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Nebraska Circular EN (2026) — percentage method",
  effectiveFrom: "2026-01-01",
  citation:
    "Nebraska Department of Revenue, Circular EN for wages paid on or after "
    + "January 1, 2026 — Table 7 annual percentage method, $2,440 allowance, "
    + "Weekly Wage Bracket Single 0-allowance $500–$510 cell ($14.38)",
  status: "published",
  region: "NE",
}];

export function neRatesForPayDate(payDate: string): NeYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = NE_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(NE_WITHHOLDING, year);
  }
  return rates;
}

export function neAnnualTax(taxable: bigint, married: boolean, rates: NeYearRates): bigint {
  if (taxable <= 0n) return 0n;
  const brackets = married ? rates.married : rates.single;
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = neRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  const period = payPeriodFor(P);
  if (!period || !NE_PERIODS.includes(period) || (period === "daily" && P !== 260)) {
    refuseUnprintedPeriod(NE_WITHHOLDING, P);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("NE_EXEMPT", 1n);
    return { state: "NE", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // No W-4 / W-4N: "withhold as if the employee was single and claimed no
  // withholding allowances regardless" of marital status.
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as NeFilingStatus;
  const married = status === "married";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("NE_ANNUAL_WAGES", annualWages);

  const personal = U(rates.allowance) * BigInt(allowances);
  trace("NE_ALLOWANCES", personal);
  const taxable = max0(annualWages - personal);
  trace("NE_TAXABLE", taxable);

  const annualTax = neAnnualTax(taxable, married, rates);
  trace("NE_ANNUAL_TAX", annualTax);
  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("NE_WITHHELD", total);

  return {
    state: "NE",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const NE_WITHHOLDING: UsStateWithholdingEngine = {
  state: "NE",
  label: "Nebraska income tax",
  certificateKey: "us_ne_w4n",
  ratesModule: RATES_MODULE,
  editions: NE_TAX_YEAR_EDITIONS,
  printedPeriods: NE_PERIODS,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Nebraska withholding declarations — Form W-4N and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form W-4N, Nebraska Withholding Allowance Certificate. */
export const NE_CERTIFICATE: PayrollCertificate = {
  key: "us_ne_w4n",
  form: "W-4N",
  label: "Nebraska Withholding Allowance Certificate",
  scope: { level: "region", region: "NE" },
  purpose: "withholding",
  citation:
    "Nebraska Department of Revenue, Circular EN for wages paid on or after "
    + "January 1, 2026; Form W-4N. A federal Form W-4 on file may be used for "
    + "the same marital status and allowance count.",
  summary:
    "Sets Nebraska marital status and withholding allowances. If the employee "
    + "does not furnish a W-4N or federal W-4, Circular EN requires withholding "
    + "as single with no allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Marital status for Nebraska withholding",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single (including head of household)" },
        { value: "married", label: "Married (including surviving spouse)" },
      ],
      help:
        "Circular EN Table 7 uses Single (including head of household) or "
        + "Married (including surviving spouse). Default Single is the "
        + "publication's own rule when no W-4 / W-4N is on file.",
    },
    {
      key: "allowances",
      label: "Number of Nebraska income tax withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is $2,440 a year. Default zero is Circular EN's "
        + "missing-form rule (single, no allowance).",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "An employee may request additional Nebraska withholding on Form W-4N. "
        + "Added AFTER the percentage method is de-annualized.",
    },
    {
      key: "exempt",
      label: "Exempt from Nebraska withholding",
      kind: "flag",
      help:
        "A current exempt claim withholds zero. Circular EN warns that the "
        + "1.5% special procedure (employers with more than 24 employees) may "
        + "overrule an exempt claim; that procedure is not applied here "
        + "because this engine does not receive employer headcount.",
    },
  ],
};

export const NE_REGION: PayrollRegionWithholding = {
  region: "NE",
  label: "Nebraska income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ne_w4n",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Nebraska Department of Revenue, Circular EN for wages paid on or after "
    + "January 1, 2026; Form W-4N",
};
