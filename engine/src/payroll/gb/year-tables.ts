/**
 * One transcribed GB year's tables, in the single shape the statutory engine
 * reads. Both prior-year modules conform to it alongside the 2026/27 tables:
 * a new edition adds a year module plus one `GB_<year>_TABLES` entry, never a
 * branch in the computation (the IT pack's `ItYearTables` pattern).
 *
 * The engine's existing entry points keep their 2026/27 behaviour when no
 * tables are passed, so the 2026/27 parity harnesses pin the defaults while
 * the per-year conformance suites pin each prior year through these tables.
 */

import { PayrollPackError } from "../payroll-error.ts";
import {
  GB_2024_AE_QUALIFYING_BAND_LOWER,
  GB_2024_AE_QUALIFYING_BAND_UPPER,
  GB_2024_AE_TRIGGER_ANNUAL,
  GB_2024_EMPLOYMENT_ALLOWANCE_ANNUAL,
  GB_2024_MONTH_ONE_END,
  GB_2024_NIC_ANNUAL,
  GB_2024_NIC_EMPLOYEE_MAIN_RATE,
  GB_2024_NIC_EMPLOYEE_UPPER_RATE,
  GB_2024_NIC_EMPLOYER_RATE,
  GB_2024_NIC_MONTHLY,
  GB_2024_NIC_WEEKLY,
  GB_2024_PERSONAL_ALLOWANCE_ANNUAL,
  GB_2024_RUK_BANDS,
  GB_2024_SCT_BANDS,
  GB_2024_TAX_YEAR_END,
  GB_2024_TAX_YEAR_START,
} from "./rates-2024.ts";
import {
  GB_2025_AE_QUALIFYING_BAND_LOWER,
  GB_2025_AE_QUALIFYING_BAND_UPPER,
  GB_2025_AE_TRIGGER_ANNUAL,
  GB_2025_EMPLOYMENT_ALLOWANCE_ANNUAL,
  GB_2025_MONTH_ONE_END,
  GB_2025_NIC_ANNUAL,
  GB_2025_NIC_EMPLOYEE_MAIN_RATE,
  GB_2025_NIC_EMPLOYEE_UPPER_RATE,
  GB_2025_NIC_EMPLOYER_RATE,
  GB_2025_NIC_MONTHLY,
  GB_2025_NIC_WEEKLY,
  GB_2025_PERSONAL_ALLOWANCE_ANNUAL,
  GB_2025_RUK_BANDS,
  GB_2025_SCT_BANDS,
  GB_2025_TAX_YEAR_END,
  GB_2025_TAX_YEAR_START,
} from "./rates-2025.ts";
import {
  GB_AE_QUALIFYING_BAND_LOWER,
  GB_AE_QUALIFYING_BAND_UPPER,
  GB_AE_TRIGGER_ANNUAL,
  GB_EMPLOYMENT_ALLOWANCE_ANNUAL,
  GB_NIC_ANNUAL,
  GB_NIC_EMPLOYEE_MAIN_RATE,
  GB_NIC_EMPLOYEE_UPPER_RATE,
  GB_NIC_EMPLOYER_RATE,
  GB_NIC_MONTHLY,
  GB_NIC_WEEKLY,
  GB_PERSONAL_ALLOWANCE_ANNUAL,
  GB_RUK_BANDS,
  GB_SCT_BANDS,
  GB_TAX_YEAR,
  GB_TAX_YEAR_END,
  GB_TAX_YEAR_START,
  type GbNicThresholds,
  type GbRukBand,
  type GbSctBand,
} from "./rates.ts";

/** Last pay date whose record is complete by definition (tax month 1, 2026/27). */
export const GB_MONTH_ONE_END = "2026-05-05";

/**
 * The figures the GB statutory arithmetic prices from: PAYE bands and the
 * Personal Allowance, Class 1 NIC thresholds and rates, and the declared
 * (never computed) Employment Allowance and auto-enrolment band. Amounts are
 * decimal strings; rates are exact decimal fractions ("0.08", "0.138").
 */
export interface GbYearTables {
  readonly year: number;
  readonly yearStart: string;
  readonly yearEnd: string;
  readonly monthOneEnd: string;
  readonly personalAllowanceAnnual: string;
  readonly rukBands: readonly GbRukBand[];
  readonly sctBands: readonly GbSctBand[];
  readonly nicAnnual: GbNicThresholds;
  readonly nicWeekly: GbNicThresholds;
  readonly nicMonthly: GbNicThresholds;
  readonly nicEmployeeMainRate: string;
  readonly nicEmployeeUpperRate: string;
  readonly nicEmployerRate: string;
  readonly employmentAllowanceAnnual: string;
  readonly aeTriggerAnnual: string;
  readonly aeQualifyingBandLower: string;
  readonly aeQualifyingBandUpper: string;
}

