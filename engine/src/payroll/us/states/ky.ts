/**
 * Kentucky income-tax withholding — 2026 Kentucky Withholding Tax Formula
 * (flat 3.5% after the standard deduction).
 *
 * Source (fetched from revenue.ky.gov, not memory):
 *   42A003 (TCF)(10-2025), "2026 KENTUCKY WITHHOLDING TAX FORMULA",
 *     https://revenue.ky.gov/Forms/2026%20Withholding%20Formula.pdf
 *     — standard deduction $3,360; tax rate 3.5% of taxable income; the
 *       annualized formula and both 2026 worked examples.
 *   Form 42A804 (K-4) (2026),
 *     https://revenue.ky.gov/Forms/42A804%20(K-4)%20(2026).pdf
 *     — the four exemption checkboxes and the additional-withholding line.
 *     "Form K-4 is only required to document that an employee has requested
 *     an exemption from withholding OR to document that an employee has
 *     requested additional withholding." With neither, the employer
 *     withholds the formula amount — there are no allowances to default.
 *
 * The formula, verbatim:
 *
 *   Wages for the pay period × annual pay periods = annual wages.
 *   Annual wages − the Kentucky standard deduction = annual Kentucky wages.
 *   3.5% of that = gross annual Kentucky tax.
 *   Divide by the number of annual pay periods = withholding for the period.
 *
 * The bi-weekly worked example prints a typo ("$35,730" for a figure it
 * itself computed as $35,640) and then prints "$47" for $1,247.40 ÷ 26,
 * which is $47.98 to the cent. The monthly example is internally consistent
 * and is the conformance golden. The engine follows the formula, not the
 * bi-weekly example's rounded $47.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, max0, mulRateCents, rate6, U } from "../../canada/decimal.ts";
import { mulRatio } from "../../../money/money.ts";
import {
  certificateAmount, certificateFlag, type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/ky.ts";

export interface KyYearRates {
  year: number;
  status: "published" | "draft";
  /** "2026 Kentucky Tax Rate: 3.5% of taxable income". */
  rate: string;
  /** "2026 Kentucky Standard Deduction: $3,360". */
  standardDeduction: string;
}

export const KY_RATES_2026: KyYearRates = {
  year: 2026,
  status: "published",
  rate: pctToRate("3.5"),
  standardDeduction: "3360",
};

const KY_EDITIONS_BY_YEAR: Record<number, KyYearRates> = {
  [KY_RATES_2026.year]: KY_RATES_2026,
};

export const KY_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "42A003 (TCF)(10-2025) 2026 Kentucky Withholding Tax Formula",
  effectiveFrom: "2026-01-01",
  citation:
    "Kentucky Department of Revenue, 42A003 (TCF)(10-2025), 2026 Kentucky Withholding Tax "
    + "Formula — standard deduction $3,360, flat rate 3.5%, monthly and bi-weekly worked "
    + "examples; Form 42A804 (K-4) (2026)",
  status: "published",
  region: "KY",
}];

