/**
 * Colorado income tax withholding — DR 1098, the prescribed employer worksheet.
 *
 * Source (fetched from tax.colorado.gov, not memory):
 *   DR 1098, Colorado Income Tax Withholding Worksheet for Employers
 *     (rev. 11/14/23), https://tax.colorado.gov/sites/tax/files/documents/DR1098_2023.pdf
 *     and the current form listing at https://tax.colorado.gov/DR1098 /
 *     https://tax.colorado.gov/withholding-forms ("Only the most recent version
 *     of each form is published on this page").
 *   Form DR 0004, Colorado Employee Withholding Certificate — optional; when
 *     absent, DR 1098 line 2a falls back to the employee's federal W-4
 *     Step 1(c) filing status.
 *   Wage Withholding FAQs, tax.colorado.gov/withholding-FAQ — tables are no
 *     longer published; this worksheet is the only lawful method.
 *
 * The 11/14/23 worksheet is the Department's posted method. It is not a
 * year-stamped booklet. The constants below are the digits that PDF prints
 * (4.40%, $10,000 MFJ / qualifying surviving spouse, $5,000 otherwise). A
 * later revision must replace this edition — the figures are not extrapolated.
 *
 * Worksheet order, verbatim:
 *   1c  annualize wages (period wages × pay periods in the year)
 *   2a  annual allowance (DR 0004 line 2, else the W-4 status default)
 *   2b  max(1c − 2a, 0)
 *   2c  2b × 4.40%
 *   2d  2c ÷ pay periods
 *   2e  additional amount (DR 0004 line 3)
 *   2f  2d + 2e
 *
 * The PDF prints no rounding rule. Each money step uses the pack's half-up-
 * to-the-cent convention (`mulRateCents` / `divIntCents`).
 *
 * All arithmetic is exact bigint. No floats.
 */
import { D, divIntCents, max0, mulInt, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/co.ts";

export interface CoYearRates {
  year: number;
  status: "published" | "draft";
  rate: string;
  /** DR 1098 line 2a — married filing jointly or qualifying surviving spouse. */
  jointAllowance: string;
  /** DR 1098 line 2a — every other W-4 Step 1(c) status. */
  otherAllowance: string;
}

/**
 * The currently posted DR 1098 (rev. 11/14/23). Applied to 2026 pay dates
 * because that is the worksheet the Department still publishes as current —
 * not because a 2026 booklet was scaled from 2023.
 */
export const CO_RATES_2026: CoYearRates = {
  year: 2026,
  status: "published",
  rate: "0.044",
  jointAllowance: "10000",
  otherAllowance: "5000",
};

const CO_EDITIONS_BY_YEAR: Record<number, CoYearRates> = {
  [CO_RATES_2026.year]: CO_RATES_2026,
};

export const CO_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "DR 1098 (11/14/23)",
  effectiveFrom: "2026-01-01",
  citation:
    "Colorado Department of Revenue, DR 1098 Colorado Income Tax Withholding Worksheet "
    + "for Employers (rev. 11/14/23), lines 1c–2f; Form DR 0004",
  status: "published",
  region: "CO",
}];

export function coRatesForPayDate(payDate: string): CoYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = CO_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(CO_WITHHOLDING, year);
  }
  return rates;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = coRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Colorado withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = mulInt(wages, P);
  trace("CO_ANNUAL_WAGES", annualWages);

  const enteredAllowance = certificateAmount(input.certificate, "annual_allowance");
  const status = certificateChoice(input.certificate, "filing_status") ?? "other";
  const annualAllowance = enteredAllowance != null
    ? U(enteredAllowance)
    : U(status === "married_joint" || status === "surviving_spouse"
      ? rates.jointAllowance
      : rates.otherAllowance);
  trace("CO_ANNUAL_ALLOWANCE", annualAllowance);

  const taxable = max0(annualWages - annualAllowance);
  trace("CO_ANNUAL_TAXABLE", taxable);

  const annualTax = mulRateCents(taxable, rates.rate);
  trace("CO_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("CO_WITHHELD", total);

  return {
    state: "CO",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const CO_WITHHOLDING: UsStateWithholdingEngine = {
  state: "CO",
  label: "Colorado income tax",
  certificateKey: "us_co_dr0004",
  ratesModule: RATES_MODULE,
  editions: CO_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/** Colorado Form DR 0004 — optional. Absent, DR 1098 uses the federal W-4 status. */
export const CO_CERTIFICATE: PayrollCertificate = {
  key: "us_co_dr0004",
  form: "DR 0004",
  label: "Colorado Employee Withholding Certificate",
  scope: { level: "region", region: "CO" },
  purpose: "withholding",
  citation:
    "Colorado Form DR 0004; DR 1098 (rev. 11/14/23) lines 2a and 2e; "
    + "tax.colorado.gov/withholding-FAQ",
  summary:
    "Optional Colorado certificate. When it is not on file, DR 1098 calculates from the "
    + "employee's federal W-4 Step 1(c) filing status and withholds no extra amount.",
  storage: "certificate_rows",
  fields: [
    {
      key: "annual_allowance",
      label: "Line 2 — Annual withholding allowance",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "If filled, this is DR 1098 line 2a in full. If blank — or no DR 0004 is on file — "
        + "line 2a is $10,000 for married filing jointly or qualifying surviving spouse, "
        + "and $5,000 otherwise, exactly as the 11/14/23 worksheet prints.",
    },
    {
      key: "filing_status",
      label: "Federal W-4 Step 1(c) filing status (used when line 2 is blank)",
      kind: "choice",
      default: "other",
      choices: [
        { value: "married_joint", label: "Married filing jointly" },
        { value: "surviving_spouse", label: "Qualifying surviving spouse" },
        { value: "other", label: "Single, married filing separately, or head of household" },
      ],
      help:
        "DR 1098 line 2a reads the federal W-4 when DR 0004 line 2 is blank. The default "
        + "is the $5,000 'otherwise' bucket — the worksheet's own fallback, not a guess.",
    },
    {
      key: "additional_per_period",
      label: "Line 3 — Additional Colorado withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Added after the 4.40% calculation (DR 1098 line 2e). A pre-2022 extra-withholding "
        + "request stays in force until the employee files a new certificate.",
    },
  ],
};

export const CO_REGION: PayrollRegionWithholding = {
  region: "CO",
  label: "Colorado income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // tax.colorado.gov/withholding-tax-filing-requirements: withhold if the
  // employee is a Colorado resident (working anywhere) or a nonresident
  // performing services in Colorado. The out-of-state resident credit is not
  // modelled here, so residence-side withholding stays declared-not-implemented.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_co_dr0004",
  subRegions: [],
  subRegionConflictRule: "both",
  citation: "DR 1098 (rev. 11/14/23); Colorado withholding tax filing requirements",
};
