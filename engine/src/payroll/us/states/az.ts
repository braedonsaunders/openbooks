/**
 * Arizona income tax withholding — Form A-4 percentage of GROSS TAXABLE WAGES.
 *
 * Sources (fetched from azdor.gov and azleg.gov, not memory):
 *   Arizona Form A-4, Employee's Arizona Withholding Election 2026,
 *     published 01/01/2026 —
 *     https://azdor.gov/sites/default/files/document/FORMS_WITHHOLDING_2026_A-4_f.pdf
 *     https://azdor.gov/forms/withholding-forms/arizona-withholding-percentage-election
 *     "The amount withheld is a percentage of your gross taxable wages from
 *     every paycheck." Line 1 percents: 0.5%, 1.0%, 1.5%, 2.0%, 2.5%, 3.0%,
 *     3.5%, plus an optional extra dollar amount. Line 2: elect zero if the
 *     employee expects no Arizona tax liability.
 *   Arizona Department of Revenue, Withholding Tax (business) and Withholding
 *     Tax — Individual, fetched 2026-08-21 —
 *     https://azdor.gov/business/withholding-tax
 *     https://azdor.gov/individuals/withholding-tax-individual
 *     "If the new employee fails to complete Arizona Form A-4 within 5 days of
 *     hire, the employer must withhold Arizona income tax at the rate of 2.0%
 *     until the employee elects a different withholding rate."
 *     "Rates are a percentage of gross taxable wages."
 *   A.R.S. § 43-401(E) — https://azleg.gov/ars/43/00401.htm
 *     "Any employee failing to complete an election form as prescribed shall be
 *     deemed to have elected the withholding percentage prescribed by the
 *     department." ADOR prescribes 2.0%.
 *
 * This is NOT a percentage-of-federal-withholding election. Older pack notes
 * (and a retired Publication 011) described that method; Form A-4 2026 and
 * the current ADOR pages do not. The tax is `gross taxable wages × elected
 * percent`, plus any extra amount on line 1. Federal income tax is not an
 * input. Inventing a federal-tax dependency would withhold the wrong money
 * for every Arizona employee.
 *
 * The 2.0% default is the form's and the statute's stated default when no A-4
 * is on file. It is declared on the certificate. The engine refuses if the
 * percent is missing rather than substituting a number of its own.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateFlag, type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/az.ts";

/** Line 1 percents, exactly as Form A-4 2026 prints them. */
export const AZ_PRINTED_PERCENTS = [
  "0.5", "1.0", "1.5", "2.0", "2.5", "3.0", "3.5",
] as const;

export type AzPrintedPercent = (typeof AZ_PRINTED_PERCENTS)[number];

export interface AzYearRates {
  year: number;
  status: "published" | "draft";
  /** The percent ADOR withholds when no A-4 is on file, as printed. */
  defaultPrintedPercent: AzPrintedPercent;
  printedPercents: readonly AzPrintedPercent[];
}

export const AZ_RATES_2026: AzYearRates = {
  year: 2026,
  status: "published",
  defaultPrintedPercent: "2.0",
  printedPercents: AZ_PRINTED_PERCENTS,
};

const AZ_EDITIONS_BY_YEAR: Record<number, AzYearRates> = {
  [AZ_RATES_2026.year]: AZ_RATES_2026,
};

export const AZ_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Arizona Form A-4 (2026), published 01/01/2026",
  effectiveFrom: "2026-01-01",
  citation:
    "Arizona Department of Revenue, Form A-4 Employee's Arizona Withholding Election 2026 "
    + "(published 01/01/2026), line 1 percents of gross taxable wages and the 2.0% no-form "
    + "default; A.R.S. § 43-401(E); azdor.gov/business/withholding-tax",
  status: "published",
  region: "AZ",
}];

export function azRatesForPayDate(payDate: string): AzYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = AZ_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(AZ_WITHHOLDING, year);
  }
  return rates;
}

