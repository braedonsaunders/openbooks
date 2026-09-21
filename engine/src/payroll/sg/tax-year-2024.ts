import type { SgYearTables } from "./rates.ts";

/**
 * Transcribed 2024 statutory tables for the SG payroll pack (calendar year,
 * `taxYear: 2024`).
 *
 * Every figure below is quoted from the authority's own publication named in
 * its comment. "No quote, no citation": the sentence carrying the number is
 * reproduced so a reviewer can check the transcription without re-fetching.
 * Secondary sources (vendors, payroll blogs, other ERPs) were used nowhere —
 * not even as corroboration — except where noted for the standing SDL rule.
 *
 * Sourcing outcomes per host (recorded distinctly):
 * - cpf.gov.sg content/dam: 200, full text — the Table 1 rate PDF
 *   (CPF_contribution_rates_from_1_Jan_2024.pdf, 5 pages: Tables 1–5 plus
 *   computation steps) fetched 2026-09-20.
 * - cpf.gov.sg shepherd download: 200, full text — the 2024 "Examples for
 *   computation of Additional Wage (AW) Ceiling" (3 worked examples, all
 *   below-55 employees), fetched 2026-09-20. This is the module's golden
 *   source: its OW rows are Board-printed employer/employee figures, not
 *   engine output.
 * - cpf.gov.sg SDL page: the standing Skills Development Levy rule, unchanged
 *   since 1 Oct 2008 (see the freeze note on SG_2024_SDL).
 *
 * Singapore levies no monthly income-tax withholding: this module carries CPF
 * and SDL figures only. A "tax year" for SG selects CPF parameters, not a
 * withholding table — no withholding table is manufactured here.
 *
 * One edition: the 2024 Table 1 is titled "from 1 January 2024" and the OW
 * ceiling step ($6,300 → $6,800) took effect on 1 January 2024 — not
 * September. (September dating exists in this history exactly once: the
 * $6,000 → $6,300 step of September 2023, which the 2024 table supersedes.)
 * No mid-year 2024 change was found, so 2024 needs exactly one edition.
 */

/**
 * Ordinary Wage ceiling per calendar month, 2024: "OW: Ordinary Wages
 * (capped at OW Ceiling of $6,800)" (Table 1 notes, CPF Board,
 * CPF_contribution_rates_from_1_Jan_2024.pdf p. 1). Raised from $6,300 on
 * 1 January 2024 — the first of the three January steps completing the
 * Budget-2023 rise ($6,300 Sep 2023 → $6,800 Jan 2024 → $7,400 Jan 2025 →
 * $8,000 Jan 2026).
 */
export const SG_2024_OW_CEILING_MONTHLY = "6800.00";

/**
 * Table 1, 55 & below, 2024 (CPF Board,
 * CPF_contribution_rates_from_1_Jan_2024.pdf p. 1), in full:
 *
 *     "$50 or less: Nil / Nil"
 *     "> $50 to $500: 17% (TW) / Nil"
 *     "> $500 to $750: 17% (TW) + 0.6 (TW - $500) / 0.6 (TW - $500)"
 *     "> $750: [37% (OW)]* + 37% (AW) / [20% (OW)]* + 20% (AW)"
 *     "* Max. of $2,516 / * Max. of $1,360"
 *
 * The percentages and the phase-in shape are identical to 2025 and 2026 —
 * only the OW ceiling (hence the maxima: 37% × $6,800 = $2,516;
 * 20% × $6,800 = $1,360) moves. The engine prices OW only (AW is refused);
 * the maxima therefore cap the OW leg directly.
 */
export const SG_2024_CPF_LE55 = {
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
  /** "* Max. of $2,516" — maximum total contribution on OW. */
  maxTotalOw: "2516.00",
  /** "* Max. of $1,360" — maximum employee-share contribution on OW. */
  maxEmployeeOw: "1360.00",
} as const;

/**
 * Skills Development Levy, 2024: "0.25% of the monthly total wages",
 * "minimum $2 for an employee earning less than $800 a month", "maximum
 * $11.25 for an employee earning more than $4,500 a month" (CPF Board,
 * Skills Development Levy page). FROZEN across 2024/2025/2026: the last
 * revision was 1 Oct 2008 ("1 Oct 2008 – current: $4,500 / 0.25% / $2 /
 * $11.25"), so these are the same strings as SG_SDL_2026 by standing rule,
 * not by carry-forward assumption. The per-year conformance test pins the
 * freeze: if the Board ever moves SDL, the year that moves must diverge
 * here and argue with that test.
 */
export const SG_2024_SDL = {
  ratePct: "0.25",
  minWage: "800.00",
  minLevy: "2.00",
  maxWage: "4500.00",
  maxLevy: "11.25",
} as const;

/**
 * Additional Wage ceiling at a full-OW 2024: "$102,000 - Total Ordinary
 * Wages (OW) subject to CPF for the year" (CPF Board, AW-ceiling formula,
 * unchanged across the window), i.e. "$102,000 – ($6,800 x 12) = $20,400"
 * (CPF Board, Examples for computation of Additional Wage (AW) Ceiling,
 * 2024 edition, example 1). Informational only: AW is refused by name (no
 * channel carries YTD OW); the figure exists so the refusal names the
 * year's own ceiling.
 */
export const SG_2024_AW_CEILING_AT_FULL_OW = "20400.00";

/**
 * Deliberately NOT transcribed (each refused by name in the engine):
 *
 * - The other four Table 1 age bands, quoted here so the refusal is
 *   checkable against the same PDF p. 1 — and note the steps, which are
 *   exactly why a 2026 carry-back would be wrong money for everyone over
 *   55: Above 55–60 "[31% (OW)]* / [16% (OW)]*" (max $2,108/$1,088);
 *   Above 60–65 "[22% (OW)]* / [10.5% (OW)]*" (max $1,496/$714);
 *   Above 65–70 "[16.5% (OW)]* / [7.5% (OW)]*" (max $1,122/$510);
 *   Above 70 "[12.5% (OW)]* / [5% (OW)]*" (max $850/$340). The 55–60 and
 *   60–65 bands rose on 1 Jan 2025 and again on 1 Jan 2026; the two oldest
 *   bands are frozen across all three years.
 * - Tables 2–5 (SPR 1st/2nd-year graduated rates, G/G and F/G).
 * - Allocation across the Ordinary / Special / MediSave accounts.
 * - Foreign-worker levy (MOM).
 */
export const SG_2024_TABLES: SgYearTables = {
  year: 2024,
  owCeilingMonthly: SG_2024_OW_CEILING_MONTHLY,
  cpfLe55: SG_2024_CPF_LE55,
  sdl: SG_2024_SDL,
  awCeilingAtFullOw: SG_2024_AW_CEILING_AT_FULL_OW,
};
