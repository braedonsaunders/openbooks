import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollEditionScaffold, PayrollTaxYearSupport } from "../tax-years.ts";

/**
 * Singapore — 2026 statutory transcription for the CPF/SDL engine (`./cpf.ts`).
 *
 * Sourced from the Central Provident Fund Board's own publications, fetched
 * 2026-09-18 (HTTP 200, no challenge body):
 *
 * - "CPF Contribution Rate Table from 1 January 2026 for Singapore Citizens
 *   or Singapore Permanent Residents (3rd year onwards)" (Table 1 of
 *   CPFcontributionratesfrom1Jan2026.pdf, cpf.gov.sg, 5 pages). Its 55-and-
 *   below row reads, in full:
 *
 *       "$50 or less: Nil / Nil"
 *       "> $50 to $500: 17% (TW) / Nil"
 *       "> $500 to $750: 17% (TW) + 0.6 (TW - $500) / 0.6 (TW - $500)"
 *       "> $750: [37% (OW)]* + 37% (AW) / [20% (OW)]* + 20% (AW)"
 *       "* Max. of $2,960 / * Max. of $1,600"
 *
 *   with the notes "OW: Ordinary Wages (capped at OW ceiling of $8,000)",
 *   "AW: Additional Wages", "TW: Total Wages = OW + AW", and the computation
 *   steps: "1) Compute the total CPF contribution (rounded to the nearest
 *   dollar), i.e., to be rounded down for an amount less than 50 cents and
 *   rounded up for an amount of 50 cents and above. 2) Compute the
 *   employee's share of CPF contribution (rounded down to the nearest
 *   dollar). 3) Employer's share = Total contribution - Employee's share".
 * - "Examples for computation of Additional Wage (AW) Ceiling" (CPF Board):
 *   "The AW ceiling is computed using the following formula: $102,000 -
 *   Total Ordinary Wages (OW) subject to CPF for the year. For the year
 *   2026, the AW ceiling is $102,000 - ($8,000 x 12)".
 * - "Skills Development Levy" (cpf.gov.sg/employer/employer-obligations/
 *   skills-development-levy): "The levy payable for each employee is at
 *   0.25% of the monthly total wages. The minimum payable is $2 for an
 *   employee earning less than $800 a month and the maximum is $11.25 for
 *   an employee earning more than $4,500 a month." "The SDL is a compulsory
 *   levy that you have to pay for all your employees working in Singapore,
 *   including foreign employees." "Add up the SDL calculated for each
 *   employee and then round the total amount down to the nearest dollar."
 * - "Who should receive CPF contributions" (cpf.gov.sg): "As an employer,
 *   you're required to pay CPF contributions for employees who are
 *   Singapore Citizens or Singapore Permanent Residents, and who are
 *   earning total wages of more than $50 per month." "Foreigners: Persons
 *   who are not Singapore Citizens or Singapore Permanent Residents" are
 *   listed under "Who is exempted from receiving CPF contributions".
 *
 * Deliberately NOT transcribed, each refused by name in the engine:
 *
 * - The other four Table 1 age bands (Above 55–60, 60–65, 65–70, Above 70):
 *   their rows are quoted in the engine's refusal, but only the 55-and-
 *   below row is wired. A second band is a second transcription, not an
 *   index into this one.
 * - Tables 2–5 (SPR 1st/2nd-year graduated rates, G/G and F/G): the
 *   graduated employer/employee rates are a different table per SPR year.
 * - The Additional Wage ceiling: "$102,000 - Total OW subject to CPF for
 *   the year" is YEAR-dependent — it needs the employee's year-to-date OW,
 *   which no compute-context channel carries. Any non-periodic (AW) pay is
 *   refused rather than priced against a guessed ceiling.
 * - Allocation across the Ordinary / Special / MediSave accounts: the pack
 *   computes the total and the two shares only.
 * - Foreign-worker levy (MOM): foreign employees are refused by name — they
 *   attract a levy instead of CPF, and the levy schedule is not transcribed.
 */

/** CPF status answers the rate table is keyed on (Table 1 header + Tables 2–5). */
export type SgCpfStatus =
  | "citizen"
  | "spr_3rd_year"
  | "spr_1st_year"
  | "spr_2nd_year"
  | "foreigner";

/** Table 1 age bands, exactly as printed ("55 & below" … "Above 70"). */
export type SgAgeBand = "le55" | "b55_60" | "b60_65" | "b65_70" | "gt70";

