import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { addCalendarDays, isoDateOf, utcDateFromParts } from "../platform/business-date.ts";
import { add } from "../money/money.ts";
import { jurisdictionKey, payrollJurisdiction, type PayrollHoliday, type PayrollHolidayObservance, type PayrollHolidayRule, type PayrollJurisdiction } from "./packs.ts";
import { PayrollPackError } from "./payroll-error.ts";

/** Statutory holiday calendar: rule resolution, observance, overrides, and business-day arithmetic. */

export class PayrollHolidayError extends Error {}

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an ISO date as UTC midnight. Dates here are civil dates, never
 *  instants — a local-time Date would shift a holiday across a boundary for
 *  anyone west of Greenwich. */
export function at(date: string): Date {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new PayrollHolidayError(`not a date: "${date}"`);
  return parsed;
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string): number => at(date).getUTCDay();

export const isWeekend = (date: string): boolean => {
  const weekday = weekdayOf(date);
  return weekday === 0 || weekday === 6;
};

/**
 * Easter Sunday in the Gregorian calendar — the anonymous Gregorian computus.
 *
 * Good Friday and Easter Monday are statutory holidays in most of Canada and
 * they are the only ones with no expression at all against the civil calendar:
 * the date is a function of the ecclesiastical full moon. A hardcoded table of
 * Easter dates is the classic payroll defect that surfaces years later, so the
 * date is computed. Integer arithmetic only — this is a calendar, not money.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDateOf(utcDateFromParts(year, month - 1, day));
}

/** The calendar date a recurrence rule produces in a given year, before any
 *  weekend-observance shift. */
export function resolveHolidayRule(rule: PayrollHolidayRule, year: number): string {
  switch (rule.kind) {
    case "fixed":
      return isoDateOf(utcDateFromParts(year, rule.month - 1, rule.day));
    case "easter_offset":
      return addCalendarDays(easterSunday(year), rule.days);
    case "nth_weekday": {
      if (rule.nth > 0) {
        const first = utcDateFromParts(year, rule.month - 1, 1);
        const offset = (rule.weekday - first.getUTCDay() + 7) % 7;
        return isoDateOf(utcDateFromParts(year, rule.month - 1, 1 + offset + (rule.nth - 1) * 7));
      }
      // nth < 0 counts back from the end of the month: -1 is the LAST such
      // weekday (US Memorial Day is the last Monday in May, which is the
      // fourth Monday in four years out of seven and the fifth otherwise).
      const last = utcDateFromParts(year, rule.month, 0);
      const back = (last.getUTCDay() - rule.weekday + 7) % 7;
      return isoDateOf(new Date(last.getTime() - (back + (-rule.nth - 1) * 7) * DAY_MS));
    }
    case "weekday_before": {
      // The last <weekday> STRICTLY before month/day. Victoria Day is the
      // Monday preceding May 25, so when May 25 is itself a Monday the holiday
      // is May 18 — the single most commonly mis-implemented Canadian holiday.
      const anchor = utcDateFromParts(year, rule.month - 1, rule.day);
      const back = ((anchor.getUTCDay() - rule.weekday + 7) % 7) || 7;
      return isoDateOf(new Date(anchor.getTime() - back * DAY_MS));
    }
  }
}

/**
 * Move a holiday off a weekend, per the jurisdiction's declared rule.
 *
 * `taken` carries the dates already claimed by earlier holidays in the same
 * year, which is what stops Christmas on a Sunday from landing the observed
 * Christmas and Boxing Day on the same Monday. Both statutes intend two days
 * off, so the second one walks forward.
 */
function applyObservance(
  date: string,
  observance: PayrollHolidayObservance,
  taken: ReadonlySet<string>,
): string {
  if (observance === "none") return date;
  if (observance === "nearest_weekday") {
    // 5 U.S.C. 6103(b): Saturday is observed on the preceding Friday, Sunday
    // on the following Monday. It can cross a year boundary — New Year's Day
    // on a Saturday is observed on December 31 of the PREVIOUS year.
    const weekday = weekdayOf(date);
    if (weekday === 6) return addCalendarDays(date, -1);
    if (weekday === 0) return addCalendarDays(date, 1);
    return date;
  }
  // next_monday — Canada Labour Code s. 195: a general holiday falling on a
  // non-working Saturday or Sunday is observed on a working day instead.
  let candidate = date;
  for (let guard = 0; guard < 10; guard += 1) {
    if (!isWeekend(candidate) && !taken.has(candidate)) return candidate;
    candidate = addCalendarDays(candidate, 1);
  }
  throw new PayrollHolidayError(`could not place the observed date for ${date}`);
}

