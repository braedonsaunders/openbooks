/**
 * Nexus & filing calendar.
 *
 * A tax registration declares that the org must collect and remit in a
 * jurisdiction, on a filing frequency, using a given return form. From that,
 * the engine derives a filing CALENDAR — the concrete return periods that fall
 * due in a date range — which drives "what do we owe and when" surfaces and
 * feeds each period straight into `computeTaxReturn`.
 *
 * The period math is pure (no database, no clock) so it is fully unit-tested;
 * the DB-backed loader wraps it.
 */
import { civilDateFromParts, daysInCivilMonth } from "../platform/civil-date.ts";

export type FilingFrequency =
  | "monthly"
  | "bimonthly"
  | "quarterly"
  | "semiannual"
  | "annual";

/** Months covered by one return period, per frequency. */
const MONTHS_PER_PERIOD: Record<FilingFrequency, number> = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export interface FilingPeriod {
  /** Inclusive first day, "YYYY-MM-DD". */
  periodStart: string;
  /** Inclusive last day, "YYYY-MM-DD". */
  periodEnd: string;
}

/**
 * Every return period for `frequency` whose period START falls within
 * [rangeFrom, rangeTo]. Periods are aligned to the calendar year from January
 * (a quarterly filer gets Jan–Mar, Apr–Jun, …), which matches how indirect-tax
 * periods are defined in every jurisdiction we ship. Returns them in order.
 */
export function filingPeriods(
  frequency: FilingFrequency,
  rangeFrom: string,
  rangeTo: string,
): FilingPeriod[] {
  const span = MONTHS_PER_PERIOD[frequency];
  const from = new Date(`${rangeFrom}T00:00:00Z`);
  const to = new Date(`${rangeTo}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return [];
  }

  const periods: FilingPeriod[] = [];
  // First period of the range's start year that could overlap: walk aligned
  // period boundaries from January of the start year.
  let year = from.getUTCFullYear();
  let startMonth = 1; // 1-based
  while (true) {
    if (startMonth > 12) {
      startMonth = 1;
      year += 1;
    }
    const endMonthAbsolute = startMonth + span - 1;
    const endYear = year + Math.floor((endMonthAbsolute - 1) / 12);
    const endMonth = ((endMonthAbsolute - 1) % 12) + 1;

    const periodStart = civilDateFromParts(year, startMonth, 1);
    const periodEnd = civilDateFromParts(endYear, endMonth, daysInCivilMonth(endYear, endMonth));
    const startDate = new Date(`${periodStart}T00:00:00Z`);

    if (startDate > to) break;
    // Include a period that OVERLAPS the range, not merely one that opens
    // inside it. Filing periods are fixed by the jurisdiction and do not move
    // to suit a registration date: registering 1 May under quarterly filing
    // means May and June activity is reported on the Apr–Jun return, so
    // dropping that quarter because it opened before the registration left real
    // taxable activity with no return to land on at all. Callers clamp the
    // reportable window inside the period (see buildFilingCalendar) so the
    // pre-registration part of a straddling period is still excluded.
    if (new Date(`${periodEnd}T00:00:00Z`) >= from) {
      periods.push({ periodStart, periodEnd });
    }
    startMonth += span;
  }
  return periods;
}

export interface NexusRegistration {
  jurisdictionId: string;
  jurisdictionName: string;
  jurisdictionCode: string;
  country: string;
  filingFrequency: FilingFrequency;
  returnFormCode: string | null;
  registrationNumber: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface FilingObligation extends FilingPeriod {
  jurisdictionId: string;
  jurisdictionName: string;
  jurisdictionCode: string;
  country: string;
  returnFormCode: string | null;
  filingFrequency: FilingFrequency;
  /**
   * The part of [periodStart, periodEnd] the registration actually covers.
   *
   * Equal to the period itself for a registration that spans it. For the
   * straddling period created by a mid-period registration or de-registration
   * they narrow to the registered days — a return that sums the whole period
   * would otherwise report activity from before the registration existed, or
   * after it ended.
   */
  reportableFrom: string;
  reportableTo: string;
}

/**
 * Expand a set of registrations into every filing obligation that OVERLAPS
 * [rangeFrom, rangeTo]. A registration contributes each period its effective
 * window touches, and each obligation carries the reportable sub-window inside
 * that period — so a mid-period registration or de-registration produces the
 * right return with the right days on it, rather than losing the straddling
 * period entirely or reporting days outside the registration. Pure.
 */
export function buildFilingCalendar(
  registrations: NexusRegistration[],
  rangeFrom: string,
  rangeTo: string,
): FilingObligation[] {
  const obligations: FilingObligation[] = [];
  for (const reg of registrations) {
    // Clamp the query range to the registration's effective window.
    const effFrom =
      reg.effectiveFrom && reg.effectiveFrom > rangeFrom ? reg.effectiveFrom : rangeFrom;
    const effTo = reg.effectiveTo && reg.effectiveTo < rangeTo ? reg.effectiveTo : rangeTo;
    if (effFrom > effTo) continue;
    for (const period of filingPeriods(reg.filingFrequency, effFrom, effTo)) {
      obligations.push({
        ...period,
        reportableFrom: period.periodStart > effFrom ? period.periodStart : effFrom,
        reportableTo: period.periodEnd < effTo ? period.periodEnd : effTo,
        jurisdictionId: reg.jurisdictionId,
        jurisdictionName: reg.jurisdictionName,
        jurisdictionCode: reg.jurisdictionCode,
        country: reg.country,
        returnFormCode: reg.returnFormCode,
        filingFrequency: reg.filingFrequency,
      });
    }
  }
  return obligations.sort(
    (a, b) =>
      a.periodEnd.localeCompare(b.periodEnd) ||
      a.jurisdictionCode.localeCompare(b.jurisdictionCode),
  );
}