/**
 * Ordinary Wage ceiling per calendar month, 2026: "OW: Ordinary Wages
 * (capped at OW ceiling of $8,000)" (Table 1 notes). Raised to $8,000 from
 * 1 January 2026 (Budget 2023: the monthly salary ceiling rises to $8,000
 * by 2026).
 */
export const SG_OW_CEILING_MONTHLY_2026 = "8000.00";

/**
 * Total-wages floor below which no CPF is payable: "earning total wages of
 * more than $50 per month" (Who should receive CPF contributions); Table 1
 * row "$50 or less: Nil / Nil".
 */
export const SG_CPF_FLOOR_2026 = "50.00";

/**
 * Table 1, 55 & below, "> $750" row: "[37% (OW)]* + 37% (AW)" total,
 * "[20% (OW)]* + 20% (AW)" employee share, "* Max. of $2,960" total and
 * "* Max. of $1,600" employee share on OW. The engine prices OW only (AW is
 * refused); the maxima therefore cap the OW leg directly.
 */
export const SG_CPF_2026_LE55 = {
  /** "17% (TW)" total for "> $50 to $500"; employee share "Nil". */
  phaseTotalPct: "17",
  /** "0.6 (TW - $500)" — the phase-in slope for "> $500 to $750". */
  phaseSlope: "0.6",
  phaseFrom: "500.00",
  phaseTo: "750.00",
  /** "[37% (OW)]*" — total rate on OW above $750. */
  totalPct: "37",
  /** "[20% (OW)]*" — employee rate on OW above $750. */
  employeePct: "20",
  /** "* Max. of $2,960" — maximum total contribution on OW. */
  maxTotalOw: "2960.00",
  /** "* Max. of $1,600" — maximum employee-share contribution on OW. */
  maxEmployeeOw: "1600.00",
} as const;

/**
 * Skills Development Levy, 2026: "0.25% of the monthly total wages",
 * "minimum $2 for an employee earning less than $800 a month", "maximum
 * $11.25 for an employee earning more than $4,500 a month". The employer
 * total rounds down to the nearest dollar ("Add up the SDL calculated for
 * each employee and then round the total amount down to the nearest
 * dollar") — the per-employee line is priced to the cent (half up), stated
 * in `./cpf.ts`, because the Board publishes no per-employee cent rule.
 */
export const SG_SDL_2026 = {
  ratePct: "0.25",
  minWage: "800.00",
  minLevy: "2.00",
  maxWage: "4500.00",
  maxLevy: "11.25",
} as const;

/** The one transcribed year. */
export const SG_TRANSCRIBED_YEARS = [2026] as const;

export const SG_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [],
  barrels: [],
  steps: [
    "Transcribe the next year's CPF Contribution Rate Table (Table 1, citizens / 3rd-year SPR) from cpf.gov.sg into engine/src/payroll/sg/rates.ts.",
    "Confirm the OW ceiling and the $102,000 AW-ceiling formula for the year against the Board's AW ceiling examples.",
    "Confirm the SDL rate, floor and cap against the CPF Board's Skills Development Levy page.",
    "Add a published edition to SG_TAX_YEARS with the edition label and citation, plus conformance goldens against the Board's worked examples.",
  ],
};

export const SG_TAX_YEARS: PayrollTaxYearSupport = {
  country: "SG",
  editions: [
    {
      year: 2026,
      label: "CPF Contribution Rate Table from 1 January 2026 (Table 1) + SDL",
      effectiveFrom: "2026-01-01",
      citation:
        "CPF Board, CPF Contribution Rate Table from 1 January 2026 for Singapore Citizens "
        + "or Singapore Permanent Residents (3rd year onwards), Table 1; CPF Board, Examples for "
        + "computation of Additional Wage (AW) Ceiling; CPF Board, Skills Development Levy; "
        + "CPF Board, Who should receive CPF contributions",
      status: "published",
    },
  ],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/sg/rates.ts",
  scaffold: SG_EDITION_SCAFFOLD,
};

/**
 * Tenant-entered statutory rates: none. Every CPF figure is a published
 * Table 1 constant and the SDL rate/floor/cap are published above; nothing
 * is experience-rated or per-account, so declaring a slot would be a shape
 * without a reader.
 */
export const SG_PACK_RATES: PayrollPackRates = {
  country: "SG",
  slots: [],
};
