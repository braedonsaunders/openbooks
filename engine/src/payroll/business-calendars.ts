import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { addCalendarDays, calendarDaysBetween, parseIsoDate } from "../platform/civil-date.ts";
import { observedHolidays } from "./holidays.ts";
import { employmentJurisdictionsOf, payrollJurisdictionDeclared } from "./pack-jurisdictions.ts";
import { PayrollJurisdictionError } from "./payroll-error.ts";

/**
 * Organization business calendar: which weekday starts the week, which days
 * are the weekend, and which dates are holidays.
 *
 * This resolver lives beside the statutory holiday data it reads. Statutory
 * and company closures come from the one combined pack reader
 * (`observedHolidays`, which unions a jurisdiction's mandatory pack days,
 * elected optional days and company closures from payroll_holidays) — week
 * maths anywhere else must come through here rather than re-deriving pack
 * dates. (The organization module cannot host it — payroll already depends on
 * organization, so that edge would be a module cycle.)
 *
 * Scope precedence: a subsidiary's own calendar where one covers the date,
 * otherwise the org-wide row. Overlapping active windows in one scope are
 * refused by the storage constraint, so at most one row governs a date. A
 * governing row that names another country's holidays than the subsidiary's
 * own is refused rather than applied: the product once filed one state's
 * certificate against another state's employee, and the wrong table priced
 * the levy.
 *
 * Statutory days resolve to ONE employment jurisdiction per version: the
 * subsidiary's country plus region, the way payroll resolves an employment
 * jurisdiction. A union over every sub-jurisdiction would mark days
 * non-business no local employer observes, and no company closure could
 * remove them again. The region is the qualifier after the dash (ON in
 * CA-ON): required wherever the country keeps a separate calendar per
 * region, with FEDERAL naming the federal calendar where one sits beside
 * regional ones, and unneeded where the pack declares exactly one
 * employment calendar. A jurisdiction whose calendar nobody has transcribed
 * refuses at resolution, by name, at save and at read alike.
 *
 * No calendar configured is a named refusal, never an ISO guess. The product
 * has no single documented default to inherit: the cash forecast grids on
 * Sunday while the banking trend and the ISO week helpers grid on Monday, so
 * either guess silently re-dates some other surface's weeks.
 */

export class BusinessCalendarMissingError extends Error {
  readonly code = "business_calendar_missing";
  constructor(subject: string, onDate: string) {
    super(
      `No business calendar covers ${subject} on ${onDate} — set one up in Setup → Company → Business calendars`,
    );
    this.name = "BusinessCalendarMissingError";
  }
}

/** Refusal raised when a statutory jurisdiction cannot be resolved by name. */
export class StatutoryCoverageError extends Error {
  readonly code = "statutory_coverage_missing";
  constructor(message: string) {
    super(message);
    this.name = "StatutoryCoverageError";
  }
}

/** Refusal raised when a stored calendar version cannot be read as a weekend. */
export class BusinessCalendarUnreadableError extends Error {
  readonly code = "business_calendar_unreadable";
  constructor() {
    super(
      "A business calendar version stores an unreadable weekend — re-save the version in Setup → Company → Business calendars",
    );
    this.name = "BusinessCalendarUnreadableError";
  }
}

/** Refusal raised when the governing row names another country's holidays. */
export class SubsidiaryCalendarMismatchError extends Error {
  readonly code = "subsidiary_calendar_mismatch";
  constructor(subject: string, subsidiaryCountry: string, calendarCountry: string) {
    super(
      `The calendar governing ${subject} names ${calendarCountry} holidays but the subsidiary is domiciled in ${subsidiaryCountry} — create a calendar for the subsidiary or correct the holiday country in Setup → Company → Business calendars`,
    );
    this.name = "SubsidiaryCalendarMismatchError";
  }
}

/** ISO weekday of a civil date: 1 = Monday through 7 = Sunday. */
export function isoWeekdayOf(date: string): number {
  return ((parseIsoDate(date).getUTCDay() + 6) % 7) + 1;
}

/**
 * The employment jurisdiction whose holidays a calendar version observes,
 * from the version's country plus region — the same `${country}-${region}`
 * construction payroll uses for employments. Refuses by name with the remedy
 * instead of guessing a neighbouring calendar or an empty set.
 *
 * The region is the qualifier after the dash (ON in CA-ON). A bare country
 * never resolves to a federal calendar on its own: where a federal calendar
 * sits beside regional ones the region must say so explicitly (FEDERAL), and
 * where the pack declares exactly one employment calendar the bare country
 * resolves to it.
 */