export function kyRatesForPayDate(payDate: string): KyYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = KY_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(KY_WITHHOLDING, year);
  }
  return rates;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = kyRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new PayrollError(`invalid pay periods per year for Kentucky withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("KY_EXEMPT", 1n);
    return { state: "KY", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // 42A003 does not print a separate supplemental-wage rule. The period's
  // wages — regular plus any supplemental paid with them — are annualized
  // together, which is the formula as written.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("KY_ANNUAL_WAGES", annualWages);

  const taxable = max0(annualWages - U(rates.standardDeduction));
  trace("KY_TAXABLE", taxable);

  const annualTax = mulRateCents(taxable, rates.rate);
  trace("KY_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  trace("KY_TAX", periodTax);

  // K-4 "Additional withholding per pay period" — added AFTER the rate.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("KY_WITHHELD", total);

  return {
    state: "KY",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are the 42A003 2026 formula's own — see the module
 * header.
 */
export const KY_FACTOR_LABELS: Readonly<Record<string, string>> = {
  KY_EXEMPT: "Exempt from Kentucky withholding",
  KY_ANNUAL_WAGES: "Kentucky annualized wages",
  KY_TAXABLE: "Kentucky taxable income",
  KY_ANNUAL_TAX: "Kentucky tax (annual)",
  KY_TAX: "Kentucky tax this period",
  KY_WITHHELD: "Kentucky tax withheld this period",
  LOU_BASIS: "Louisville occupational tax basis (resident or nonresident)",
  LOU_RATE: "Louisville occupational tax rate",
  LOU_RATE_EFFECTIVE: "Louisville occupational tax rate effective date",
  LOU_BASE: "Louisville occupational tax wage base",
  LOU_TAX: "Louisville occupational tax this period",
};

export const KY_WITHHOLDING: UsStateWithholdingEngine = {
  state: "KY",
  label: "Kentucky income tax",
  certificateKey: "us_ky_k4",
  ratesModule: RATES_MODULE,
  editions: KY_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ---------------------------------------------------------------------------
// Louisville Metro occupational license tax (Jefferson County)
// ---------------------------------------------------------------------------

/**
 * Louisville Metro occupational license tax, by effective date. The Revenue
 * Commission prices the employer's withholding on gross compensation for work
 * performed within Louisville/Jefferson County: 2.2% for residents, 1.45%
 * for nonresidents (2026 Form W-1REE).
 *
 * Sources (fetched, not memory):
 *   Louisville Metro Revenue Commission, Forms and Publications,
 *     https://louisvilleky.gov/government/revenue-commission/forms-and-publications
 *   2026 Form W-1REE (Withholding Reconciliation / occupational rates),
 *     https://louisvilleky.gov/sites/default/files/2026-02/W-1REE_Form_2025%20V2ADA.pdf
 */
export interface LouisvilleDatedRate {
  effectiveFrom: string;
  /** Resident occupational rate, decimal fraction. */
  resident: string;
  /** Nonresident occupational rate, decimal fraction. */
  nonresident: string;
  source: string;
}

export const LOUISVILLE_RATES: readonly LouisvilleDatedRate[] = [{
  effectiveFrom: "2026-01-01",
  resident: pctToRate("2.2"),
  nonresident: pctToRate("1.45"),
  source: "Louisville Metro Revenue Commission, 2026 Form W-1REE (resident 2.2%, nonresident 1.45%)",
}];

export const LOUISVILLE_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Louisville Metro occupational license tax (2026 Form W-1REE rates)",
  effectiveFrom: "2026-01-01",
  citation:
    "Louisville Metro Revenue Commission, Forms and Publications; 2026 Form W-1REE "
    + "(resident 2.2%, nonresident 1.45% on gross compensation for work within Louisville/Jefferson County)",
  status: "published",
  region: "KY",
}];

export function louisvilleRateFor(
  payDate: string,
  basis: "resident" | "nonresident",
): { rate: string; effectiveFrom: string } {
  const period = [...LOUISVILLE_RATES]
    .filter((entry) => entry.effectiveFrom <= payDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .at(-1);
  if (!period) {
    throw new PayrollError(
      `no Louisville occupational tax rate is loaded for a pay date of ${payDate} — transcribe the `
      + `Revenue Commission's effective rate into ${RATES_MODULE}.`,
    );
  }
  return {
    rate: basis === "resident" ? period.resident : period.nonresident,
    effectiveFrom: period.effectiveFrom,
  };
}