/** The transcribed 2026/27 tables (rates.ts), as the engine reads them. */
export const GB_2026_TABLES: GbYearTables = {
  year: GB_TAX_YEAR,
  yearStart: GB_TAX_YEAR_START,
  yearEnd: GB_TAX_YEAR_END,
  monthOneEnd: GB_MONTH_ONE_END,
  personalAllowanceAnnual: GB_PERSONAL_ALLOWANCE_ANNUAL,
  rukBands: GB_RUK_BANDS,
  sctBands: GB_SCT_BANDS,
  nicAnnual: GB_NIC_ANNUAL,
  nicWeekly: GB_NIC_WEEKLY,
  nicMonthly: GB_NIC_MONTHLY,
  nicEmployeeMainRate: GB_NIC_EMPLOYEE_MAIN_RATE,
  nicEmployeeUpperRate: GB_NIC_EMPLOYEE_UPPER_RATE,
  nicEmployerRate: GB_NIC_EMPLOYER_RATE,
  employmentAllowanceAnnual: GB_EMPLOYMENT_ALLOWANCE_ANNUAL,
  aeTriggerAnnual: GB_AE_TRIGGER_ANNUAL,
  aeQualifyingBandLower: GB_AE_QUALIFYING_BAND_LOWER,
  aeQualifyingBandUpper: GB_AE_QUALIFYING_BAND_UPPER,
};

/** The transcribed 2025/26 tables (rates-2025.ts), as the engine reads them. */
export const GB_2025_TABLES: GbYearTables = {
  year: 2025,
  yearStart: GB_2025_TAX_YEAR_START,
  yearEnd: GB_2025_TAX_YEAR_END,
  monthOneEnd: GB_2025_MONTH_ONE_END,
  personalAllowanceAnnual: GB_2025_PERSONAL_ALLOWANCE_ANNUAL,
  rukBands: GB_2025_RUK_BANDS,
  sctBands: GB_2025_SCT_BANDS,
  nicAnnual: GB_2025_NIC_ANNUAL,
  nicWeekly: GB_2025_NIC_WEEKLY,
  nicMonthly: GB_2025_NIC_MONTHLY,
  nicEmployeeMainRate: GB_2025_NIC_EMPLOYEE_MAIN_RATE,
  nicEmployeeUpperRate: GB_2025_NIC_EMPLOYEE_UPPER_RATE,
  nicEmployerRate: GB_2025_NIC_EMPLOYER_RATE,
  employmentAllowanceAnnual: GB_2025_EMPLOYMENT_ALLOWANCE_ANNUAL,
  aeTriggerAnnual: GB_2025_AE_TRIGGER_ANNUAL,
  aeQualifyingBandLower: GB_2025_AE_QUALIFYING_BAND_LOWER,
  aeQualifyingBandUpper: GB_2025_AE_QUALIFYING_BAND_UPPER,
};

/** The transcribed 2024/25 tables (rates-2024.ts), as the engine reads them. */
export const GB_2024_TABLES: GbYearTables = {
  year: 2024,
  yearStart: GB_2024_TAX_YEAR_START,
  yearEnd: GB_2024_TAX_YEAR_END,
  monthOneEnd: GB_2024_MONTH_ONE_END,
  personalAllowanceAnnual: GB_2024_PERSONAL_ALLOWANCE_ANNUAL,
  rukBands: GB_2024_RUK_BANDS,
  sctBands: GB_2024_SCT_BANDS,
  nicAnnual: GB_2024_NIC_ANNUAL,
  nicWeekly: GB_2024_NIC_WEEKLY,
  nicMonthly: GB_2024_NIC_MONTHLY,
  nicEmployeeMainRate: GB_2024_NIC_EMPLOYEE_MAIN_RATE,
  nicEmployeeUpperRate: GB_2024_NIC_EMPLOYEE_UPPER_RATE,
  nicEmployerRate: GB_2024_NIC_EMPLOYER_RATE,
  employmentAllowanceAnnual: GB_2024_EMPLOYMENT_ALLOWANCE_ANNUAL,
  aeTriggerAnnual: GB_2024_AE_TRIGGER_ANNUAL,
  aeQualifyingBandLower: GB_2024_AE_QUALIFYING_BAND_LOWER,
  aeQualifyingBandUpper: GB_2024_AE_QUALIFYING_BAND_UPPER,
};

/**
 * The transcribed tables for a GB tax year, or a refusal naming the year.
 * Never extrapolates: a year without transcribed tables is refused, not
 * priced from a neighbour's.
 */
export function gbTablesForTaxYear(year: number): GbYearTables {
  if (year === GB_2026_TABLES.year) return GB_2026_TABLES;
  if (year === GB_2025_TABLES.year) return GB_2025_TABLES;
  if (year === GB_2024_TABLES.year) return GB_2024_TABLES;
  throw new PayrollPackError(
    `GB payroll pack has no transcribed tables for tax year ${year} — transcribed years: `
    + "2024, 2025, 2026 (see GB_TAX_YEARS). A year without transcribed tables is refused, "
    + "never priced from another year's tables.",
  );
}
