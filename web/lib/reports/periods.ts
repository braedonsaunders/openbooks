import { currentFiscalYear, fiscalStartMonth, fiscalYearRangeFor } from "../fiscal";

/**
 * Fiscal-year start/end dates for a fiscal year (named by its ending calendar
 * year), driven by the org's configured `fiscalYearStartMonth` — never
 * hardcoded to a calendar year or to April. Reads the setting via
 * `web/lib/fiscal.ts` so a change in Company & Accounting settings flows here.
 */
export async function fiscalYearRange(fyEndYear: number) {
  return fiscalYearRangeFor(fyEndYear, await fiscalStartMonth());
}

/** The current fiscal year (end year) for today, per the org's start month. */
export async function currentFiscalYearEnd(today?: string): Promise<number> {
  return currentFiscalYear(today);
}