/**
 * The Louisville Metro occupational license tax.
 *
 * A flat rate on the period's gross compensation for work performed within
 * Louisville/Jefferson County — no allowances, no annualization, no
 * supplemental split. The rate follows the employee's residency (2.2% /
 * 1.45%), selected from `input.basis` exactly as the Philadelphia engine
 * does: storing one Louisville rate would bill every commuter at the wrong
 * one. Residents owe on their full compensation; a nonresident's base is the
 * Louisville share where the run records a verified KY/LOUISVILLE work
 * allocation, else the period's wages — a missing allocation never silently
 * narrows the base, it keeps the full period the auditor's scenario prices.
 */
function computeLouisville(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const { rate, effectiveFrom } = louisvilleRateFor(input.payDate, input.basis);
  let base = U(input.wages) + U(input.supplemental ?? "0");
  if (input.basis === "nonresident") {
    const matches = (input.wageAllocations ?? []).filter(
      (item) => item.region === "KY" && item.subRegion === "LOUISVILLE",
    );
    if (matches.length === 1) {
      let share: bigint;
      try {
        share = rate6(matches[0]!.workShare);
      } catch {
        throw new PayrollError(
          "KY/LOUISVILLE work allocation must be an exact decimal share from 0 through 1; "
          + "correct the verified work-share input before calculating",
        );
      }
      if (share < 0n || share > 1_000_000n) {
        throw new PayrollError(
          "KY/LOUISVILLE work allocation is outside 0–1; "
          + "correct the verified work-share input before calculating",
        );
      }
      base = U(mulRatio(D(base), share, 1_000_000n));
    }
  }
  const tax = mulRateCents(base, rate);
  return {
    state: "KY-LOU",
    year: Number(input.payDate.slice(0, 4)),
    tax: D(tax),
    taxSupplemental: D(0n),
    factors: {
      LOU_BASIS: input.basis,
      LOU_RATE: rate,
      LOU_RATE_EFFECTIVE: effectiveFrom,
      LOU_BASE: D(base),
      LOU_TAX: D(tax),
    },
  };
}

export const LOUISVILLE_WITHHOLDING: UsStateWithholdingEngine = {
  state: "KY-LOU",
  label: "Louisville Metro occupational license tax",
  certificateKey: null,
  ratesModule: RATES_MODULE,
  editions: LOUISVILLE_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute: computeLouisville,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Kentucky withholding declarations — Form K-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form 42A804 (K-4) (2026). */
export const KY_CERTIFICATE: PayrollCertificate = {
  key: "us_ky_k4",
  form: "K-4",
  label: "Kentucky's Withholding Certificate",
  scope: { level: "region", region: "KY" },
  purpose: "withholding",
  citation:
    "Kentucky Form 42A804 (K-4) (2026); 42A003 (TCF)(10-2025) 2026 Kentucky Withholding Tax Formula",
  summary:
    "Documents an exemption from Kentucky withholding or a request for additional withholding. "
    + "\"If neither situation applies, then an employer is not required to maintain Form K-4.\" "
    + "The formula itself has no allowances — every wage earner is taxed at 3.5% after the "
    + "$3,360 standard deduction.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exempt",
      label: "Exempt from Kentucky withholding",
      kind: "flag",
      help:
        "K-4 boxes 1–4: no 2026 Kentucky income-tax liability expected; Fort Campbell "
        + "nonresident exemption; nonresident military-spouse (SCRA); or resident of a "
        + "reciprocal state (IL, IN, MI, WV, WI; VA with a daily commute; OH if not a "
        + "20%-or-greater S-corporation shareholder-employee). Any one box stops withholding. "
        + "The exemption must be on file before withholding can be stopped.",
    },
    {
      key: "additional_per_period",
      label: "Additional withholding per pay period under agreement with employer",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the 3.5% formula — a flat dollar amount, not a taxable adjustment.",
    },
  ],
};

