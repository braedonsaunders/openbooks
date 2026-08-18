/**
 * Pennsylvania withholding — the state personal income tax, the Philadelphia
 * wage tax, and the Act 32 local earned income tax.
 *
 * Sources (fetched from pa.gov, dced.pa.gov and phila.gov, not memory):
 *   REV-415 (Employer Withholding Information Guide) and REV-580, and
 *     pa.gov/agencies/revenue — the flat 3.07% rate and the rule that it
 *     applies to ALL taxable compensation with no allowances, no standard
 *     deduction and no brackets.
 *   PA PIT Guide (DSM-12, 12-2023) — the reciprocity rule, the REV-419
 *     condition, and the working-day allocation formulas.
 *   dced.pa.gov Act 32 FAQ and Local Withholding Tax FAQs — the "higher of the
 *     total resident rate and the work-location nonresident rate" rule, PSD
 *     codes, and Philadelphia's exclusion from Act 32 (Sterling Act).
 *   phila.gov Tax Rate History — the wage tax rates, which change every 1 July.
 *   pa.gov/agencies/dli — the PA UC EMPLOYEE withholding rate.
 *
 * ---------------------------------------------------------------------------
 * Why Pennsylvania is in this wave
 * ---------------------------------------------------------------------------
 * It proves a different table shape from California and New York: there is no
 * table at all. Withholding is `compensation × 0.0307`. The interesting parts
 * are everything AROUND the rate, and they are exactly the mechanisms this work
 * exists to build:
 *
 *   - RECIPROCITY with six states, conditional on Form REV-419 being on file,
 *     and withholding at the full 3.07% when it is not.
 *   - SUB-REGION levies of two different kinds at once: Philadelphia's wage tax
 *     (published rates, outside Act 32, follows RESIDENCE regardless of PA work
 *     location) and the Act 32 earned income tax (2,500 jurisdictions, employer-
 *     entered rates, settled by the higher-of rule).
 *   - An EMPLOYEE-side unemployment contribution, which almost no other state
 *     has, on gross wages with NO wage cap.
 *
 * ---------------------------------------------------------------------------
 * What reciprocity does and does not reach
 * ---------------------------------------------------------------------------
 * A New Jersey resident with a REV-419 on file pays NO Pennsylvania personal
 * income tax — and still pays the Philadelphia wage tax in full, still pays the
 * Act 32 local EIT, and still pays PA UC employee withholding. NJ-WT (September
 * 2025) says so in terms: "The reciprocal agreement does not excuse a
 * Pennsylvania employer from withholding local wage taxes imposed by cities,
 * towns, or other localities in Pennsylvania for New Jersey resident
 * employees."
 *
 * That is why `PayrollReciprocityAgreement.relievesSubRegionLevies` exists and
 * why every Pennsylvania agreement declares it FALSE. A system that let
 * reciprocity cascade downward would under-withhold the Philadelphia
 * nonresident rate — 3.425% of gross, with no cap — for every New Jersey
 * commuter, and the City would eventually assess it with interest.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/pa.ts";

/**
 * A rate that takes effect on a date INSIDE a tax year.
 *
 * Philadelphia revises its wage tax every 1 July, and phila.gov states the rule
 * plainly: the rate is keyed to the PAY DATE, not to the period worked. A single
 * rate per tax year would be wrong for half of every year.
 */
interface PaDatedRate {
  effectiveFrom: string;
  /** Exclusive. */
  effectiveTo: string | null;
  resident: string;
  nonresident: string;
}

export interface PaYearRates {
  year: number;
  status: "published" | "draft";
  /** The flat personal income tax rate on compensation. */
  rate: string;
  /**
   * PA UC EMPLOYEE withholding — Pennsylvania is one of very few states where
   * the EMPLOYEE contributes to unemployment. On TOTAL gross wages with NO wage
   * base: "Employee contributions are based on an individual's total (gross)
   * wages and are not limited to the taxable wage base in effect for employer
   * contributions."
   */
  ucEmployeeRate: string;
  /** Philadelphia wage tax, by effective date. */
  philadelphia: readonly PaDatedRate[];
}

export const PA_RATES_2026: PaYearRates = {
  year: 2026,
  status: "published",
  // pa.gov personal income tax rates: "2004 – Present | 3.07%".
  rate: "0.0307",
  // pa.gov/agencies/dli yearly tax highlights, CY2026: "0.07 percent (70 cents
  // per $1,000 gross wages)", in effect for 2023 and thereafter.
  ucEmployeeRate: "0.0007",
  philadelphia: [
    // phila.gov Tax Rate History. The 2026 calendar year spans two Philadelphia
    // rate periods; both are carried, and the pay date selects.
    { effectiveFrom: "2025-07-01", effectiveTo: "2026-07-01", resident: "0.0374", nonresident: "0.0343" },
    { effectiveFrom: "2026-07-01", effectiveTo: "2027-07-01", resident: "0.03735", nonresident: "0.03425" },
  ],
};