export function azRateForPrintedPercent(printed: string): string {
  return pctToRate(printed);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = azRatesForPayDate(input.payDate);
  const factors: Record<string, string> = {};

  // Form A-4 line 2: "I elect an Arizona withholding percentage of zero, and I
  // certify that I expect to have no Arizona tax liability for the current
  // taxable year." ADOR: the employer "will not withhold Arizona income tax".
  if (certificateFlag(input.certificate, "zero_percent")) {
    factors.AZ_ZERO = "1";
    return {
      state: "AZ", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors,
    };
  }

  const printed = certificateChoice(input.certificate, "withholding_percent");
  if (printed == null) {
    throw new Error(
      "Arizona Form A-4 withholding percentage is missing — the form and A.R.S. "
      + "§ 43-401(E) prescribe 2.0% of gross taxable wages when no A-4 is on file, "
      + "and that default lives on the certificate. The engine will not invent a percent.",
    );
  }
  if (!(rates.printedPercents as readonly string[]).includes(printed)) {
    throw new Error(
      `Arizona Form A-4 does not offer a ${printed}% withholding election — `
      + `printed percents: ${rates.printedPercents.join(", ")}`,
    );
  }

  const rate = azRateForPrintedPercent(printed);
  factors.AZ_PRINTED_PERCENT = printed;
  factors.AZ_RATE = rate;

  // Form A-4: "a percentage of your gross taxable wages from every paycheck."
  // Supplemental wages are compensation under A.R.S. § 43-401(A) ("wages,
  // salary, bonus or other emolument") and take the same percent.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  factors.AZ_WAGES = D(wages);

  const tax = mulRateCents(wages, rate);
  factors.AZ_TAX = D(tax);

  // Line 1 extra amount — a flat dollar amount after the percent, not taxed by it.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  factors.AZ_EXTRA = D(extra);

  return {
    state: "AZ",
    year: rates.year,
    tax: D(tax + extra),
    taxSupplemental: D(0n),
    factors,
  };
}

export const AZ_WITHHOLDING: UsStateWithholdingEngine = {
  state: "AZ",
  label: "Arizona income tax",
  certificateKey: "us_az_a4",
  ratesModule: RATES_MODULE,
  editions: AZ_TAX_YEAR_EDITIONS,
  // A percent of this period's wages. Any pay frequency computes.
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/** Arizona Form A-4, Employee's Arizona Withholding Election 2026. */
export const AZ_CERTIFICATE: PayrollCertificate = {
  key: "us_az_a4",
  form: "A-4",
  label: "Employee's Arizona Withholding Election",
  scope: { level: "region", region: "AZ" },
  purpose: "withholding",
  citation:
    "Arizona Form A-4, Employee's Arizona Withholding Election 2026 (published 01/01/2026); "
    + "A.R.S. § 43-401(E); azdor.gov/business/withholding-tax",
  summary:
    "Elects an Arizona withholding percent of gross taxable wages. If no A-4 is on file "
    + "within five days of hire, A.R.S. § 43-401(E) and ADOR require the employer to "
    + "withhold 2.0%.",
  storage: "certificate_rows",
  fields: [
    {
      key: "withholding_percent",
      label: "Line 1 — Arizona withholding percentage",
      kind: "choice",
      choices: [
        { value: "0.5", label: "0.5%" },
        { value: "1.0", label: "1.0%" },
        { value: "1.5", label: "1.5%" },
        { value: "2.0", label: "2.0%" },
        { value: "2.5", label: "2.5%" },
        { value: "3.0", label: "3.0%" },
        { value: "3.5", label: "3.5%" },
      ],
      default: "2.0",
      required: true,
      help:
        "A percent of GROSS TAXABLE WAGES, not of federal withholding. Form A-4 2026 "
        + "line 1. Default 2.0% is ADOR's prescribed rate when no A-4 is on file — not "
        + "an engine guess.",
    },
    {
      key: "additional_per_period",
      label: "Line 1 — Extra amount to be withheld from each paycheck",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Optional extra dollars after the elected percent. Added, not multiplied.",
    },
    {
      key: "zero_percent",
      label:
        "Line 2 — I elect an Arizona withholding percentage of zero (no Arizona tax liability)",
      kind: "flag",
      help:
        "The employee certifies they expect no Arizona tax liability for the current "
        + "taxable year. Must be renewed each year. The employer withholds nothing.",
    },
  ],
};

export const AZ_REGION: PayrollRegionWithholding = {
  region: "AZ",
  label: "Arizona income tax",
  implemented: true,
  // A.R.S. § 43-401(A): withhold from compensation "for services performed
  // within this state".
  taxesNonresidentWages: true,
  // Form A-4V is a VOLUNTARY request for an Arizona resident employed outside
  // Arizona. Withholding on out-of-state wages of a resident is not required.
  residentWithholding: "not_required",
  residentWithholdingImplemented: true,
  certificateKey: "us_az_a4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Arizona Form A-4 (2026); A.R.S. § 43-401; azdor.gov/business/withholding-tax",
};