export function statutoryJurisdictionKey(countryCode: string, region: string | null): string {
  const country = countryCode.trim().toUpperCase();
  const qualifier = (region ?? "").trim().toUpperCase();
  let declarations: ReturnType<typeof employmentJurisdictionsOf>;
  try {
    declarations = employmentJurisdictionsOf(country);
  } catch (error) {
    if (error instanceof PayrollJurisdictionError) {
      throw new StatutoryCoverageError(
        `No transcribed employment holiday calendar for "${country}" — save the calendar without a holiday country for weekends only; company closures for ${country} are not available yet`,
      );
    }
    throw error;
  }
  if (declarations.length === 0) {
    throw new StatutoryCoverageError(
      `The ${country} payroll pack declares no employment holiday calendar yet — save the calendar without a holiday country for weekends only; company closures for ${country} are not available yet`,
    );
  }
  // Qualifiers name choices, never keys: the picker offers ON, the stored
  // region reads ON, and only this construction builds CA-ON. Listing keys
  // here once taught an operator to type CA-ON, which built CA-CA-ON.
  const qualifierOf = (key: string): string =>
    (key === country ? "FEDERAL" : key.startsWith(`${country}-`) ? key.slice(country.length + 1) : key);
  const qualifiers = declarations.map((declaration) => qualifierOf(declaration.key)).join(", ");
  const transcribed = (key: string): string => {
    const declaration = declarations.find((candidate) => candidate.key === key);
    if (!declaration || declaration.holidays.length === 0) {
      throw new StatutoryCoverageError(
        `"${key}"'s statutory holiday calendar is not transcribed yet — record company closures for ${key} in Setup → Payroll → Holidays`,
      );
    }
    return key;
  };
  if (!qualifier) {
    if (declarations.length === 1) return transcribed(declarations[0]!.key);
    throw new StatutoryCoverageError(
      `"${country}" keeps a separate holiday calendar per region — set the holiday region to one of ${qualifiers}`,
    );
  }
  const requested = qualifier === "FEDERAL" ? country : `${country}-${qualifier}`;
  if (declarations.some((declaration) => declaration.key === requested)) return transcribed(requested);
  if (payrollJurisdictionDeclared(requested)) {
    throw new StatutoryCoverageError(
      `"${requested}" is not an employment calendar — it moves remittance due dates and governs no working days. `
      + `Choose one of the employment calendars the pack declares: ${qualifiers}`,
    );
  }
  throw new StatutoryCoverageError(
    `No payroll pack declares the employment holiday calendar "${country}-${qualifier}" — set the holiday region to one of ${qualifiers}`,
  );
}

// The row shape is inline: drizzle's execute constrains its row type to a
// record, which a named alias does not satisfy. The domain shape below
// derives from this query so the two cannot drift.
/** Load the versions overlapping a window, subsidiary scope first. */
async function loadVersions(
  tx: typeof db,
  orgId: string,
  subsidiaryId: string | null,
  from: string,
  to: string,
) {
  const rows = (await tx.execute<{
    id: string;
    subsidiary_id: string | null;
    week_starts_on: number;
    weekend_days: unknown;
    holiday_country: string | null;
    holiday_region: string | null;
    effective_from: string | Date;
    effective_to: string | Date | null;
  }>(sql`
    select id, subsidiary_id, week_starts_on, weekend_days, holiday_country, holiday_region,
           effective_from, effective_to
      from org_business_calendars
     where org_id = ${orgId}
       and is_active
       and effective_from <= ${to}::date
       and (effective_to is null or effective_to >= ${from}::date)
       and (subsidiary_id is null or subsidiary_id = ${subsidiaryId})
     order by effective_from
  `)).rows;
  return rows;
}

type BusinessCalendarRow = Awaited<ReturnType<typeof loadVersions>>[number];

const dayString = (value: string | Date): string =>
  (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

function parseWeekendDays(raw: unknown): ReadonlySet<number> {
  if (!Array.isArray(raw)) throw new BusinessCalendarUnreadableError();
  const days = raw.map(Number);
  if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new BusinessCalendarUnreadableError();
  }
  return new Set(days);
}

export interface BusinessCalendar {
  /** ISO weekday starting the week: 1 = Monday through 7 = Sunday. */
  weekStartsOn: number;
  /** ISO weekdays forming the weekend. */
  weekendDays: ReadonlySet<number>;
  /** The ISO country whose statutory holidays apply, if one is configured. */
  holidayCountry: string | null;
  /** The region selecting the employment jurisdiction, if one is configured. */
  holidayRegion: string | null;
  /** The resolved pack jurisdiction key; null while no country is configured. */
  jurisdiction: string | null;
  /** The selection date's version window. Predicates answer the week around the selection date and throw outside it. */
  effectiveFrom: string;
  effectiveTo: string | null;
  isHoliday(date: string): boolean;
  isBusinessDay(date: string): boolean;
}