const PA_EDITIONS_BY_YEAR: Record<number, PaYearRates> = {
  [PA_RATES_2026.year]: PA_RATES_2026,
};

export const PA_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "PA PIT 3.07% (REV-415 / REV-580); Philadelphia wage tax eff. 2026-07-01",
  effectiveFrom: "2026-01-01",
  citation:
    "PA Department of Revenue, Employer Withholding (REV-415, REV-580) — flat 3.07%; "
    + "PA DLI CY2026 employee UC withholding 0.07%; City of Philadelphia Tax Rate History",
  status: "published",
  region: "PA",
}];

export function paRatesForPayDate(payDate: string): PaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = PA_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(PA_WITHHOLDING, year);
  }
  return rates;
}

// ---------------------------------------------------------------------------
// Pennsylvania personal income tax
// ---------------------------------------------------------------------------

function computePa(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = paRatesForPayDate(input.payDate);
  const factors: Record<string, string> = {};

  // REV-415: "If an employee receives supplemental or other compensation, an
  // employer must determine the tax to withhold by ADDING the supplemental or
  // other compensation for the current payroll period and multiplying this
  // amount by the withholding rate." There is no separate supplemental rate,
  // and no election — one rate on the sum.
  const compensation = U(input.wages) + U(input.supplemental ?? "0");
  factors.PA_COMPENSATION = D(compensation);

  const tax = mulRateCents(compensation, rates.rate);
  factors.PA_TAX = D(tax);

  // Pennsylvania publishes NO withholding allowance certificate, and the engine
  // therefore reads none. There is no filing status, no allowance count and no
  // employee-elected extra amount to read: REV-419 turns withholding OFF under a
  // reciprocal agreement (resolved upstream, by the reciprocity resolver) and
  // never adjusts an amount. `input.certificate` is deliberately untouched.
  factors.PA_UC_EMPLOYEE = D(mulRateCents(compensation, rates.ucEmployeeRate));

  return {
    state: "PA",
    year: rates.year,
    tax: D(tax),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * PA UC employee withholding — an EMPLOYEE deduction, not an income tax, so it
 * is returned separately rather than folded into `tax`.
 *
 * On total gross wages with no cap. The department's own rounding instruction
 * is "carried out to three decimal places, dropping the excess and rounding to
 * the nearest whole cent", which is half-up to the cent — `mulRateCents`.
 */
export function paUcEmployeeWithholding(payDate: string, grossWages: string): string {
  const rates = paRatesForPayDate(payDate);
  return D(mulRateCents(U(grossWages), rates.ucEmployeeRate));
}

export const PA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "PA",
  label: "Pennsylvania personal income tax",
  certificateKey: null,
  ratesModule: RATES_MODULE,
  editions: PA_TAX_YEAR_EDITIONS,
  // A flat rate on the period's compensation computes at any frequency.
  printedPeriods: null,
  compute: computePa,
};

// ---------------------------------------------------------------------------
// Philadelphia — the Sterling Act wage tax, OUTSIDE Act 32
// ---------------------------------------------------------------------------

export function philadelphiaRateFor(
  payDate: string,
  basis: "resident" | "nonresident",
): { rate: string; effectiveFrom: string } {
  const rates = paRatesForPayDate(payDate);
  const period = rates.philadelphia.find((entry) =>
    payDate >= entry.effectiveFrom && (entry.effectiveTo == null || payDate < entry.effectiveTo));
  if (!period) {
    throw new Error(
      `no Philadelphia wage tax rate is loaded for a pay date of ${payDate} — the City revises the `
      + `rate every 1 July and the rate is keyed to the PAY DATE. Transcribe the period from `
      + `phila.gov's Tax Rate History into ${RATES_MODULE}.`,
    );
  }
  return {
    rate: basis === "resident" ? period.resident : period.nonresident,
    effectiveFrom: period.effectiveFrom,
  };
}

/**
 * The Philadelphia wage tax.
 *
 * Two properties that no other levy in this wave has, both from DCED's Act 32
 * FAQ:
 *
 *   - A Philadelphia RESIDENT pays the resident rate no matter where in
 *     Pennsylvania they work: "Act 32 does not apply. Employers are required to
 *     withhold the Philadelphia resident rate for employees who live in
 *     Philadelphia, but work outside of Philadelphia." So the levy reaches the
 *     RESIDENCE side unconditionally, and it does NOT enter the Act 32
 *     higher-of comparison — it overrides it.
 *   - A nonresident working in Philadelphia pays the nonresident rate, which is
 *     materially lower. Storing "the Philadelphia rate" as one number bills
 *     every commuter at the wrong one.
 *
 * There is no exemption, no allowance and no floor. The income-based reduced
 * rate for taxpayers with PA tax forgiveness is a REFUND the taxpayer claims,
 * not a withholding change, and is deliberately not applied here.
 */
function computePhiladelphia(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = paRatesForPayDate(input.payDate);
  const { rate, effectiveFrom } = philadelphiaRateFor(input.payDate, input.basis);
  const compensation = U(input.wages) + U(input.supplemental ?? "0");
  const tax = mulRateCents(compensation, rate);
  return {
    state: "PA-PHILA",
    year: rates.year,
    tax: D(tax),
    taxSupplemental: D(0n),
    factors: {
      PHILA_BASIS: input.basis,
      PHILA_RATE: rate,
      PHILA_RATE_EFFECTIVE: effectiveFrom,
      PHILA_TAX: D(tax),
    },
  };
}

export const PHILADELPHIA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "PA-PHILA",
  label: "Philadelphia wage tax",
  certificateKey: null,
  ratesModule: RATES_MODULE,
  editions: PA_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute: computePhiladelphia,
};

