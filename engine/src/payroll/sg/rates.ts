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
 * One transcribed year's CPF/SDL parameters — the unit the engine selects on.
 *
 * 2026 lives in this module (`SG_OW_CEILING_MONTHLY_2026`,
 * `SG_CPF_2026_LE55`, `SG_SDL_2026` below); 2025 and 2024 live in
 * `./tax-year-2025.ts` and `./tax-year-2024.ts` in the
 * `tax-year-{year}.ts` convention. The Table 1 le55 ROW SHAPE (17% phase,
 * 0.6 slope, 37%/20% above $750) is identical in all three years — each
 * year module quotes its own PDF to that effect — so only the OW ceiling,
 * the OW-leg maxima, and the informational AW-ceiling estimate move.
 */
export interface SgYearTables {
  readonly year: number;
  /** Monthly OW ceiling, decimal string ("7400.00"). */
  readonly owCeilingMonthly: string;
  /** Table 1, 55 & below, "> $750" row plus the phase-in rows. */
  readonly cpfLe55: {
    readonly phaseTotalPct: string;
    readonly phaseSlope: string;
    readonly phaseFrom: string;
    readonly phaseTo: string;
    readonly totalPct: string;
    readonly employeePct: string;
    readonly maxTotalOw: string;
    readonly maxEmployeeOw: string;
  };
  /** SDL rate/floor/cap — frozen across the transcribed window (see each year module). */
  readonly sdl: {
    readonly ratePct: string;
    readonly minWage: string;
    readonly minLevy: string;
    readonly maxWage: string;
    readonly maxLevy: string;
  };
  /**
   * $102,000 − (the year's OW ceiling × 12) at a full-OW year —
   * informational only (AW is refused: no channel carries YTD OW), so the
   * AW refusal names the year's own ceiling.
   */
  readonly awCeilingAtFullOw: string;
}

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

/**
 * Additional Wage ceiling at a full-OW 2026: "$102,000 - Total Ordinary
 * Wages (OW) subject to CPF for the year" (CPF Board, AW-ceiling formula),
 * i.e. "Estimated Additional Wage (AW) ceiling: $102,000 – ($8,000 x 12) =
 * $6,000" (CPF Board, Examples for computation of Additional Wage (AW)
 * Ceiling, 2026 edition). Informational only, like its 2025/2024 siblings.
 */
export const SG_2026_AW_CEILING_AT_FULL_OW = "6000.00";

/** The three transcribed years. */
export const SG_TRANSCRIBED_YEARS = [2024, 2025, 2026] as const;

const SG_YEAR_MODULE_TEMPLATE = `import type { SgYearTables } from "./rates.ts";
import { UNFILLED } from "../unfilled.ts";

/**
 * Transcribed {year} statutory tables for the SG payroll pack (calendar year,
 * \`taxYear: {year}\`).
 *
 * TRANSCRIBE FROM THE PUBLICATION — never from memory, never from the prior
 * year's module. Per-figure sources, in order:
 *
 * - CPF Board, "CPF Contribution Rate Table from 1 January {year} for
 *   Singapore Citizens or Singapore Permanent Residents (3rd year onwards)",
 *   Table 1 (cpf.gov.sg): the 55-and-below row in full (the phase rows, the
 *   37%/20% rates, the OW-leg maxima), the OW-ceiling note, and the
 *   computation steps. Quote the row verbatim in the comment above the
 *   constant it fills.
 * - CPF Board, "Examples for computation of Additional Wage (AW) Ceiling"
 *   ({year} edition): the "$102,000 - Total OW subject to CPF" formula and
 *   the at-full-OW estimate. No {year}-dated examples PDF may be linked yet:
 *   cite what you used instead (e.g. IRAS's CPF-relief page with {year}
 *   inputs) and record the miss in the module header.
 * - CPF Board, Skills Development Levy page: the 0.25% rate, $2 floor,
 *   $11.25 cap. SDL is frozen since 1 Oct 2008 — if it still is, say so and
 *   pin the freeze in tax-year-{year}.test.ts; if it moved, this year
 *   diverges here.
 * - The other four Table 1 age bands: quote them in the deliberately-NOT-
 *   transcribed note (they move in January steps — a carry-back is wrong
 *   money for everyone over 55) and keep refusing them by name.
 *
 * Singapore levies no monthly income-tax withholding: this module carries CPF
 * and SDL figures only. Establish whether the {year} OW-ceiling step took
 * effect on 1 January or mid-year (September dating happened in 2023) — a
 * mid-year change needs TWO editions, not one.
 */

export const SG_{year}_OW_CEILING_MONTHLY = UNFILLED;

export const SG_{year}_CPF_LE55 = {
  phaseTotalPct: UNFILLED,
  phaseSlope: UNFILLED,
  phaseFrom: UNFILLED,
  phaseTo: UNFILLED,
  totalPct: UNFILLED,
  employeePct: UNFILLED,
  maxTotalOw: UNFILLED,
  maxEmployeeOw: UNFILLED,
} as const;

export const SG_{year}_SDL = {
  ratePct: UNFILLED,
  minWage: UNFILLED,
  minLevy: UNFILLED,
  maxWage: UNFILLED,
  maxLevy: UNFILLED,
} as const;

export const SG_{year}_AW_CEILING_AT_FULL_OW = UNFILLED;

export const SG_{year}_TABLES: SgYearTables = {
  year: {year},
  owCeilingMonthly: SG_{year}_OW_CEILING_MONTHLY,
  cpfLe55: SG_{year}_CPF_LE55,
  sdl: SG_{year}_SDL,
  awCeilingAtFullOw: SG_{year}_AW_CEILING_AT_FULL_OW,
};
`;