/** The version governing one date: the subsidiary's own row where one covers it, else the org-wide row. */
function governingVersion(versions: readonly BusinessCalendarRow[], date: string): BusinessCalendarRow | null {
  const covering = versions.filter((row) =>
    dayString(row.effective_from) <= date && (row.effective_to === null || dayString(row.effective_to) >= date));
  const scoped = covering.filter((row) => row.subsidiary_id !== null);
  const fallback = covering.filter((row) => row.subsidiary_id === null);
  const pick = (candidates: readonly BusinessCalendarRow[]): BusinessCalendarRow | null => {
    let best: BusinessCalendarRow | null = null;
    for (const row of candidates) {
      if (!best || dayString(row.effective_from) > dayString(best.effective_from)) best = row;
    }
    return best;
  };
  return pick(scoped) ?? pick(fallback);
}

async function holidaysFor(
  tx: typeof db,
  orgId: string,
  version: BusinessCalendarRow,
  from: string,
  to: string,
): Promise<{ jurisdiction: string | null; holidays: ReadonlySet<string> }> {
  if (!version.holiday_country) return { jurisdiction: null, holidays: new Set() };
  const jurisdiction = statutoryJurisdictionKey(version.holiday_country, version.holiday_region);
  // Observance moves a declaration's observed date off the declaration date,
  // so the resolution window pads the query window: a one-day query must
  // still see the declaration it observes. Membership answers stay exact —
  // only the considered declarations widen.
  const observed = await observedHolidays(
    orgId, jurisdiction, addCalendarDays(from, -7), addCalendarDays(to, 7), tx,
  );
  return { jurisdiction, holidays: new Set(observed.map((holiday) => holiday.date)) };
}

interface CalendarSubject {
  /** How refusals name the governed party: a name, never a UUID. */
  text: string;
  subsidiaryCountry: string | null;
}

async function calendarSubject(
  tx: typeof db,
  orgId: string,
  subsidiaryId: string | null,
): Promise<CalendarSubject> {
  if (subsidiaryId) {
    const facts = (await tx.execute<{ name: string; country: string }>(sql`
      select name, country from subsidiaries where id = ${subsidiaryId} and org_id = ${orgId}
    `)).rows[0];
    if (facts) {
      return { text: `subsidiary "${facts.name}"`, subsidiaryCountry: facts.country };
    }
    return { text: `subsidiary ${subsidiaryId}`, subsidiaryCountry: null };
  }
  const org = (await tx.execute<{ name: string }>(sql`
    select name from orgs where id = ${orgId}
  `)).rows[0];
  return { text: org ? `the organization "${org.name}"` : `the organization ${orgId}`, subsidiaryCountry: null };
}

interface ResolvedDay {
  weekStartsOn: number;
  weekendDays: ReadonlySet<number>;
  holidayCountry: string | null;
  holidayRegion: string | null;
  jurisdiction: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isHoliday: boolean;
  isBusinessDay: boolean;
}

/**
 * Every date in a span answered from the version governing that date. The
 * strict range refuses the first uncovered date eagerly; the lenient
 * single-date view records the gap and refuses it only when queried, so one
 * uncovered day elsewhere in the week never fails the selection date.
 */
async function resolveRange(
  tx: typeof db,
  orgId: string,
  subsidiaryId: string | null,
  subject: CalendarSubject,
  from: string,
  to: string,
  strict: boolean,
): Promise<Map<string, ResolvedDay | null>> {
  const versions = await loadVersions(tx, orgId, subsidiaryId, from, to);
  const byVersion = new Map<string, { weekendDays: ReadonlySet<number>; jurisdiction: string | null; holidays: ReadonlySet<string> }>();
  const days = new Map<string, ResolvedDay | null>();
  const count = calendarDaysBetween(from, to);
  for (let offset = 0; offset <= count; offset += 1) {
    const date = addCalendarDays(from, offset);
    const version = governingVersion(versions, date);
    if (!version) {
      if (strict) throw new BusinessCalendarMissingError(subject.text, date);
      days.set(date, null);
      continue;
    }
    if (subject.subsidiaryCountry && version.holiday_country && version.holiday_country !== subject.subsidiaryCountry) {
      throw new SubsidiaryCalendarMismatchError(subject.text, subject.subsidiaryCountry, version.holiday_country);
    }
    let resolved = byVersion.get(version.id);
    if (!resolved) {
      resolved = {
        weekendDays: parseWeekendDays(version.weekend_days),
        ...await holidaysFor(tx, orgId, version, from, to),
      };
      byVersion.set(version.id, resolved);
    }
    const isHoliday = resolved.holidays.has(date);
    days.set(date, {
      weekStartsOn: Number(version.week_starts_on),
      weekendDays: resolved.weekendDays,
      holidayCountry: version.holiday_country,
      holidayRegion: version.holiday_region,
      jurisdiction: resolved.jurisdiction,
      effectiveFrom: dayString(version.effective_from),
      effectiveTo: version.effective_to === null ? null : dayString(version.effective_to),
      isHoliday,
      isBusinessDay: !resolved.weekendDays.has(isoWeekdayOf(date)) && !isHoliday,
    });
  }
  return days;
}