// ---------------------------------------------------------------------------
// Act 32 local earned income tax
// ---------------------------------------------------------------------------

/**
 * The Act 32 local EIT, once the higher-of comparison has already picked a rate.
 *
 * The COMPARISON is not here: it is the generic `higher_rate` conflict rule in
 * `withholding-resolution.ts`, driven by the region's declaration. That is
 * deliberate — Ohio's municipalities settle the same way and must not need a
 * second copy of the logic, and the comparison needs both jurisdictions' rates,
 * which is a resolution-level fact rather than a calculation-level one.
 *
 * What is Pennsylvania-specific and therefore lives here: the RESIDENT rate is
 * the municipality's rate PLUS the school district's rate (DCED's register
 * reports them as two rows summing to the "Total Resident EIT Rate"), while the
 * NONRESIDENT rate is the municipal rate alone — school districts levy no
 * nonresident EIT. An employer entering a single "local rate" for both sides
 * would over-withhold every commuter by the school district's share.
 */
export function act32LocalEit(input: {
  compensation: string;
  /** The resolved rate, as a decimal ("0.0128" for 1.28%). */
  rate: string;
}): string {
  return D(mulRateCents(max0(U(input.compensation)), input.rate));
}

/**
 * The Local Services Tax — a flat ANNUAL dollar amount, prorated per pay
 * period, not a rate. Follows the WORK location.
 *
 * DCED: where the combined rate exceeds $10 the tax is assessed per payroll
 * period by dividing the annual amount by the number of pay periods, and
 * "employers are required to round DOWN to the nearest one-hundredth of a
 * dollar" — a truncation, not the half-up rounding everything else in this
 * engine uses. $52 ÷ 12 = $4.3333 → $4.33; $36 ÷ 52 = $0.6923 → $0.69.
 *
 * The $52 statutory maximum is NOT a constant: DCED's own register reports
 * $156.00 for Scranton, an Act 47 distressed city, with a $15,600 low-income
 * exemption rather than $12,000. Both are employer-entered jurisdiction data.
 */
export function localServicesTaxPerPeriod(input: {
  /** The jurisdiction's combined annual LST, from the DCED register. */
  annualAmount: string;
  periodsPerYear: number;
  /** The employee has filed the upfront low-income exemption certificate. */
  exempt?: boolean;
}): string {
  if (input.exempt) return D(0n);
  const annual = U(input.annualAmount);
  if (annual <= U("10")) {
    // "$10 or less" may be collected as a lump sum and carries no mandatory
    // exemption. Prorating it anyway would be a different tax from the one the
    // jurisdiction levied, so this refuses to guess.
    throw new Error(
      "a Local Services Tax of $10 or less a year is collected as a lump sum, not prorated per "
      + "pay period (DCED, Local Services Tax). Record it as a one-time deduction.",
    );
  }
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear < 1) {
    throw new Error(`invalid pay periods per year for the Local Services Tax: ${input.periodsPerYear}`);
  }
  // Truncate to the cent — DCED's own instruction, and the reason this does not
  // use `divIntCents`, which rounds half-up.
  const CENT = 100n;
  const perPeriod = annual / BigInt(input.periodsPerYear);
  return D((perPeriod / CENT) * CENT);
}
