/**
 * Maine income-tax withholding — 2026 percentage method.
 *
 * Source (fetched from maine.gov, not memory):
 *   Withholding Tables for Individual Income Tax, Revised December 2025
 *     (2026 booklet),
 *     https://www.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/26_wh_tab_instr.pdf
 *     — Percentage Method Steps 1–6; $5,300 per allowance; withholding
 *       standard deduction $12,450 / $27,750 with the printed phase-out;
 *       2026 rate schedules; official Examples 1–3 ($0 / $33 / $257);
 *       invalid or missing W-4ME → single, zero allowances; daily × 260.
 *
 * The booklet's own note: the $12,450 / $27,750 withholding deductions
 * differ from the $15,300 / $30,600 return amounts. This engine uses the
 * withholding booklet figures, not the return figures.
 *
 * Flat 5% separately-paid supplemental / backup withholding is exported,
 * not used by `compute` (this engine aggregates).
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
  type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/me.ts";
const DOLLAR = 10_000n;

export type MeFilingStatus = "single" | "married";

export interface MeYearRates {
  year: number;
  status: "published" | "draft";
  allowance: string;
  singleStandardDeduction: string;
  marriedStandardDeduction: string;
  singlePhaseStart: string;
  singlePhaseEnd: string;
  marriedPhaseStart: string;
  marriedPhaseEnd: string;
  singlePhaseSpan: string;
  marriedPhaseSpan: string;
  supplementalRate: string;
}

export const ME_RATES_2026: MeYearRates = {
  year: 2026,
  status: "published",
  allowance: "5300",
  singleStandardDeduction: "12450",
  marriedStandardDeduction: "27750",
  singlePhaseStart: "102250",
  singlePhaseEnd: "177250",
  marriedPhaseStart: "204550",
  marriedPhaseEnd: "354550",
  singlePhaseSpan: "75000",
  marriedPhaseSpan: "150000",
  supplementalRate: pctToRate("5"),
};

const ME_EDITIONS_BY_YEAR: Record<number, MeYearRates> = {
  [ME_RATES_2026.year]: ME_RATES_2026,
};

export const ME_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Maine Withholding Tables for Individual Income Tax (2026)",
  effectiveFrom: "2026-01-01",
  citation:
    "Maine Revenue Services, Withholding Tables for Individual Income Tax, "
    + "Revised December 2025 — 2026 percentage method Steps 1–6, $5,300 "
    + "allowance, $12,450 / $27,750 withholding standard deduction, Examples 1–3",
  status: "published",
  region: "ME",
}];

export function meRatesForPayDate(payDate: string): MeYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = ME_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(ME_WITHHOLDING, year);
  }
  return rates;
}

export function meRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

/**
 * Step 3 standard deduction, including the phase-out.
 *
 * Example 3 prints $27,750 × $120,550 / $150,000 = $22,302 — the exact
 * product is $22,301.75, rounded to the nearest dollar. That is the
 * booklet's own arithmetic, not an engine guess.
 */
export function meStandardDeduction(annualWages: bigint, married: boolean, rates: MeYearRates): bigint {
  const full = U(married ? rates.marriedStandardDeduction : rates.singleStandardDeduction);
  const start = U(married ? rates.marriedPhaseStart : rates.singlePhaseStart);
  const end = U(married ? rates.marriedPhaseEnd : rates.singlePhaseEnd);
  const span = U(married ? rates.marriedPhaseSpan : rates.singlePhaseSpan);
  if (annualWages <= start) return full;
  if (annualWages >= end) return 0n;
  return meRoundToDollar(roundDiv(full * (end - annualWages), span));
}

export function meAnnualTax(taxable: bigint, married: boolean): bigint {
  if (taxable <= 0n) return 0n;
  if (!married) {
    if (taxable < U("27400")) return mulRateCents(taxable, pctToRate("5.80"));
    if (taxable < U("64850")) {
      return U("1589") + mulRateCents(taxable - U("27400"), pctToRate("6.75"));
    }
    return U("4117") + mulRateCents(taxable - U("64850"), pctToRate("7.15"));
  }
  if (taxable < U("54850")) return mulRateCents(taxable, pctToRate("5.80"));
  if (taxable < U("129750")) {
    return U("3181") + mulRateCents(taxable - U("54850"), pctToRate("6.75"));
  }
  return U("8237") + mulRateCents(taxable - U("129750"), pctToRate("7.15"));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = meRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Maine withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("ME_EXEMPT", 1n);
    return { state: "ME", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // Invalid / missing W-4ME: "withhold as if the employee or payee were
  // single and claiming no allowances."
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as MeFilingStatus;
  const married = status === "married";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("ME_ANNUAL_WAGES", annualWages);

  const personal = U(rates.allowance) * BigInt(allowances);
  trace("ME_ALLOWANCES", personal);
  const standard = meStandardDeduction(annualWages, married, rates);
  trace("ME_STANDARD_DEDUCTION", standard);

  const taxable = max0(annualWages - personal - standard);
  trace("ME_TAXABLE", taxable);

  const annualTax = meRoundToDollar(meAnnualTax(taxable, married));
  trace("ME_ANNUAL_TAX", annualTax);
  const periodTax = meRoundToDollar(divIntCents(annualTax, P));
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("ME_WITHHELD", total);

  return {
    state: "ME",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const ME_WITHHOLDING: UsStateWithholdingEngine = {
  state: "ME",
  label: "Maine income tax",
  certificateKey: "us_me_w4me",
  ratesModule: RATES_MODULE,
  editions: ME_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Maine withholding declarations — Form W-4ME and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form W-4ME, Employee's Maine Withholding Allowance Certificate (2026). */
export const ME_CERTIFICATE: PayrollCertificate = {
  key: "us_me_w4me",
  form: "W-4ME",
  label: "Employee's Maine Withholding Allowance Certificate",
  scope: { level: "region", region: "ME" },
  purpose: "withholding",
  citation:
    "Maine Revenue Services, Withholding Tables for Individual Income Tax, "
    + "Revised December 2025 (2026 booklet); Form W-4ME (2026); MRS Rule 803",
  summary:
    "Sets Maine marital status and withholding allowances. If the employee "
    + "does not provide a valid W-4ME, MRS requires withholding as single "
    + "with no allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Box 3 — Marital status",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single or head of household, or married withholding at the single rate" },
        { value: "married", label: "Married" },
      ],
      help:
        "Use the married percentage schedule only when Married is checked. "
        + "\"Married, but withholding at higher single rate\" and Single / "
        + "Head of Household both use the single schedule. Default Single is "
        + "MRS's own rule when no valid W-4ME is on file.",
    },
    {
      key: "allowances",
      label: "Total number of Maine withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is $5,300 a year. Claiming more than the W-4ME "
        + "worksheet allows requires a Personal Withholding Allowance "
        + "Variance Certificate. Default zero is MRS's missing-form rule.",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount requested on W-4ME. Added AFTER the percentage "
        + "method is de-annualized and rounded to the nearest dollar.",
    },
    {
      key: "exempt",
      label: "Line 6 — Exempt from Maine withholding",
      kind: "flag",
      help:
        "Federal exempt, Form W-4P no-withholding, or resident with no Maine "
        + "liability last year and none expected this year. A current exempt "
        + "flag withholds zero. The resident exemption expires December 31.",
    },
  ],
};

export const ME_REGION: PayrollRegionWithholding = {
  region: "ME",
  label: "Maine income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_me_w4me",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "MRS, Withholding Tables for Individual Income Tax, Revised December 2025; "
    + "Form W-4ME (2026); MRS Rule 803",
};