/**
 * Assert a date lies in the answered span before answering it. The span the
 * caller resolved binds before any calendar fact: an out-of-span weekend
 * date must refuse, never answer from the wrong version.
 */
function dayAnswer(
  days: ReadonlyMap<string, ResolvedDay | null>,
  subjectText: string,
  from: string,
  to: string,
  date: string,
): ResolvedDay {
  parseIsoDate(date);
  if (date < from || date > to) {
    throw new RangeError(
      `${date} is outside the answered span ${from}..${to} — resolve wider spans per date with businessCalendarOver`,
    );
  }
  const answer = days.get(date);
  if (!answer) throw new BusinessCalendarMissingError(subjectText, date);
  return answer;
}

/**
 * The calendar governing a subsidiary (or the organization) on a date.
 * Refuses when none is configured. Predicates answer the week around that
 * date, each date from the version governing it, so an override starting
 * later in the week is never answered from the row it replaces — wider
 * spans resolve per date with businessCalendarOver.
 */
export async function businessCalendarFor(
  orgId: string,
  subsidiaryId: string | null,
  onDate: string,
  tx: typeof db = db,
): Promise<BusinessCalendar> {
  parseIsoDate(onDate);
  const subject = await calendarSubject(tx, orgId, subsidiaryId);
  const from = addCalendarDays(onDate, -7);
  const to = addCalendarDays(onDate, 7);
  const days = await resolveRange(tx, orgId, subsidiaryId, subject, from, to, false);
  const anchor = days.get(onDate);
  if (!anchor) throw new BusinessCalendarMissingError(subject.text, onDate);
  const isHoliday = (date: string): boolean => dayAnswer(days, subject.text, from, to, date).isHoliday;
  const isBusinessDay = (date: string): boolean => dayAnswer(days, subject.text, from, to, date).isBusinessDay;
  return {
    weekStartsOn: anchor.weekStartsOn,
    weekendDays: anchor.weekendDays,
    holidayCountry: anchor.holidayCountry,
    holidayRegion: anchor.holidayRegion,
    jurisdiction: anchor.jurisdiction,
    effectiveFrom: anchor.effectiveFrom,
    effectiveTo: anchor.effectiveTo,
    isHoliday,
    isBusinessDay,
  };
}

export interface BusinessCalendarDay {
  date: string;
  weekStartsOn: number;
  weekendDays: ReadonlySet<number>;
  holidayCountry: string | null;
  holidayRegion: string | null;
  jurisdiction: string | null;
  isHoliday: boolean;
  isBusinessDay: boolean;
}

export interface BusinessCalendarRange {
  from: string;
  to: string;
  /** Every date in [from, to], oldest first. */
  dates(): string[];
  /** The per-date answer, resolved from the version governing that date. */
  day(date: string): BusinessCalendarDay;
}

/**
 * Calendars over a span: each date answers from the version governing it,
 * so a forecast crossing a version change, an ended subsidiary override, or
 * a new closure never silently computes under one row. A date no version
 * covers refuses eagerly with the Setup remedy.
 */
export async function businessCalendarOver(
  orgId: string,
  subsidiaryId: string | null,
  from: string,
  to: string,
  tx: typeof db = db,
): Promise<BusinessCalendarRange> {
  parseIsoDate(from);
  parseIsoDate(to);
  if (to < from) throw new RangeError("calendar range ends before it starts");
  const subject = await calendarSubject(tx, orgId, subsidiaryId);
  const days = await resolveRange(tx, orgId, subsidiaryId, subject, from, to, true);
  return {
    from,
    to,
    dates: () => [...days.keys()],
    day: (date: string): BusinessCalendarDay => {
      const answer = dayAnswer(days, subject.text, from, to, date);
      return { date, ...answer };
    },
  };
}
