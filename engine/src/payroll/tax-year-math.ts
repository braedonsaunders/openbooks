import type { PayrollTaxYearDefinition } from "./packs.ts";
import { PayrollJurisdictionError } from "./payroll-error.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";

/**
 * The tax year a pay date falls in, per the PACK's own year definition.
 *
 * This lives in a LEAF module — importing only its error class and the pure
 * calendar-date validator, never the pack registry or database — on purpose.
 * `packs.ts` imports every country pack to build
 * PAYROLL_COUNTRY_PACKS, and two generic modules (`statutory-rates.ts`,
 * `tax-years.ts`) used to import this arithmetic back out of `packs.ts`, so
 * the first pack to need a runtime function from either of them (Italy,
 * `resolveStatutoryRates`) closed a load-order-dependent cycle:
 * packs.ts -> it/pack.ts -> it/compute-statutory.ts -> ../statutory-rates.ts
 * -> packs.ts, crashing with "Cannot access 'IT_PAYROLL_PACK' before
 * initialization" whenever the pack was entered first (F-reg-003).
 *
 * Date arithmetic over a tax-year basis needs no registry, so it lives here
 * instead. Its input uses the same pure ISO-date validator as API boundaries.
 * `packs.ts` re-exports it, so existing call sites keep working unchanged.
 */
export function taxYearFor(definition: PayrollTaxYearDefinition, payDate: string): number {
  if (!isIsoCalendarDate(payDate)) {
    throw new PayrollJurisdictionError(`invalid pay date "${payDate}"`);
  }
  const year = Number(payDate.slice(0, 4));
  const month = Number(payDate.slice(5, 7));
  const day = Number(payDate.slice(8, 10));
  const opensThisYear = month > definition.startMonth
    || (month === definition.startMonth && day >= definition.startDay);
  const openingYear = opensThisYear ? year : year - 1;
  return definition.namedBy === "opening_year" ? openingYear : openingYear + 1;
}