const SG_YEAR_TEST_TEMPLATE = `/**
 * SG {year} conformance goldens.
 *
 * SCAFFOLD — generated by scripts/payroll-new-tax-year.ts, and FAILING ON
 * PURPOSE until the {year} edition is transcribed and its published goldens are
 * pasted in below. Follow tax-year-2025.test.ts: every golden is a figure read
 * out of the Board's own Table 1 or its worked examples, hand-worked
 * independently of the engine — never engine output pasted back in.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../unfilled.ts";
import { calculateSgStatutory } from "./cpf.ts";
import { SG_{year}_TABLES } from "./tax-year-{year}.ts";

/**
 * Published goldens. Paste at least three {year} goldens: one OW figure at or
 * above the year's OW ceiling (proving the ceiling binds), one below-ceiling
 * OW figure, and one SDL figure — each with the Board document and table that
 * prints it.
 */
const PUBLISHED: { ordinaryWages: string; totalCents: bigint; employeeCents: bigint; employerCents: bigint }[] = [
  // { ordinaryWages: "9000.00", totalCents: 0n, employeeCents: 0n, employerCents: 0n },
];

test("{year} CPF tables are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(SG_{year}_TABLES);
  assert.deepEqual(
    unfilled, [],
    "transcribe every {year} figure from the Board's Table 1 — still unfilled: " + unfilled.join(", "),
  );
  assert.ok(
    PUBLISHED.length >= 3,
    "paste at least three published {year} goldens — an edition with no goldens proves nothing",
  );
});

test("{year} published CPF goldens", () => {
  for (const golden of PUBLISHED) {
    const result = calculateSgStatutory({
      taxYear: {year},
      cpfStatus: "citizen",
      ageBand: "le55",
      ordinaryWages: golden.ordinaryWages,
    });
    assert.equal(result.totalCents, golden.totalCents, \`OW $\${golden.ordinaryWages} total\`);
    assert.equal(result.employeeCents, golden.employeeCents, \`OW $\${golden.ordinaryWages} employee\`);
    assert.equal(result.employerCents, golden.employerCents, \`OW $\${golden.ordinaryWages} employer\`);
  }
});
`;

export const SG_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [
    {
      path: "engine/src/payroll/sg/tax-year-{year}.ts",
      purpose: "the year's CPF/SDL figures, every figure placeheld",
      template: SG_YEAR_MODULE_TEMPLATE,
    },
    {
      path: "engine/src/payroll/sg/tax-year-{year}.test.ts",
      purpose: "the failing conformance stub for the year's published goldens",
      template: SG_YEAR_TEST_TEMPLATE,
    },
  ],
  // No generated barrel: editions are declared by hand in SG_TAX_YEARS below
  // (one entry per year, with the agency citation), and the engine selects
  // them from SG_TABLES_BY_YEAR in ./cpf.ts — step 5 names both edits.
  barrels: [],
  steps: [
    "Transcribe the year's CPF Contribution Rate Table (Table 1, citizens / 3rd-year SPR) from cpf.gov.sg into engine/src/payroll/sg/tax-year-{year}.ts, quoting each row verbatim.",
    "Confirm the OW ceiling and the $102,000 AW-ceiling formula for the year against the Board's AW ceiling examples, and establish whether the step took effect on 1 January or mid-year (a mid-year change needs two editions).",
    "Confirm the SDL rate, floor and cap against the CPF Board's Skills Development Levy page (frozen since 1 Oct 2008 — if it moved, diverge here).",
    "Add a published edition to SG_TAX_YEARS in engine/src/payroll/sg/rates.ts with the edition label and citation, and wire the year's tables into SG_TABLES_BY_YEAR in engine/src/payroll/sg/cpf.ts.",
    "Paste at least three published goldens into tax-year-{year}.test.ts (ceiling-binding, below-ceiling, SDL) plus the cross-year discrimination case, and watch the stub fail before it passes.",
  ],
};

export const SG_TAX_YEARS: PayrollTaxYearSupport = {
  country: "SG",
  editions: [
    {
      year: 2024,
      label: "CPF Contribution Rate Table from 1 January 2024 (Table 1) + SDL",
      effectiveFrom: "2024-01-01",
      citation:
        "CPF Board, CPF Contribution Rate Table from 1 January 2024 for Singapore Citizens "
        + "or Singapore Permanent Residents (3rd year onwards), Table 1; CPF Board, Examples for "
        + "computation of Additional Wage (AW) Ceiling (2024 edition); CPF Board, Skills "
        + "Development Levy; CPF Board, Who should receive CPF contributions",
      status: "published",
    },
    {
      year: 2025,
      label: "CPF Contribution Rate Table from 1 January 2025 (Table 1) + SDL",
      effectiveFrom: "2025-01-01",
      citation:
        "CPF Board, CPF Contribution Rate Table from 1 January 2025 for Singapore Citizens "
        + "or Singapore Permanent Residents (3rd year onwards), Table 1; IRAS, Central Provident "
        + "Fund (CPF) Relief for employees (2025 OW/AW ceiling arithmetic: $102,000 − $88,800 = "
        + "$13,200); CPF Board, Skills Development Levy; CPF Board, Who should receive CPF "
        + "contributions",
      status: "published",
    },
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