// ---------------------------------------------------------------------------
// Observed holidays: pack declaration + tenant election
// ---------------------------------------------------------------------------

export interface ObservedHoliday {
  jurisdiction: string;
  /** Pack key, or the tenant row id for a company holiday. */
  key: string;
  name: string;
  /** The date the recurrence rule produced, before any observance shift. */
  statutoryDate: string;
  /** The date actually observed — what everything downstream keys on. */
  date: string;
  source: "pack" | "company";
  /** True when an optional pack day was switched ON by a tenant election. */
  elected: boolean;
  /** Whether the day attracts statutory holiday pay. */
  paid: boolean;
}

/** A `payroll_holidays` row: a tenant's election on a pack day, or a company
 *  holiday the pack does not declare at all. */
export interface HolidayOverride {
  id: string;
  jurisdiction: string;
  packKey: string | null;
  name: string | null;
  ruleKind: "date" | "fixed" | "nth_weekday" | "weekday_before" | "easter_offset" | null;
  ruleMonth: number | null;
  ruleDay: number | null;
  ruleWeekday: number | null;
  ruleNth: number | null;
  ruleOffset: number | null;
  observedOn: string | null;
  observance: PayrollHolidayObservance;
  isObserved: boolean;
  isPaid: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Is the override in force for a holiday observed on `date`? Effective dating
 *  is compared against the OBSERVED DATE, never against today: re-running last
 *  year's pay run must reproduce last year's calendar. */
const overrideCovers = (override: HolidayOverride, date: string): boolean =>
  override.effectiveFrom <= date && (override.effectiveTo === null || override.effectiveTo >= date);

/** The recurrence a company-holiday row declares, in pack rule shape. */
function overrideRule(override: HolidayOverride, year: number): string | null {
  switch (override.ruleKind) {
    case "date":
      return override.observedOn ? override.observedOn.slice(0, 10) : null;
    case "fixed":
      return override.ruleMonth != null && override.ruleDay != null
        ? resolveHolidayRule({ kind: "fixed", month: override.ruleMonth, day: override.ruleDay }, year)
        : null;
    case "nth_weekday":
      return override.ruleMonth != null && override.ruleWeekday != null && override.ruleNth != null
        ? resolveHolidayRule(
            { kind: "nth_weekday", month: override.ruleMonth, weekday: override.ruleWeekday, nth: override.ruleNth },
            year,
          )
        : null;
    case "weekday_before":
      return override.ruleMonth != null && override.ruleDay != null && override.ruleWeekday != null
        ? resolveHolidayRule(
            { kind: "weekday_before", month: override.ruleMonth, day: override.ruleDay, weekday: override.ruleWeekday },
            year,
          )
        : null;
    case "easter_offset":
      return override.ruleOffset != null
        ? resolveHolidayRule({ kind: "easter_offset", days: override.ruleOffset }, year)
        : null;
    default:
      return null;
  }
}

/** Does the pack declare this day in the given year? */
const holidayExistsIn = (holiday: PayrollHoliday, year: number): boolean =>
  (holiday.from === undefined || year >= holiday.from)
  && (holiday.until === undefined || year <= holiday.until);

/**
 * The observed holiday calendar for a jurisdiction over [from, to] — PURE, so
 * a jurisdiction's calendar is verifiable against a published list with no
 * database at all.
 *
 * Years are generated one either side of the requested range because an
 * observance shift crosses year boundaries in both directions (New Year's Day
 * on a Saturday is observed on the previous December 31 in the US; Boxing Day
 * on a Sunday is observed on January's first working day federally).
 */
export function resolveObservedHolidays(input: {
  jurisdiction: string;
  from: string;
  to: string;
  overrides?: readonly HolidayOverride[];
}): ObservedHoliday[] {
  const { jurisdiction, from, to } = input;
  const declaration = payrollJurisdiction(jurisdiction);
  const overrides = (input.overrides ?? []).filter((o) => o.jurisdiction === jurisdiction);

  // A tenant cannot elect against a day the pack does not declare, and cannot
  // switch off a day the pack declares MANDATORY. Both are refusals rather
  // than ignored rows: a row that silently does nothing is configuration an
  // operator believes is in force.
  const packByKey = new Map(declaration.holidays.map((holiday) => [holiday.key, holiday]));
  for (const override of overrides) {
    if (override.packKey === null) continue;
    const declared = packByKey.get(override.packKey);
    if (!declared) {
      throw new PayrollHolidayError(
        `${jurisdiction} declares no statutory holiday "${override.packKey}" — `
        + `remove the override or add the day to the pack (declared: `
        + `${[...packByKey.keys()].join(", ")})`,
      );
    }
    if (!declared.optional && !override.isObserved) {
      throw new PayrollHolidayError(
        `${declared.name} is a mandatory statutory holiday in ${jurisdiction} and cannot be `
        + "switched off — an employer may add days to the calendar, never remove one the law requires",
      );
    }
  }

  const fromYear = Number(from.slice(0, 4)) - 1;
  const toYear = Number(to.slice(0, 4)) + 1;
  const observed: ObservedHoliday[] = [];

  for (let year = fromYear; year <= toYear; year += 1) {
    // Statutory dates first, so observance shifts resolve in calendar order
    // and the earlier holiday keeps the contested day.
    const candidates = declaration.holidays
      .filter((holiday) => holidayExistsIn(holiday, year))
      .map((holiday) => ({ holiday, statutoryDate: resolveHolidayRule(holiday.rule, year) }))
      .sort((a, b) => a.statutoryDate.localeCompare(b.statutoryDate));

    const taken = new Set<string>();
    for (const { holiday, statutoryDate } of candidates) {
      // Effective dating is against the date employees actually observe, not
      // the recurrence date. A Sunday holiday observed Monday therefore uses
      // Monday's election (and an election ending Sunday no longer applies).
      // Compute the shift before selecting the election; it is independent of
      // whether an optional day is ultimately elected, and `taken` still only
      // records days that are actually observed below.
      const date = applyObservance(statutoryDate, holiday.observance, taken);
      const election = overrides.find(
        (o) => o.packKey === holiday.key && overrideCovers(o, date),
      );
      // Optional days are OFF until elected; mandatory days are on unless an
      // election explicitly suppresses one (which the guard above forbids).
      const isObserved = election ? election.isObserved : !holiday.optional;
      if (!isObserved) continue;
      taken.add(date);
      observed.push({
        jurisdiction, key: holiday.key, name: holiday.name, statutoryDate, date,
        source: "pack",
        elected: Boolean(election?.isObserved) && Boolean(holiday.optional),
        paid: election ? election.isPaid : true,
      });
    }

    for (const override of overrides) {
      if (override.packKey !== null || !override.isObserved) continue;
      const statutoryDate = overrideRule(override, year);
      if (!statutoryDate) continue;
      // A one-off date is generated once, in its own year, not every year.
      if (override.ruleKind === "date" && statutoryDate.slice(0, 4) !== String(year)) continue;
      const date = applyObservance(statutoryDate, override.observance, taken);
      if (!overrideCovers(override, date)) continue;
      taken.add(date);
      observed.push({
        jurisdiction, key: override.id, name: override.name ?? "Company holiday",
        statutoryDate, date, source: "company", elected: true, paid: override.isPaid,
      });
    }
  }

  return observed
    .filter((holiday) => holiday.date >= from && holiday.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** The tenant's effective-dated elections and company holidays. */
export async function loadHolidayOverrides(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  jurisdiction: string,
): Promise<HolidayOverride[]> {
  const rows = (await tx.execute<{
      id: string; jurisdiction: string; pack_key: string | null; name: string | null;
      rule_kind: HolidayOverride["ruleKind"]; rule_month: number | null; rule_day: number | null;
      rule_weekday: number | null; rule_nth: number | null; rule_offset: number | null;
      observed_on: string | Date | null; observance: PayrollHolidayObservance;
      is_observed: boolean; is_paid: boolean;
      effective_from: string | Date; effective_to: string | Date | null;
    }>(sql`
    select id, jurisdiction, pack_key, name, rule_kind, rule_month, rule_day,
           rule_weekday, rule_nth, rule_offset, observed_on, observance,
           is_observed, is_paid, effective_from, effective_to
      from payroll_holidays
     where org_id = ${orgId} and jurisdiction = ${jurisdiction}
     order by effective_from, pack_key nulls last, name
  `, "objects"));
  const day = (value: string | Date | null): string | null =>
    value === null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  return rows.map((row) => ({
    id: row.id, jurisdiction: row.jurisdiction, packKey: row.pack_key, name: row.name,
    ruleKind: row.rule_kind, ruleMonth: row.rule_month, ruleDay: row.rule_day,
    ruleWeekday: row.rule_weekday, ruleNth: row.rule_nth, ruleOffset: row.rule_offset,
    observedOn: day(row.observed_on), observance: row.observance,
    isObserved: row.is_observed === true, isPaid: row.is_paid === true,
    effectiveFrom: day(row.effective_from)!, effectiveTo: day(row.effective_to),
  }));
}

/**
 * The days an organization observes in a jurisdiction over [from, to].
 *
 * THE calendar. Holiday pay, the remittance due-date shift, and any future
 * working-day arithmetic all read this one function, so an employer that
 * elects Boxing Day gets it everywhere at once and there is no second list to
 * fall out of step.
 */
export async function observedHolidays(
  orgId: string,
  jurisdiction: string,
  from: string,
  to: string,
  tx: Pick<typeof db, "execute"> = db,
): Promise<ObservedHoliday[]> {
  const overrides = await loadHolidayOverrides(tx, orgId, jurisdiction);
  return resolveObservedHolidays({ jurisdiction, from, to, overrides });
}

/** The observed dates as a set — the shape the business-day pair consumes. */
export const holidayDateSet = (holidays: readonly ObservedHoliday[]): ReadonlySet<string> =>
  new Set(holidays.map((holiday) => holiday.date));

// ---------------------------------------------------------------------------
// Statutory calendars as the payroll engine applies them
// ---------------------------------------------------------------------------

/** The fields of one payroll profile that select the statutory calendar it runs under. */
export interface PayrollHolidayProfileScope {
  country: string;
  province: string | null;
  labourJurisdiction: string | null;
}

/**
 * The distinct statutory holiday calendars the profiles fall under, keyed the
 * way payroll resolves them for each employee (`jurisdictionKey`: the labour
 * jurisdiction when one is declared, otherwise the work region). Sorted and
 * deduplicated; pure over the rows it is given.
 */
export function payrollHolidayJurisdictionKeys(profiles: readonly PayrollHolidayProfileScope[]): string[] {
  return [...new Set(profiles.map((profile) => jurisdictionKey(profile.country, profile.province, profile.labourJurisdiction)))].sort();
}

export interface StatutoryHolidayCalendar {
  jurisdiction: string;
  /** The pack's display name for the calendar. */
  name: string;
  /** The statute that lists the holidays (`PayrollJurisdiction.citation`). */
  citation: string;
  /** Observed days in the year, in date order: pack days, elected optional days and company closures. */
  holidays: ObservedHoliday[];
}

export interface StatutoryHolidayCalendarRefusal {
  jurisdiction: string;
  /** Names the calendar that cannot be read and why. */
  message: string;
}

export interface StatutoryHolidayCalendarReading {
  calendars: StatutoryHolidayCalendar[];
  refusals: StatutoryHolidayCalendarRefusal[];
}

/**
 * The observed holiday calendar of each jurisdiction for one civil year, read
 * through the resolver that holiday pay and remittance due dates use. A
 * jurisdiction the pack cannot answer for is a refusal by name, never an empty
 * calendar: an empty calendar reads as "this employer works every day".
 */
export function statutoryHolidayCalendarsFor(input: {
  jurisdictions: readonly string[];
  year: number;
  overrides: readonly HolidayOverride[];
}): StatutoryHolidayCalendarReading {
  const from = `${input.year}-01-01`;
  const to = `${input.year}-12-31`;
  const calendars: StatutoryHolidayCalendar[] = [];
  const refusals: StatutoryHolidayCalendarRefusal[] = [];
  for (const jurisdiction of input.jurisdictions) {
    let declaration: PayrollJurisdiction;
    try {
      declaration = payrollJurisdiction(jurisdiction);
    } catch (error) {
      if (!(error instanceof PayrollPackError)) throw error;
      refusals.push({ jurisdiction, message: error.message });
      continue;
    }
    if (declaration.scope !== "employment") {
      refusals.push({
        jurisdiction,
        message: `"${jurisdiction}" is not an employment calendar, so payroll applies no statutory holidays to its employees`,
      });
      continue;
    }
    if (declaration.holidays.length === 0) {
      refusals.push({
        jurisdiction,
        message: `The statutory holiday calendar for "${jurisdiction}" is not transcribed yet, so payroll cannot list its holidays`,
      });
      continue;
    }
    try {
      const holidays = resolveObservedHolidays({ jurisdiction, from, to, overrides: input.overrides });
      calendars.push({ jurisdiction, name: declaration.name, citation: declaration.citation, holidays });
    } catch (error) {
      if (!(error instanceof PayrollHolidayError)) throw error;
      refusals.push({ jurisdiction, message: error.message });
    }
  }
  return { calendars, refusals };
}

/**
 * The statutory holiday calendars the organization's active payroll profiles
 * run under, read for one year. `subsidiaryIds` limits the profiles to
 * employers the caller may see (null: unrestricted); profiles without a
 * linked employment have no employer to match, so a restricted read omits them.
 */
export async function statutoryHolidayCalendarsOf(input: {
  orgId: string;
  year: number;
  subsidiaryIds: readonly string[] | null;
  tx?: Pick<typeof db, "execute">;
}): Promise<StatutoryHolidayCalendarReading> {
  const tx = input.tx ?? db;
  if (input.subsidiaryIds !== null && input.subsidiaryIds.length === 0) return { calendars: [], refusals: [] };
  const scope = input.subsidiaryIds === null
    ? sql``
    : sql`and e.employer_subsidiary_id in (${sql.join(input.subsidiaryIds.map((id) => sql`${id}`), sql`, `)})`;
  const profiles = await tx.execute<{
    country: string; province: string | null; labourJurisdiction: string | null;
  }>(sql`
    select distinct prof.country, prof.province, prof.labour_jurisdiction as "labourJurisdiction"
      from employee_payroll_profiles prof
      left join worker_employments e on e.org_id = prof.org_id and e.id = prof.employment_id
     where prof.org_id = ${input.orgId} and prof.is_active ${scope}`, "objects");
  const jurisdictions = payrollHolidayJurisdictionKeys(profiles);
  const overrides = (await Promise.all(
    jurisdictions.map((jurisdiction) => loadHolidayOverrides(tx, input.orgId, jurisdiction)),
  )).flat();
  return statutoryHolidayCalendarsFor({ jurisdictions, year: input.year, overrides });
}

// ---------------------------------------------------------------------------
// Business days
// ---------------------------------------------------------------------------

/**
 * A working day: not a Saturday, not a Sunday, not an observed holiday.
 *
 * Pure over an explicit calendar. The caller decides WHICH calendar — an
 * employer's ESA calendar and the CRA's own office calendar are genuinely
 * different lists (the CRA recognizes Easter Monday and the Civic Holiday,
 * which no province's employment standards act does), and using one where the
 * other belongs is how a remittance lands a day late.
 */
export function isBusinessDay(date: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

/** The first business day on or after `date`. */
export function nextBusinessDay(date: string, holidays: ReadonlySet<string>): string {
  let candidate = date;
  for (let guard = 0; guard <= 30; guard += 1) {
    if (isBusinessDay(candidate, holidays)) return candidate;
    candidate = addCalendarDays(candidate, 1);
  }
  throw new PayrollHolidayError(`no business day within 30 days of ${date}`);
}

/**
 * `days` business days after (or, negative, before) `date`.
 *
 * The start date is never counted, whether or not it is itself a business day:
 * "the third working day after the 7th" counts three working days beginning
 * with the first one that follows the 7th. `days = 0` returns the date
 * unchanged rather than snapping to a business day — use `nextBusinessDay`
 * when that is what is meant, so the two intents stay distinguishable.
 */
export function addBusinessDays(
  date: string,
  days: number,
  holidays: ReadonlySet<string>,
): string {
  if (!Number.isInteger(days)) throw new PayrollHolidayError("business days must be an integer");
  if (days === 0) return date;
  const step = days > 0 ? 1 : -1;
  let remaining = Math.abs(days);
  let candidate = date;
  for (let guard = 0; remaining > 0; guard += 1) {
    if (guard > 400) throw new PayrollHolidayError(`could not add ${days} business days to ${date}`);
    candidate = addCalendarDays(candidate, step);
    if (isBusinessDay(candidate, holidays)) remaining -= 1;
  }
  return candidate;
}

/** Business days in [from, to] inclusive. */
export function businessDaysBetween(
  from: string,
  to: string,
  holidays: ReadonlySet<string>,
): number {
  let count = 0;
  for (let cursor = from; cursor <= to; cursor = addCalendarDays(cursor, 1)) {
    if (isBusinessDay(cursor, holidays)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Statutory holiday pay
// ---------------------------------------------------------------------------