/**
 * Where the employee works / resides for Kentucky local occupational taxes —
 * the pack's own record, mirroring Oregon's transit record.
 *
 * No agency form carries it: the Revenue Commission taxes work performed in
 * Louisville/Jefferson County and prices residents and nonresidents
 * differently, and neither the K-4 nor the W-1REE is an employee certificate.
 * The employer determines both answers from the work and home addresses and
 * records them here, which is what lets the resolver produce the
 * Louisville/Jefferson levy on the correct side at the correct rate. Both
 * flags name the SAME sub-region code: a resident working in Louisville is
 * collected on both sides and settled once, on the resident basis, by the
 * region's `both` rule — pushing two different codes would price the full
 * rate twice. An unasserted flag is outside Louisville (the Oregon transit
 * record's own semantic), never an unknown the engine must refuse over.
 */
export const KY_LOCALITY_RECORD: PayrollCertificate = {
  key: "us_ky_locality_record",
  form: "(employer-determined)",
  label: "Kentucky local-tax work and residence locality",
  scope: { level: "region", region: "KY" },
  purpose: "withholding",
  citation:
    "Louisville Metro Revenue Commission, Forms and Publications "
    + "(https://louisvilleky.gov/government/revenue-commission/forms-and-publications); "
    + "2026 Form W-1REE (resident 2.2%, nonresident 1.45%)",
  summary:
    "Whether the employee's work is performed inside Louisville Metro (Jefferson County) "
    + "and whether they reside there. Louisville levies its occupational license tax on "
    + "gross compensation for work within the county at 2.2% for residents and 1.45% for "
    + "nonresidents; no Kentucky form records either fact, so the employer asserts both "
    + "from the addresses.",
  storage: "certificate_rows",
  fields: [
    {
      key: "work_in_louisville", label: "Work performed inside Louisville/Jefferson County",
      kind: "flag",
      subRegion: { side: "work", code: "LOUISVILLE" },
      help: "Set when the work address for this employment is inside Louisville Metro "
        + "(all of Jefferson County) — look the address up against the county boundary. "
        + "Leave it unset for work performed anywhere else; an unset answer is outside, "
        + "never unknown.",
    },
    {
      key: "resides_in_louisville", label: "Resides inside Louisville/Jefferson County",
      kind: "flag",
      subRegion: { side: "residence", code: "LOUISVILLE" },
      help: "Set when the employee's home address is inside Louisville Metro (all of "
        + "Jefferson County). A Kentucky resident outside Jefferson County leaves this "
        + "unset: they owe the state tax but no Louisville occupational tax.",
    },
  ],
};

export const KY_REGION: PayrollRegionWithholding = {
  region: "KY",
  label: "Kentucky income tax",
  implemented: true,
  // KRS 141 and the Department's employer page: withhold for resident and
  // nonresident employees unless a published exemption applies.
  taxesNonresidentWages: true,
  // 42A003: an out-of-state employer MAY voluntarily withhold Kentucky tax
  // on a Kentucky resident working outside Kentucky — permitted, never
  // required.
  residentWithholding: "not_required",
  residentWithholdingImplemented: true,
  certificateKey: "us_ky_k4",
  subRegions: [
    {
      code: "LOUISVILLE",
      label: "Louisville Metro occupational license tax",
      kind: "city",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "pack" },
      // Computed by LOUISVILLE_WITHHOLDING (a Philadelphia-model dedicated
      // engine: one Louisville rate would bill every commuter at the wrong
      // one), so no flat_rate method is declared here. Left inside the
      // region's `both` rule deliberately: a resident working in Louisville
      // is collected on both sides under the same code and settled once, on
      // the resident basis.
      citation:
        "Louisville Metro Revenue Commission, Forms and Publications; 2026 Form W-1REE "
        + "(resident 2.2%, nonresident 1.45% on gross compensation for work within "
        + "Louisville/Jefferson County)",
      implemented: true,
    },
  ],
  subRegionConflictRule: "both",
  citation:
    "Kentucky Department of Revenue, 42A003 (TCF)(10-2025), 2026 Kentucky Withholding Tax "
    + "Formula; Form 42A804 (K-4) (2026)",
};
