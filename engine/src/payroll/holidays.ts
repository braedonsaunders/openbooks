import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { resolveStoredEmployerFact } from "./employer-fact-store.ts";
import { MB_CONSTRUCTION_HOLIDAY } from "./canada/employment-standards.ts";
import { utcDateFromParts } from "../platform/business-date.ts";
import { add, cmp, fromUnits, mul, mulDecimal, mulPercent, mulRatio, prorateDays, roundDiv, roundMoney, sum, toUnits } from "../money/money.ts";
import {
  employmentJurisdictionsOf,
  holidayPayLookbackBasis,
  jurisdictionKey,
  payrollJurisdiction,
  payrollJurisdictionDeclared,
  type PayrollHoliday,
  type PayrollHolidayDayCounting,
  type PayrollHolidayObservance,
  type PayrollHolidayPayEdition,
  type PayrollHolidayPayRule,
  type PayrollHolidayRule,
  type PayrollWorkTriggeredHoliday,
} from "./packs.ts";
import {
  describeWorkSchedule,
  isScheduledOn,
  normalWorkdayHours,
  resolveWorkSchedule,
  scheduledHoursPerWeek,
  type ResolvedWorkSchedule,
} from "./work-schedules.ts";

/**
 * Statutory holidays: the calendar, and the pay the calendar owes.
 *
 * Three things in this file, in dependency order.
 *
 * 1. THE CALENDAR. Which days a jurisdiction observes is a fact declared by
 *    the country pack (`PayrollJurisdiction.holidays`); which of the OPTIONAL
 *    ones an employer observes, and what purely internal closures it adds, is
 *    tenant configuration (`payroll_holidays`). `observedHolidays` is the one
 *    place those two are combined, and everything else downstream — holiday
 *    pay, remittance due dates, any future working-day arithmetic — reads it
 *    rather than re-deriving dates of its own.
 *
 * 2. THE BUSINESS-DAY PAIR. `isBusinessDay` / `addBusinessDays`, pure over a
 *    set of observed dates. A remittance deadline counted in "working days"
 *    is meaningless without them, which is exactly why
 *    `payroll-remittance.ts` refused to compute the accelerated schedules
 *    until this existed.
 *
 * 3. STATUTORY HOLIDAY PAY. A day's pay derived from a LOOKBACK over prior
 *    earnings. Every jurisdiction words this differently — Ontario divides
 *    four weeks of regular wages plus vacation pay by 20, British Columbia
 *    divides thirty days of wages by the days worked or on which wages were
 *    earned, Saskatchewan takes five per cent of four weeks — so the formula is
 *    declared per jurisdiction in the pack and this file only executes it. A
 *    jurisdiction whose rule nobody has transcribed REFUSES, loudly and by
 *    name; it never falls through to a neighbouring province's formula and
 *    never pays zero, because a silent zero is indistinguishable from a correct
 *    calculation for an employee who earned nothing.
 *
 *    Three things about that formula are DECLARED and were once constants, and
 *    each of them is a number in somebody's bank account:
 *
 *      - WHICH DAYS COUNT (`PayrollHolidayDayCounting`). "Worked", "worked or
 *        earned wages" and "was entitled to be paid" are three sentences in
 *        three Acts, not three phrasings of one. See
 *        `countHolidayQualifyingDays`.
 *      - WHERE THE WINDOW ENDS (`PayrollHolidayPayRule.lookbackEnds`). "The
 *        four weeks preceding the holiday" and "the four weeks preceding the
 *        WEEK in which the holiday occurs" differ by up to six days of
 *        earnings. See `lookbackWindowEnd`.
 *      - WHEN THE FORMULA WAS THE LAW (`PayrollHolidayPayEdition`). Employment
 *        standards Acts are amended, and a repealed one still governs the
 *        periods it was in force for. See `statutoryHolidayPayRule`, which is
 *        the same treatment `engine/src/payroll/tax-years.ts` gives a pack's
 *        statutory tables.
 *
 * All money arithmetic goes through engine/src/money/money.ts. Never floats: a
 * lookback divided by 20 in binary floating point is off by a cent often
 * enough to be noticed, and it is noticed by the employee.
 */

export class PayrollHolidayError extends Error {}

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an ISO date as UTC midnight. Dates here are civil dates, never
 *  instants — a local-time Date would shift a holiday across a boundary for
 *  anyone west of Greenwich. */
function at(date: string): Date {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new PayrollHolidayError(`not a date: "${date}"`);
  return parsed;
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);

export const shiftDays = (date: string, days: number): string =>
  iso(new Date(at(date).getTime() + days * DAY_MS));

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((at(to).getTime() - at(from).getTime()) / DAY_MS);

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
  return iso(utcDateFromParts(year, month - 1, day));
}

/** The calendar date a recurrence rule produces in a given year, before any
 *  weekend-observance shift. */
export function resolveHolidayRule(rule: PayrollHolidayRule, year: number): string {
  switch (rule.kind) {
    case "fixed":
      return iso(utcDateFromParts(year, rule.month - 1, rule.day));
    case "easter_offset":
      return shiftDays(easterSunday(year), rule.days);
    case "nth_weekday": {
      if (rule.nth > 0) {
        const first = utcDateFromParts(year, rule.month - 1, 1);
        const offset = (rule.weekday - first.getUTCDay() + 7) % 7;
        return iso(utcDateFromParts(year, rule.month - 1, 1 + offset + (rule.nth - 1) * 7));
      }
      // nth < 0 counts back from the end of the month: -1 is the LAST such
      // weekday (US Memorial Day is the last Monday in May, which is the
      // fourth Monday in four years out of seven and the fifth otherwise).
      const last = utcDateFromParts(year, rule.month, 0);
      const back = (last.getUTCDay() - rule.weekday + 7) % 7;
      return iso(new Date(last.getTime() - (back + (-rule.nth - 1) * 7) * DAY_MS));
    }
    case "weekday_before": {
      // The last <weekday> STRICTLY before month/day. Victoria Day is the
      // Monday preceding May 25, so when May 25 is itself a Monday the holiday
      // is May 18 — the single most commonly mis-implemented Canadian holiday.
      const anchor = utcDateFromParts(year, rule.month - 1, rule.day);
      const back = ((anchor.getUTCDay() - rule.weekday + 7) % 7) || 7;
      return iso(new Date(anchor.getTime() - back * DAY_MS));
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
    if (weekday === 6) return shiftDays(date, -1);
    if (weekday === 0) return shiftDays(date, 1);
    return date;
  }
  // next_monday — Canada Labour Code s. 195: a general holiday falling on a
  // non-working Saturday or Sunday is observed on a working day instead.
  let candidate = date;
  for (let guard = 0; guard < 10; guard += 1) {
    if (!isWeekend(candidate) && !taken.has(candidate)) return candidate;
    candidate = shiftDays(candidate, 1);
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
  `));
  const day = (value: string | Date | null): string | null =>
    value === null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  return rows.rows.map((row) => ({
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
    candidate = shiftDays(candidate, 1);
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
    candidate = shiftDays(candidate, step);
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
  for (let cursor = from; cursor <= to; cursor = shiftDays(cursor, 1)) {
    if (isBusinessDay(cursor, holidays)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Statutory holiday pay
// ---------------------------------------------------------------------------

/**
 * The jurisdiction's holiday-pay rule AS IT STOOD ON `onDate`, or `null` where
 * the jurisdiction genuinely mandates none (the United States).
 *
 * Three distinct answers, and no two of them may collapse:
 *
 *  - a RULE — the edition in force on the date;
 *  - `null` — the law requires nothing;
 *  - a THROW — either nobody has transcribed the jurisdiction at all (out of
 *    `payrollJurisdiction`), or nobody has transcribed the statute that
 *    governed this particular date. The second is the Prince Edward Island
 *    case: SPEI 2024 c 66 came into force on 2026-06-30 and replaced a regular
 *    day's pay with a percentage, so a June 2026 PEI period is governed by a
 *    repealed Act this pack does not carry. Computing it on the new formula
 *    would be wrong money nobody would ever see; refusing names the Act.
 *
 * `onDate` is the WORK DATE — the holiday's own date — never today. Re-running
 * a 2019 period must reproduce the 2019 formula, exactly as re-running it
 * reproduces the 2019 calendar and the 2019 withholding tables.
 */
export function statutoryHolidayPayRule(
  jurisdiction: string,
  onDate: string,
): PayrollHolidayPayRule | null {
  const declaration = payrollJurisdiction(jurisdiction);
  const editions = declaration.holidayPay;
  if (editions === null) return null;
  if (editions.length === 0) {
    throw new PayrollHolidayError(
      `${declaration.name}: the public-holiday calendar and statutory holiday-pay rule under ${declaration.citation} are not transcribed — transcribe both in the jurisdiction pack before calculating payroll`,
    );
  }
  const date = onDate.slice(0, 10);
  // Latest in-force edition wins, so a correction issued with a later
  // `effectiveFrom` supersedes rather than ties. `effectiveFrom: null` sorts
  // first because it is the unbounded-before edition.
  let best: PayrollHolidayPayEdition | null = null;
  for (const edition of editions) {
    if (edition.effectiveFrom !== null && edition.effectiveFrom > date) continue;
    if (edition.effectiveTo !== null && edition.effectiveTo < date) continue;
    if (
      best === null
      || (best.effectiveFrom ?? "") < (edition.effectiveFrom ?? "")
    ) best = edition;
  }
  if (best === null) {
    const known = editions
      .map((edition) =>
        `${edition.effectiveFrom ?? "the beginning"} – ${edition.effectiveTo ?? "current"}`)
      .join("; ");
    throw new PayrollHolidayError(
      `${declaration.name} declares no statutory holiday-pay formula in force on ${date} — `
      + `the statute governing that date has not been transcribed (transcribed: ${known}). `
      + "Transcribe the edition in engine/src/payroll/canada/employment-standards.ts, or run "
      + "the period against a date the pack covers. This calculation will not apply a formula "
      + "that was not the law at the time",
    );
  }
  return best.rule;
}

/** Earnings inside a lookback window, split by what the statutes include. */
export interface HolidayLookbackEarnings {
  /** Regular wages — everything that is not one of the categories below. */
  regular: string;
  overtime: string;
  vacationPay: string;
  /** Statutory holiday pay already paid inside the window. */
  holidayPay: string;
}

export const emptyLookbackEarnings = (): HolidayLookbackEarnings => ({
  regular: "0", overtime: "0", vacationPay: "0", holidayPay: "0",
});

export interface HolidayPayContext {
  /** Named in every refusal, so an operator knows which stub stopped. */
  employee: string;
  holiday: ObservedHoliday;
  /** Earnings over the rule's own lookback window. */
  earnings: HolidayLookbackEarnings;
  /**
   * The denominator of an `average_day` rule: how many days of the PAY window
   * satisfy that basis's own `counting` predicate. Not always "days worked" —
   * British Columbia divides by the days the employee worked OR EARNED WAGES
   * (ESA s. 45(1)), Alberta and New Brunswick by days worked.
   * `countHolidayQualifyingDays` is what produces it.
   */
  daysWorked: number;
  /** Approved hours actually worked in the pay basis window. */
  hoursWorkedInLookback?: string;
  /**
   * The same count over the QUALIFYING window, when the rule declares one that
   * is a different length from the pay window (BC: 15 of the 30 days before) —
   * and, in Nova Scotia, under a different predicate as well (s. 42(1)'s
   * "entitled to receive pay" against the averaging arm's "worked").
   */
  daysWorkedInQualifyingWindow?: number;
  /** Calendar days between the hire date and the holiday; null when unknown. */
  employmentDays: number | null;
  /** The employee is paid in whole or in part on commission. */
  paidOnCommission?: boolean;
  /** Complete weeks of continuous employment, for the commission windows. */
  employmentWeeks?: number | null;
  /** Earnings over the commission lookback, when the rule declares one. */
  commissionEarnings?: HolidayLookbackEarnings;
  /** Hours actually worked ON the holiday. */
  hoursWorked: string;
  /** Regular hourly rate, for the premium and for a `normal_day` basis. */
  hourlyRate: string;
  /**
   * The employee's normal work pattern on the day of the holiday
   * (engine/src/payroll/work-schedules.ts), or null when none is recorded.
   *
   * Only a `normal_day` basis reads it, and only that basis is affected by its
   * absence — every lookback rule computes from committed stubs exactly as it
   * always did, whether or not a schedule exists. `null` and "not supplied"
   * both mean UNKNOWN, and a rule that needs it refuses by name rather than
   * assuming a working day of any length.
   */
  schedule?: ResolvedWorkSchedule | null;
  /**
   * The employer asserting the last-and-first test was failed — the employee
   * was absent WITHOUT consent on the last scheduled shift before or the first
   * after. Only ever supplied deliberately; see `computeStatutoryHolidayPay`.
   */
  absentWithoutConsent?: boolean;
  /**
   * The employer asserting the employee worked under an averaging agreement in
   * the qualifying window (BC ESA s. 37). Read only where the rule declares
   * `averagingAgreementAlternative`; everywhere else it is ignored. Never
   * inferred from hours or schedules — an agreement is a legal fact, and a
   * pattern that looks like one is not one.
   */
  averagingAgreement?: boolean;
}

export interface HolidayPayResult {
  holidayKey: string;
  holidayName: string;
  date: string;
  qualified: boolean;
  /** Present exactly when `qualified` is false. */
  disqualifiedReason?: string;
  /** The day's pay. */
  holidayPay: string;
  /** The ADDITIONAL amount owed for hours worked on the day — see below. */
  premiumPay: string;
  /** Plain-language derivation, carried onto the stub line for the audit
   *  trail: an employee who queries their holiday pay gets the arithmetic. */
  basis: string;
}

/** The statute's own words for a day-counting predicate, for the stub trace and
 *  for a refusal an employee will read. */
export function describeDayCounting(counting: PayrollHolidayDayCounting): string {
  switch (counting) {
    case "worked": return "worked";
    case "worked_or_earned_wages": return "worked or earned wages";
    case "entitled_to_pay": return "was paid, or entitled to be paid";
  }
}

/** Exact `amount ÷ divisor`, rounded once, in BigInt from end to end. */
function divideExact(amount: string, divisor: number): string {
  if (!Number.isInteger(divisor) || divisor <= 0) {
    throw new PayrollHolidayError(`cannot divide holiday pay by ${divisor}`);
  }
  // roundDiv is money.ts's half-away-from-zero integer division; scaling by
  // 100 and back rounds exactly once, at cents.
  return fromUnits(roundDiv(toUnits(amount) * 100n, BigInt(divisor) * 100n * 100n) * 100n);
}

/** The lookback base a rule's inclusions produce. */
export function holidayPayBase(
  earnings: HolidayLookbackEarnings,
  include: PayrollHolidayPayRule["include"],
): string {
  return sum([
    earnings.regular,
    include.overtime ? earnings.overtime : "0",
    include.vacationPay ? earnings.vacationPay : "0",
    include.holidayPay ? earnings.holidayPay : "0",
  ]);
}

/**
 * A day's statutory holiday pay and the premium for working it — PURE, so
 * every jurisdiction's arithmetic is verifiable against the statute's own
 * worked example with no database.
 *
 * On the premium: the returned `premiumPay` is the amount owed IN ADDITION to
 * the regular wages the hours already earn. Time worked on the holiday is
 * already on the stub at 1.0× from the timesheet, so a jurisdiction that
 * requires time and a half is owed the remaining 0.5×. Emitting the full 1.5×
 * here would pay the hours twice. Quebec, which requires the indemnity plus
 * ordinary wages and no premium at all, declares a multiplier of 1 and
 * therefore correctly produces nothing.
 *
 * On the last-and-first test: the engine never INFERS it. The statutes
 * disqualify an employee absent without the employer's CONSENT, and consent is
 * not a fact any timesheet records — an absence in the data is as likely to be
 * approved leave. Inferring it would deny statutory pay on a guess, so the
 * denial has to be asserted (`absentWithoutConsent`), and the rule's
 * declaration of the test is what makes that field meaningful rather than a
 * free-text note.
 */
export function computeStatutoryHolidayPay(
  rule: PayrollHolidayPayRule,
  context: HolidayPayContext,
): HolidayPayResult {
  const shell = {
    holidayKey: context.holiday.key,
    holidayName: context.holiday.name,
    date: context.holiday.date,
  };
  const deny = (reason: string): HolidayPayResult => ({
    ...shell, qualified: false, disqualifiedReason: reason,
    holidayPay: "0", premiumPay: "0", basis: reason,
  });

  if (!context.holiday.paid) {
    return deny("the day is configured as an unpaid closure");
  }

  const { qualifying } = rule;
  /**
   * Set when the day-count arm fails but the rule's own averaging-agreement
   * alternative carries the employee. Recorded here so the derivation below
   * names the arm that qualified them — a stub that says "15 of 30" for an
   * employee with 10 counted days is a lie the audit trail must not tell.
   */
  let averagingAgreementApplied = false;
  if (
    qualifying.minEmploymentDays !== undefined
    && !(qualifying.minEmploymentDaysWhenUnworked && cmp(context.hoursWorked, "0") > 0)
  ) {
    if (context.employmentDays === null) {
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} needs a hire date to test the `
        + `${qualifying.minEmploymentDays}-day qualifying period — set it on the employee record`,
      );
    }
    if (context.employmentDays < qualifying.minEmploymentDays) {
      return deny(
        `employed ${context.employmentDays} of the ${qualifying.minEmploymentDays} calendar days `
        + "the jurisdiction requires before the holiday",
      );
    }
  }
  if (qualifying.minDaysWorkedInWindow) {
    const { days, ofDays, counting } = qualifying.minDaysWorkedInWindow;
    const worked = context.daysWorkedInQualifyingWindow ?? context.daysWorked;
    if (worked < days) {
      // A statute's own alternative to the count (BC ESA s. 44(b): an averaging
      // agreement in the window) qualifies despite the short count — but only
      // where the rule declares it AND the caller asserts the agreement. An
      // unasserted agreement keeps the denial: the count is what the engine can
      // see, and the agreement is what it cannot.
      if (qualifying.averagingAgreementAlternative === true && context.averagingAgreement === true) {
        averagingAgreementApplied = true;
      } else {
        // The reason quotes the jurisdiction's OWN sentence. An employee refused
        // in Nova Scotia was not "not working enough"; they were not entitled to
        // pay on enough days, which is a different fact and a different appeal.
        return deny(
          `${describeDayCounting(counting)} on ${worked} of the ${ofDays} days before the `
          + `holiday; ${days} are required`,
        );
      }
    }
  }
  if (qualifying.lastAndFirstScheduledShift && context.absentWithoutConsent === true) {
    return deny(
      "absent without the employer's consent on the last scheduled shift before or the first after",
    );
  }

  // --- the day's pay -------------------------------------------------------
  let holidayPay: string | null = null;
  let basis = "";
  /** Set when a `normal_day` rule fell through to the statute's own
   *  varying-hours arm, so the derivation says WHY it took the average. */
  let irregularBecause: string | null = null;

  // A `normal_day` basis pays the wages the employee would have earned on the
  // day itself, from their work schedule (engine/src/payroll/work-schedules.ts) — not
  // from any quantity of prior earnings. It is tried first, and where the
  // statute's own condition for it fails ("where the hours of work or wages
  // vary") it falls through to the lookback arm the same statute declares.
  if (rule.basis.kind === "normal_day") {
    const schedule = context.schedule ?? null;
    if (!schedule) {
      // The one refusal this basis exists to make. There is no default working
      // day: eight hours, or a fifth of forty, is a number indistinguishable on
      // the stub from a correct one and wrong in the bank. Note that "their
      // hours vary" is a RECORDABLE answer, not a missing one — which is why
      // this refusal is always actionable.
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} pays the wages of the employee's normal `
        + `working day, and no work schedule is in force on ${context.holiday.date} — record the `
        + "hours and days they are normally scheduled to work, or record that their hours vary. "
        + "This calculation will not assume a working day it has not been told about",
      );
    }
    const perWeek = scheduledHoursPerWeek(schedule);
    const belowStandard = rule.basis.minWeeklyHours !== undefined
      && (perWeek === null || cmp(perWeek, String(rule.basis.minWeeklyHours)) < 0);
    const normalHours = normalWorkdayHours(schedule);
    if (belowStandard) {
      irregularBecause = `the employee works ${perWeek ?? "irregular"} hours a week, less than the `
        + `${rule.basis.minWeeklyHours} the jurisdiction treats as standard`;
    } else if (normalHours === null) {
      irregularBecause = `the employee's hours vary (${describeWorkSchedule(schedule)})`;
    } else if (context.paidOnCommission === true) {
      irregularBecause = "the employee is paid on commission, so their daily wages vary";
    } else if (cmp(context.hourlyRate, "0") <= 0) {
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} pays the wages of their normal working day `
        + "but no regular rate of pay is recorded — set the employee's pay rate before calculating",
      );
    } else {
      // ONE normal working day, not the calendar day the holiday landed on: a
      // holiday falling on the employee's day off is a substitute day off with
      // pay, so the same day's wages are owed either way.
      holidayPay = roundMoney(mul(context.hourlyRate, normalHours), 2);
      basis = `${normalHours} hours — one normal working day (${describeWorkSchedule(schedule)}) `
        + `— × ${context.hourlyRate} regular rate`;
    }
  }

  // The lookback arm: the rule's own basis, or a `normal_day` rule's declared
  // fallback for an employee with no normal day.
  const basisRule = holidayPayLookbackBasis(rule.basis);
  const commission = basisRule.kind === "fixed_divisor" ? basisRule.commission : undefined;
  const useCommission = Boolean(
    commission
    && context.paidOnCommission
    && (context.employmentWeeks ?? 0) >= commission.minWeeksEmployed,
  );

  if (holidayPay !== null) {
    // Already settled by the normal-day arm.
  } else if (basisRule.kind === "fixed_divisor" && useCommission && commission) {
    const earnings = context.commissionEarnings ?? context.earnings;
    const base = holidayPayBase(earnings, rule.include);
    holidayPay = divideExact(base, commission.divisor);
    basis = `${base} earned in the ${commission.lookbackWeeks} weeks before the holiday `
      + `÷ ${commission.divisor} (commission basis)`;
  } else if (basisRule.kind === "fixed_divisor") {
    const base = holidayPayBase(context.earnings, rule.include);
    holidayPay = divideExact(base, basisRule.divisor);
    basis = `${base} earned in the ${basisRule.lookbackWeeks} weeks before the holiday `
      + `÷ ${basisRule.divisor}`;
  } else if (basisRule.kind === "percent_of_earnings") {
    const base = holidayPayBase(context.earnings, rule.include);
    holidayPay = mulPercent(base, basisRule.percent, 2);
    basis = `${basisRule.percent}% of ${base} earned in the `
      + `${basisRule.lookbackWeeks} weeks before the holiday`;
  } else {
    const base = holidayPayBase(context.earnings, rule.include);
    const window = basisRule.kind === "average_day" && basisRule.lookbackDays !== undefined
      ? `${basisRule.lookbackDays} days`
      : `${basisRule.lookbackWeeks ?? 4} weeks`;
    const counted = basisRule.kind === "average_hours_day"
      ? "worked"
      : describeDayCounting(basisRule.counting);
    if (context.daysWorked <= 0) {
      // An average-day jurisdiction with a zero denominator is undefined, not
      // zero. Paying nothing here would be a real entitlement quietly lost, so
      // it stops the run and names the employee.
      if (
        basisRule.kind === "average_hours_day"
          ? cmp(context.hoursWorkedInLookback ?? "0", "0") === 0 && cmp(base, "0") === 0
          : cmp(base, "0") === 0
      ) {
        return deny(`no wages were earned in the ${window} before the holiday`);
      }
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} pays an average day's wage but no days `
        + `on which the employee ${counted} are recorded in the ${window} before it, while `
        + `${base} was earned — the average is undefined; correct the timesheet before `
        + "calculating",
      );
    }
    if (basisRule.kind === "average_hours_day") {
      if (context.hoursWorkedInLookback === undefined) {
        throw new PayrollHolidayError(
          `${context.employee}: ${context.holiday.name} needs approved hours worked in the `
          + `${window} before the holiday to calculate the statutory average — correct the `
          + "approved timesheets before calculating",
        );
      }
      if (cmp(context.hourlyRate, "0") <= 0) {
        throw new PayrollHolidayError(
          `${context.employee}: ${context.holiday.name} uses the current hourly rate for its `
          + "average-hours holiday pay, but no current regular rate is recorded — set the "
          + "employee's pay rate before calculating",
        );
      }
      holidayPay = roundMoney(
        mulRatio(
          context.hourlyRate,
          toUnits(context.hoursWorkedInLookback),
          BigInt(context.daysWorked) * 10_000n,
        ),
        2,
      );
      basis = `${context.hourlyRate} current hourly rate × ${context.hoursWorkedInLookback} hours `
        + `worked in the ${window} before the holiday ÷ ${context.daysWorked} days worked`;
    } else {
      holidayPay = divideExact(base, context.daysWorked);
      basis = `${base} earned in the ${window} before the holiday ÷ ${context.daysWorked} `
        + `days ${counted}`;
    }
  }
  if (irregularBecause !== null) basis = `${irregularBecause}, so ${basis}`;
  if (averagingAgreementApplied) {
    basis = `${basis} — qualified under the averaging-agreement alternative, not the day count`;
  }

  // --- premium for hours actually worked -----------------------------------
  let premiumPay = "0";
  if (cmp(context.hoursWorked, "0") > 0 && cmp(context.hourlyRate, "0") > 0) {
    const { premium } = rule;
    const cap = premium.overtimeAfterHours;
    const hoursAtBase = cap !== undefined && cmp(context.hoursWorked, String(cap)) > 0
      ? String(cap)
      : context.hoursWorked;
    const hoursAbove = cap !== undefined && cmp(context.hoursWorked, String(cap)) > 0
      ? fromUnits(toUnits(context.hoursWorked) - toUnits(String(cap)))
      : "0";
    // (multiplier − 1): the hours are already paid at 1.0× by the timesheet.
    const uplift = (multiplier: string) => fromUnits(toUnits(multiplier) - toUnits("1"));
    premiumPay = roundMoney(
      add(
        mulDecimal(mul(context.hourlyRate, hoursAtBase), uplift(premium.multiplier)),
        cmp(hoursAbove, "0") > 0 && premium.overtimeMultiplier
          ? mulDecimal(mul(context.hourlyRate, hoursAbove), uplift(premium.overtimeMultiplier))
          : "0",
      ),
      2,
    );
    if (!premium.plusHolidayPay) holidayPay = "0";
  }

  return { ...shell, qualified: true, holidayPay, premiumPay, basis };
}

/** Compute a separate statutory payment whose trigger is working a dated event. */
export function computeWorkTriggeredHolidayPay(
  rule: PayrollHolidayPayRule,
  event: PayrollWorkTriggeredHoliday,
  context: HolidayPayContext,
): HolidayPayResult {
  if (cmp(context.hoursWorked, "0") <= 0) {
    throw new PayrollHolidayError(`${context.employee}: ${event.name} payment requires hours worked on the date`);
  }
  const result = computeStatutoryHolidayPay({
    ...rule,
    qualifying: {
      ...rule.qualifying,
      ...event.qualifying,
    },
  }, { ...context, hoursWorked: "0", absentWithoutConsent: false });
  if (!result.qualified || event.payment.kind === "alternate_paid_day") return result;
  if (!context.schedule) {
    throw new PayrollHolidayError(
      `${context.employee}: ${event.name} needs the employee's normal daily hours to apply its half-day work minimum — record the work schedule`,
    );
  }
  const normalHours = normalWorkdayHours(context.schedule);
  if (normalHours === null) {
    throw new PayrollHolidayError(
      `${context.employee}: ${event.name} needs a regular workday to apply its half-day work minimum — record the normal schedule or resolve the statutory hours`,
    );
  }
  const halfNormalDay = mulRatio(normalHours, 1n, 2n);
  const overtimeHours = cmp(context.hoursWorked, halfNormalDay) >= 0
    ? context.hoursWorked : halfNormalDay;
  const requiredOvertimeWages = mulDecimal(
    mul(context.hourlyRate, overtimeHours), event.payment.overtimeRate,
  );
  const ordinaryWagesAlreadyPaid = mul(context.hourlyRate, context.hoursWorked);
  const premiumPay = cmp(requiredOvertimeWages, ordinaryWagesAlreadyPaid) > 0
    ? roundMoney(add(requiredOvertimeWages, fromUnits(-toUnits(ordinaryWagesAlreadyPaid))), 2)
    : "0";
  return {
    ...result,
    premiumPay,
    basis: `${result.basis}; work-triggered overtime minimum ${event.payment.overtimeRate}× ${overtimeHours} hours (the greater of hours worked and half a normal day)`,
  };
}

// ---------------------------------------------------------------------------
// Pay-run input: phase 2 of the pipeline contract
// ---------------------------------------------------------------------------

/** An earning line shaped for `calculateStub`'s line set (phase 2, beside
 *  derived earnings), so holiday pay is in gross before the statutory pass. */
export interface StatutoryHolidayEarningLine {
  componentId: string;
  kind: "earning";
  description: string;
  hours?: string;
  rate?: string;
  amount: string;
  sequence: number;
  /** Provenance for the stub trace. */
  holidayKey: string;
  holidayDate: string;
  basis: string;
}

export interface StatutoryHolidayPayInput {
  orgId: string;
  /** Paying legal employer for effective-dated employer facts. */
  subsidiaryId?: string | null;
  country?: string;
  employeePartyId: string;
  employeeName: string;
  /** 'CA-ON', 'CA', 'US-TX' — from `jurisdictionKey(country, province)`. */
  jurisdiction: string;
  periodStart: string;
  periodEnd: string;
  /** pay_components.id for stat_holiday and stat_holiday_premium. */
  holidayComponentId: string;
  premiumComponentId: string;
  /** The pay run being calculated, excluded from its own lookback. */
  excludeDocumentId: string;
  hourlyRate: string;
  /**
   * Eligibility facts supplied by the payroll caller. These are deliberately
   * explicit rather than inferred from a timesheet: commission pay changes the
   * statutory lookback/divisor, while an unconsented absence is a legal fact
   * that an attendance gap cannot establish.
   */
  paidOnCommission?: boolean;
  absentWithoutConsent?: boolean;
  /**
   * The presented statutory occupation class (the profile column's raw
   * value). Undefined means the caller never presented the question — probes
   * and tests get the uncapped rule. Null means presented but unrecorded,
   * which a rule with a weekly cap refuses by name. The run always presents
   * it, straight off the employment's profile row.
   */
  occupationClass?: string | null;
  /**
   * The stub's earning lines so far (before this holiday's lines), for the
   * weekly cap's same-week slice. Undefined callers get the committed-stubs
   * slice only; the run always passes its lines.
   */
  currentEarningLines?: readonly {
    amount: string;
    kind: string;
    nonPeriodic?: boolean | null;
  }[];
  /**
   * Whether the employee worked under an averaging agreement in the qualifying
   * window (BC ESA s. 37). Read only where the rule declares the
   * `averagingAgreementAlternative`; no stored producer supplies it yet, so a
   * run that needs the alternative asserts it here per employee.
   */
  averagingAgreement?: boolean;
  /** Audited complete-evidence assertions by holiday occurrence key. */
  entitledDayAttestations?: Readonly<Record<string, number>>;
  /**
   * Manitoba construction class (CCSM c E110, s. 30). The class takes the
   * construction 4% instead of the general per-holiday rule; an omitted
   * value runs the general rule, never a guess in either direction.
   */
  constructionEmployee?: boolean;
  /**
   * The pay's regular wages for the construction 4% base, supplied by the
   * caller from the period's earning lines. Required when the Manitoba
   * construction path runs; never inferred from a lookback.
   */
  periodRegularEarnings?: string;
}

/**
 * Employee facts that affect a jurisdiction's statutory entitlement. An
 * omitted property means the employer has not supplied the authoritative
 * evidence; the database-backed resolver refuses the affected Ontario/Quebec
 * calculation rather than guessing from a pay component or timesheet gap.
 */
export interface StatutoryHolidayEligibilityFacts {
  paidOnCommission?: boolean;
  absentWithoutConsent?: boolean;
  entitledDayAttestations?: Readonly<Record<string, number>>;
  /**
   * Manitoba construction class (CCSM c E110, s. 30): the asserted class
   * takes the construction 4% instead of the general per-holiday rule.
   * Omitted runs the general rule.
   */
  constructionEmployee?: boolean;
}

/**
 * Manitoba construction employees (CCSM c E110, s. 30, MB_CONSTRUCTION_HOLIDAY):
 * 4% of the pay's regular wages on every pay plus 1.5× the regular rate for
 * approved hours worked on a general holiday — INSTEAD of the general
 * per-holiday rule, which never runs for this class. No qualifying tests, no
 * lookback, no commission/absence assertions: the statute asks none. The 4%
 * is wages like the general holiday pay it replaces. The premium reuses
 * approved time-on-day so only recorded holiday work is paid; a zero or
 * unknown hourly rate pays no premium, mirroring the general path.
 */
async function resolveMbConstructionHolidayPay(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  holidays: ObservedHoliday[],
): Promise<StatutoryHolidayEarningLine[]> {
  if (input.periodRegularEarnings === undefined) {
    throw new PayrollHolidayError(
      `${input.employeeName}: Manitoba construction holiday pay needs the period's regular wages — `
      + "the caller must supply periodRegularEarnings from the period's earning lines",
    );
  }
  const lines: StatutoryHolidayEarningLine[] = [];
  const fourPercent = mulPercent(input.periodRegularEarnings, MB_CONSTRUCTION_HOLIDAY.percent, 2);
  lines.push({
    componentId: input.holidayComponentId, kind: "earning",
    description: "Manitoba construction general holiday pay (4% of regular wages, s. 30)",
    amount: fourPercent, sequence: 45,
    holidayKey: "mb-construction-holiday-pay", holidayDate: input.periodEnd,
    basis: `4% of current-period regular wages (${MB_CONSTRUCTION_HOLIDAY.citation})`,
  });
  let sequence = 46;
  for (const holiday of holidays) {
    const worked = await hoursOn(tx, input, holiday.date);
    if (cmp(worked, "0") > 0 && cmp(input.hourlyRate, "0") > 0) {
      const uplift = fromUnits(toUnits(MB_CONSTRUCTION_HOLIDAY.premiumMultiplier) - toUnits("1"));
      const premium = roundMoney(mulDecimal(mul(input.hourlyRate, worked), uplift), 2);
      if (cmp(premium, "0") !== 0) {
        lines.push({
          componentId: input.premiumComponentId, kind: "earning",
          description: `${holiday.name} — premium for hours worked (construction)`,
          amount: premium, sequence: sequence++,
          holidayKey: holiday.key, holidayDate: holiday.date,
          basis: `${MB_CONSTRUCTION_HOLIDAY.premiumMultiplier}× the regular rate for hours worked on the holiday (${MB_CONSTRUCTION_HOLIDAY.citation})`,
        });
      }
    }
  }
  return lines;
}

/**
 * Statutory holiday pay for every observed paid holiday landing inside the pay
 * period, as pay-run INPUT lines.
 *
 * Returns an empty array — never throws — when the jurisdiction mandates no
 * holiday pay. Throws, naming the jurisdiction, when the pack does not declare
 * it at all.
 *
 * The lookback reads committed stubs and only attributes boundary earnings
 * when their dated lines establish which side of the window earned them.
 */
/**
 * An occupation weekly cap (New Brunswick ESA s. 21(2)): a route
 * salesperson's pay for an UNWORKED holiday shall not push the week's
 * earnings above their average weekly wages for the preceding four weeks.
 *
 * Both terms are day-count pro-rata allocations — the engine's established
 * method for straddling periods, applied here to the Sunday week (the Act
 * states no employer election) and to the trailing 28 days. "Wages" is read
 * unqualified: every earning bucket counts, unlike the s. 21(1) base that
 * excludes overtime, vacation, and holiday pay. The current stub's lines are
 * sliced to the week∩period overlap; non-periodic (retro) lines are excluded
 * because they belong to other periods, not this week. The result floors at
 * zero: a week already above the average earns no holiday pay, it never earns
 * negative pay.
 *
 * Skips (returns the computed pay) where the rule declares no cap, where the
 * caller never presented the occupation question, where the occupation is not
 * the capped one, or where the holiday was worked. Refuses by name where the
 * question was presented but the class is unrecorded.
 */
async function applyOccupationWeeklyCap(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    employeePartyId: string;
    excludeDocumentId: string;
    employeeName: string;
    rule: PayrollHolidayPayRule;
    holidayDate: string;
    occupationClass: string | null | undefined;
    hoursWorked: string;
    computedPay: string;
    periodStart: string;
    periodEnd: string;
    currentLines: readonly {
      amount: string;
      kind: string;
      nonPeriodic?: boolean | null;
    }[] | undefined;
  },
): Promise<{ pay: string; note: string | null }> {
  const unchanged = { pay: args.computedPay, note: null };
  const cap = args.rule.weeklyCap;
  if (!cap || args.occupationClass === undefined) return unchanged;
  if (cmp(args.hoursWorked, "0") > 0) return unchanged;
  if (args.occupationClass === null) {
    throw new PayrollHolidayError(
      `${args.employeeName} may be priced under an occupation weekly cap, but their statutory `
      + "occupation class is not recorded — the run will not guess whether the cap applies. "
      + "Record it on the employee's payroll profile, then recalculate",
    );
  }
  if (!cap.values.includes(args.occupationClass)) {
    throw new PayrollHolidayError(
      `${args.employeeName} carries unrecognized occupation class "${args.occupationClass}" — `
      + `record one of ${cap.values.join(", ")} on the employee's payroll profile, then recalculate`,
    );
  }
  if (args.occupationClass !== cap.cappedValue) return unchanged;

  const stubInput = {
    orgId: args.orgId,
    employeePartyId: args.employeePartyId,
    excludeDocumentId: args.excludeDocumentId,
  };
  const intoWeek = weekdayOf(args.holidayDate) % 7;
  const weekStart = shiftDays(args.holidayDate, -intoWeek);
  const weekEnd = shiftDays(weekStart, 6);
  const total = (earnings: HolidayLookbackEarnings): string =>
    sum([earnings.regular, earnings.overtime, earnings.vacationPay, earnings.holidayPay]);
  const average = fromUnits(
    roundDiv(
      toUnits(total(await lookbackEarnings(tx, stubInput, {
        from: shiftDays(weekStart, -(cap.lookbackWeeks * 7)),
        to: shiftDays(weekStart, -1),
      }))),
      BigInt(cap.lookbackWeeks),
    ),
  );
  const committed = total(await lookbackEarnings(tx, stubInput, { from: weekStart, to: weekEnd }));
  const periodDays = daysBetween(args.periodStart, args.periodEnd) + 1;
  const overlapFrom = args.periodStart > weekStart ? args.periodStart : weekStart;
  const overlapTo = args.periodEnd < weekEnd ? args.periodEnd : weekEnd;
  const overlapDays = daysBetween(overlapFrom, overlapTo) + 1;
  const currentTotal = sum(
    (args.currentLines ?? [])
      .filter((line) => line.kind === "earning" && !line.nonPeriodic)
      .map((line) => line.amount),
  );
  const weekBase = add(committed, prorateDays(currentTotal, Math.max(0, overlapDays), periodDays));
  const allowed = cmp(fromUnits(toUnits(average) - toUnits(weekBase)), "0") < 0
    ? "0"
    : fromUnits(toUnits(average) - toUnits(weekBase));
  if (cmp(args.computedPay, allowed) <= 0) return unchanged;
  return {
    pay: allowed,
    note: `occupation weekly cap: week earnings ${weekBase} against a ${average} average — paid ${allowed} of ${args.computedPay}`,
  };
}

export async function resolveStatutoryHolidayPay(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
): Promise<StatutoryHolidayEarningLine[]> {
  const jurisdiction = payrollJurisdiction(input.jurisdiction);
  // Whether a jurisdiction mandates holiday pay AT ALL is date-independent, so
  // it is asked once and before anything is loaded. WHICH formula is in force
  // is a per-holiday question and is asked below, against the holiday's date.
  const workTriggeredHolidays = jurisdiction.workTriggeredHolidays ?? [];
  if (jurisdiction.holidayPay === null && workTriggeredHolidays.length === 0) return [];
  if (jurisdiction.holidayPay !== null && jurisdiction.holidayPay.length === 0) {
    statutoryHolidayPayRule(input.jurisdiction, input.periodStart);
  }

  const overrides = await loadHolidayOverrides(tx, input.orgId, input.jurisdiction);
  const observedIn = (from: string, to: string) =>
    resolveObservedHolidays({ jurisdiction: input.jurisdiction, from, to, overrides });

  const holidays = jurisdiction.holidayPay === null ? [] : observedIn(input.periodStart, input.periodEnd)
    .filter((holiday) => holiday.paid);
  // Manitoba construction (CCSM c E110, s. 30) replaces the whole general
  // per-holiday rule for the asserted class — including on a pay with no
  // holiday in it, where the 4% still accrues, so this dispatch precedes
  // the no-holiday early return. Only the asserted class takes this path;
  // everyone else runs the general rule below.
  if (input.jurisdiction === "CA-MB" && input.constructionEmployee === true) {
    return resolveMbConstructionHolidayPay(tx, input, holidays);
  }
  if (holidays.length === 0 && workTriggeredHolidays.length === 0) return [];

  const hire = (await tx.execute<{ hired_on: string | Date | null }>(sql`
    select hired_on from employee_roles
     where org_id = ${input.orgId} and party_id = ${input.employeePartyId}
     order by hired_on nulls last limit 1
  `));
  const hiredOn = hire.rows[0]?.hired_on
    ? String(hire.rows[0].hired_on instanceof Date
        ? hire.rows[0].hired_on.toISOString()
        : hire.rows[0].hired_on).slice(0, 10)
    : null;

  const lines: StatutoryHolidayEarningLine[] = [];
  let sequence = 45;
  for (const holiday of holidays) {
    // The edition of the statute IN FORCE ON THE HOLIDAY — never today's, and
    // never the current one applied backwards. Refuses by name where the
    // governing statute has not been transcribed.
    const rule = statutoryHolidayPayRule(input.jurisdiction, holiday.date)!;
    let employerWeekStartsOn: string | null = null;
    if (rule.lookbackEnds.kind === "week_before" && rule.lookbackEnds.employerWeekStartsOnFact) {
      if (!input.country || !input.subsidiaryId) {
        throw new PayrollHolidayError(
          `${input.employeeName}: ${holiday.name} needs the paying legal employer to resolve its selected work week — `
          + "assign the run to its legal employer, then set the work-week start in Payroll Setup → Employer facts",
        );
      }
      employerWeekStartsOn = await resolveStoredEmployerFact({
        tx, orgId: input.orgId, subsidiaryId: input.subsidiaryId, country: input.country,
        factKey: rule.lookbackEnds.employerWeekStartsOnFact, asOf: holiday.date,
      });
    }
    const selectedWeekStartsOn = employerWeekStartsOn === null ? undefined : Number(employerWeekStartsOn);
    const window = lookbackWindow(rule, holiday.date, selectedWeekStartsOn);
    const earnings = await lookbackEarnings(tx, input, window);
    // The QUALIFYING window is day-based in every statute that declares one
    // ("the 30 calendar days preceding the statutory holiday"; "30 days worked
    // in the preceding 12 months"), including the jurisdictions whose PAY
    // window ends at the preceding week. The two boundaries are separate
    // sentences and are kept separate.
    const qualifyingWindow = rule.qualifying.minDaysWorkedInWindow
      ? {
          from: shiftDays(holiday.date, -rule.qualifying.minDaysWorkedInWindow.ofDays),
          to: shiftDays(holiday.date, -1),
        }
      : window;
    const lookbackBasis = holidayPayLookbackBasis(rule.basis);
    // A commission window changes the lookback's shape, and the
    // last-and-first scheduled-shift test is an entitlement condition
    // wherever the rule declares it. Neither fact is inferable from earnings
    // or a missing time entry, so a real pay run must provide an explicit
    // assertion and stops when it cannot. Both demands follow the rule's own
    // declaration, never a list of jurisdiction keys — gating them on two
    // keys let every other declaring province pay the holiday without ever
    // asking the question its statute requires.
    if (
      lookbackBasis.kind === "fixed_divisor"
      && lookbackBasis.commission
      && input.paidOnCommission === undefined
    ) {
      throw new PayrollHolidayError(
        `${input.employeeName}: ${holiday.name} needs an explicit commission-pay status `
        + "for the statutory holiday calculation — record whether the employee is paid "
        + "in whole or in part on commission",
      );
    }
    if (
      rule.qualifying.lastAndFirstScheduledShift
      && input.absentWithoutConsent === undefined
    ) {
      throw new PayrollHolidayError(
        `${input.employeeName}: ${holiday.name} needs an explicit last-and-first-shift `
        + "absence assertion for the statutory holiday calculation — record whether "
        + "the employee was absent without the employer's consent",
      );
    }
    const commissionWindow = lookbackBasis.kind === "fixed_divisor" && lookbackBasis.commission
      ? commissionWindowOf(rule, holiday.date, lookbackBasis.commission.lookbackWeeks, selectedWeekStartsOn)
      : null;

    // Which days count is the rule's own declaration, twice over: the
    // denominator of an average-day basis and the numerator of a days-in-window
    // qualifier are separate sentences in separate sections, and British
    // Columbia is the jurisdiction where they happen to be the same one.
    const payCounting: PayrollHolidayDayCounting =
      lookbackBasis.kind === "average_day" ? lookbackBasis.counting : "worked";
    const qualifyingCounting = rule.qualifying.minDaysWorkedInWindow?.counting ?? payCounting;
    /** True only where a statute counts more than the days actually worked. */
    const needsPaidDays = payCounting !== "worked" || qualifyingCounting !== "worked";

    // Resolved as at the HOLIDAY's date, never today: an employee who moved
    // from full-time to part-time in March must still have January's holiday
    // paid on January's pattern. Loaded only where a declaration actually reads
    // it — a `normal_day` basis, or a day count broader than "worked" — so a
    // jurisdiction that divides a lookback by days worked does no work here.
    const schedule = rule.basis.kind === "normal_day" || needsPaidDays
      ? await resolveWorkSchedule(tx, input.orgId, input.employeePartyId, holiday.date)
      : null;

    const evidenceWindow = {
      from: window.from < qualifyingWindow.from ? window.from : qualifyingWindow.from,
      to: window.to > qualifyingWindow.to ? window.to : qualifyingWindow.to,
    };
    const evidence = await loadHolidayDayEvidence(
      tx, input, evidenceWindow,
      needsPaidDays ? observedIn(evidenceWindow.from, evidenceWindow.to) : [],
      needsPaidDays,
    );
    const daysWorked = countHolidayQualifyingDays({
      employee: input.employeeName, window, counting: payCounting, evidence, schedule,
    });
    const daysWorkedInQualifyingWindow = rule.qualifying.minDaysWorkedInWindow
      ? countHolidayQualifyingDays({
          employee: input.employeeName, window: qualifyingWindow,
          counting: qualifyingCounting, evidence, schedule,
        })
      : daysWorked;
    const dayQualifier = rule.qualifying.minDaysWorkedInWindow;
    if (dayQualifier?.counting === "entitled_to_pay"
        && daysWorkedInQualifyingWindow < dayQualifier.days) {
      const occurrence = `${holiday.key}|${holiday.date}`;
      const attestedCount = input.entitledDayAttestations?.[occurrence];
      if (attestedCount !== daysWorkedInQualifyingWindow) {
        throw new PayrollHolidayError(
          `${input.employeeName}: ${holiday.name} (${holiday.date}) has ${daysWorkedInQualifyingWindow} evidenced days entitled to pay in the preceding ${dayQualifier.ofDays}; approve or correct owed paid-leave days, then attest that this run's entitlement-day evidence is complete for this holiday before calculating`,
        );
      }
    }

    const hoursWorked = await hoursOn(tx, input, holiday.date);
    const result = computeStatutoryHolidayPay(rule, {
      employee: input.employeeName,
      holiday,
      earnings,
      daysWorked,
      hoursWorkedInLookback: lookbackBasis.kind === "average_hours_day"
        ? await hoursWorkedInLookback(tx, input, window)
        : undefined,
      daysWorkedInQualifyingWindow,
      employmentDays: hiredOn ? daysBetween(hiredOn, holiday.date) : null,
      employmentWeeks: hiredOn ? Math.floor(daysBetween(hiredOn, holiday.date) / 7) : null,
      commissionEarnings: commissionWindow
        ? await lookbackEarnings(tx, input, commissionWindow)
        : undefined,
      paidOnCommission: input.paidOnCommission,
      absentWithoutConsent: input.absentWithoutConsent,
      averagingAgreement: input.averagingAgreement,
      hoursWorked,
      hourlyRate: input.hourlyRate,
      schedule,
    });
    if (!result.qualified) continue;

    // An occupation weekly cap (New Brunswick s. 21(2)) clamps the PRICED day
    // after the basis answers — never inside the pure arithmetic, which knows
    // no database. The trace names the clamp so the stub line explains itself.
    const capped = await applyOccupationWeeklyCap(tx, {
      orgId: input.orgId,
      employeePartyId: input.employeePartyId,
      excludeDocumentId: input.excludeDocumentId,
      employeeName: input.employeeName,
      rule,
      holidayDate: holiday.date,
      occupationClass: input.occupationClass,
      hoursWorked,
      computedPay: result.holidayPay,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currentLines: input.currentEarningLines,
    });
    if (cmp(capped.pay, "0") !== 0) {
      lines.push({
        componentId: input.holidayComponentId, kind: "earning",
        description: `${holiday.name} — statutory holiday pay`,
        amount: capped.pay, sequence: sequence++,
        holidayKey: holiday.key, holidayDate: holiday.date,
        basis: capped.note ? `${result.basis}; ${capped.note}` : result.basis,
      });
    }
    if (cmp(result.premiumPay, "0") !== 0) {
      lines.push({
        componentId: input.premiumComponentId, kind: "earning",
        description: `${holiday.name} — premium for hours worked`,
        amount: result.premiumPay, sequence: sequence++,
        holidayKey: holiday.key, holidayDate: holiday.date,
        basis: `${rule.premium.multiplier}× the regular rate for hours worked on the holiday`,
      });
    }
  }
  for (const event of workTriggeredHolidays) {
    const firstYear = Number(input.periodStart.slice(0, 4));
    const lastYear = Number(input.periodEnd.slice(0, 4));
    for (let year = firstYear; year <= lastYear; year += 1) {
      const date = resolveHolidayRule(event.rule, year);
      if (date < input.periodStart || date > input.periodEnd
        || (event.effectiveFrom !== null && date < event.effectiveFrom)
        || (event.effectiveTo !== null && date > event.effectiveTo)) continue;
      const hoursWorked = await hoursOn(tx, input, date);
      if (cmp(hoursWorked, "0") <= 0) continue;
      if (event.employerExemptionFact) {
        if (!input.country || !input.subsidiaryId) {
          throw new PayrollHolidayError(
            `${input.employeeName}: ${event.name} needs the legal employer's exemption status — assign the payroll run to its legal employer and record the exemption in Payroll Setup → Employer facts`,
          );
        }
        const exempt = await resolveStoredEmployerFact({
          tx, orgId: input.orgId, subsidiaryId: input.subsidiaryId,
          country: input.country, factKey: event.employerExemptionFact, asOf: date,
        });
        if (exempt === null) {
          throw new PayrollHolidayError(
            `${input.employeeName}: ${event.name} needs the employer's statutory exemption status — record it in Payroll Setup → Employer facts`,
          );
        }
        if (exempt === "true") continue;
      }
      const rule = statutoryHolidayPayRule(input.jurisdiction, date);
      if (!rule) {
        throw new PayrollHolidayError(
          `${input.employeeName}: ${event.name} has no holiday-pay formula in force on ${date}`,
        );
      }
      const holiday: ObservedHoliday = {
        jurisdiction: input.jurisdiction, key: event.key, name: event.name,
        statutoryDate: date, date, source: "pack", elected: false, paid: true,
      };
      const window = lookbackWindow(rule, date);
      const earnings = await lookbackEarnings(tx, input, window);
      const schedule = await resolveWorkSchedule(tx, input.orgId, input.employeePartyId, date);
      const result = computeWorkTriggeredHolidayPay(rule, event, {
        employee: input.employeeName, holiday, earnings, daysWorked: 0,
        employmentDays: hiredOn ? daysBetween(hiredOn, date) : null,
        hoursWorked, hourlyRate: input.hourlyRate, schedule,
      });
      if (!result.qualified) continue;
      if (cmp(result.holidayPay, "0") !== 0) {
        lines.push({
          componentId: input.holidayComponentId, kind: "earning",
          description: `${event.name} — statutory holiday pay`,
          amount: result.holidayPay, sequence: sequence++,
          holidayKey: event.key, holidayDate: date, basis: result.basis,
        });
      }
      if (cmp(result.premiumPay, "0") !== 0) {
        lines.push({
          componentId: input.premiumComponentId, kind: "earning",
          description: `${event.name} — work-triggered overtime minimum`,
          amount: result.premiumPay, sequence: sequence++,
          holidayKey: event.key, holidayDate: date, basis: result.basis,
        });
      }
    }
  }
  return lines;
}

/**
 * The last day of a rule's lookback window — the ONE place the two statutory
 * wordings are told apart.
 *
 * `day_before` is "the four weeks immediately preceding the general holiday":
 * the window runs up to the day before the holiday itself.
 *
 * `week_before` is "the four-week period immediately preceding the WEEK in
 * which the general holiday occurs": the window stops at the end of the week
 * BEFORE the holiday's own week, so the part-week the holiday sits in is
 * excluded entirely. The two differ by however far into its week the holiday
 * falls — nothing at all when it lands on the first day of the week, six days
 * when it lands on the last — and for anyone whose pay varies those six days
 * are money.
 */
export function lookbackWindowEnd(
  rule: PayrollHolidayPayRule,
  holidayDate: string,
  employerWeekStartsOn?: number,
): string {
  const boundary = rule.lookbackEnds;
  if (boundary.kind === "day_before") return shiftDays(holidayDate, -1);
  // Back up to the first day of the holiday's own week, then take the day
  // before it: the last day of the preceding week.
  const weekStartsOn = employerWeekStartsOn ?? boundary.weekStartsOn;
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new PayrollHolidayError(`invalid employer work-week start day: ${weekStartsOn}`);
  }
  const intoWeek = (weekdayOf(holidayDate) - weekStartsOn + 7) % 7;
  return shiftDays(holidayDate, -(intoWeek + 1));
}

/**
 * [from, to] of the rule's lookback, ending where the rule's own statute says.
 *
 * A `normal_day` rule reports the window of its varying-hours arm: whether it
 * will need the lookback is not known until the employee's schedule has been
 * resolved, so the earnings are always loaded and simply go unused when the
 * normal day answers.
 */
export function lookbackWindow(
  rule: PayrollHolidayPayRule,
  holidayDate: string,
  employerWeekStartsOn?: number,
): { from: string; to: string } {
  const basis = holidayPayLookbackBasis(rule.basis);
  const to = lookbackWindowEnd(rule, holidayDate, employerWeekStartsOn);
  switch (basis.kind) {
    case "fixed_divisor":
    case "percent_of_earnings":
    case "average_hours_day":
      return spanBefore(to, basis.lookbackWeeks * 7);
    case "average_day":
      return spanBefore(to, basis.lookbackDays ?? (basis.lookbackWeeks ?? 4) * 7);
  }
}

/** The `days`-long window ending on (and including) `to`. */
const spanBefore = (to: string, days: number) => ({
  from: shiftDays(to, -(days - 1)),
  to,
});

/** The commission earner's own window, on the same boundary as the rule's. */
const commissionWindowOf = (
  rule: PayrollHolidayPayRule, holidayDate: string, weeks: number, employerWeekStartsOn?: number,
) => spanBefore(lookbackWindowEnd(rule, holidayDate, employerWeekStartsOn), weeks * 7);

/** Earnings from committed stubs. A partial pay period is included only when
 *  each earning line carries enough dated evidence to place its whole amount
 *  inside or outside the statutory window. Categories follow component keys,
 *  which makes Ontario's wage exclusions a transcription rather than a guess. */
async function lookbackEarnings(
  tx: Pick<typeof db, "execute">,
  input: Pick<StatutoryHolidayPayInput, "orgId" | "employeePartyId" | "excludeDocumentId">,
  window: { from: string; to: string },
): Promise<HolidayLookbackEarnings> {
  const rows = (await tx.execute<{
      system_key: string; amount: string; earned_from: string | Date | null;
      earned_to: string | Date | null;
      period_start: string | Date; period_end: string | Date;
    }>(sql`
    select coalesce(c.system_key, '') as system_key, l.amount,
           l.earned_from, l.earned_to,
           r.period_start, r.period_end
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
       and l.kind = 'earning'
       and s.pay_run_document_id <> ${input.excludeDocumentId}
       and r.period_start <= ${window.to} and r.period_end >= ${window.from}
  `));

  const totals = emptyLookbackEarnings();
  for (const row of rows.rows) {
    const day = (value: string | Date) =>
      String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
    const periodStart = day(row.period_start);
    const periodEnd = day(row.period_end);
    const overlapFrom = periodStart > window.from ? periodStart : window.from;
    const overlapTo = periodEnd < window.to ? periodEnd : window.to;
    const overlapDays = daysBetween(overlapFrom, overlapTo) + 1;
    if (overlapDays <= 0) continue;
    const earnedFrom = row.earned_from == null ? null : day(row.earned_from);
    const earnedTo = row.earned_to == null ? null : day(row.earned_to);
    const periodIsInside = periodStart >= window.from && periodEnd <= window.to;
    if (earnedFrom === null || earnedTo === null) {
      if (!periodIsInside) {
        throw new PayrollHolidayError(
          `${input.employeePartyId}: statutory holiday lookback earnings overlap ${window.from} through ${window.to}, but a committed pay stub has no dated earning evidence; record the earning dates or correct the pay stub before calculating holiday pay`,
        );
      }
    } else {
      const earningOverlaps = earnedFrom <= window.to && earnedTo >= window.from;
      if (!earningOverlaps) continue;
      if (earnedFrom < window.from || earnedTo > window.to) {
        throw new PayrollHolidayError(
          `${input.employeePartyId}: a pay-stub earning dated ${earnedFrom} through ${earnedTo} crosses the statutory holiday lookback boundary; split the earning into day-resolved pay-stub lines before calculating holiday pay`,
        );
      }
    }
    const amount = roundMoney(row.amount, 4);

    const bucket: keyof HolidayLookbackEarnings =
      row.system_key === "overtime" ? "overtime"
      : row.system_key === "vacation_payout" ? "vacationPay"
      : row.system_key === "stat_holiday" || row.system_key === "stat_holiday_premium" ? "holidayPay"
      : "regular";
    totals[bucket] = add(totals[bucket], amount);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// "Worked, or earned wages, on a day"
// ---------------------------------------------------------------------------

/**
 * The DAY-RESOLVED evidence a statute's day count is built from.
 *
 * WHAT THIS DATA MODEL CAN AND CANNOT SEE, because the answer decides money.
 *
 * Approved time, approved paid leave and day-resolved earning lines carry
 * civil dates. An entitlement ledger draw-down carries only the run date;
 * it cannot identify leave days by itself.
 *
 * What CAN be asserted honestly:
 *
 *  1. `workedOn` — approved time in the window. Days worked, and also days of
 *     paid leave for the many employers who book leave as a timesheet line
 *     against a leave time type (which is how an hourly employee's vacation is
 *     already recorded and already counted).
 *  2. `earnedOn` and `owedPaidOn` — day-dated committed earning lines and
 *     approved paid leave absences, respectively. The latter counts for
 *     "entitled to receive pay" even before the amount is paid.
 *  3. `paidPeriodsWithoutHours` — a committed pay period with positive earnings
 *     and NO hours on any earning line. That is pay FOR THE PERIOD rather than
 *     for hours: a salary, or a period spent entirely on paid leave drawn from
 *     a bank. The "no hours anywhere" test is what keeps it honest — a stub
 *     carrying hours was paid for those hours, which are already day-resolved
 *     above, so nothing is added and nothing is double-counted. It is also what
 *     stops a 4%-on-every-cheque vacation line from making every hourly
 *     employee's whole period qualify.
 *  4. `paidHolidays` — observed paid statutory holidays inside the window that
 *     the employee was actually paid statutory holiday pay for. BC's own
 *     guideline counts these expressly, and its worked example ($3,200 ÷ 20)
 *     reaches twenty by adding a paid Christmas Day to nineteen worked days.
 *
 * Untimed paid absence inside an hourly stub contributes only when an approved
 * absence or dated earning line identifies the days. A negative entitlement
 * decision additionally needs the run-specific completeness attestation.
 */
export interface HolidayDayEvidence {
  /** Distinct dates with approved time (hours > 0). */
  workedOn: readonly string[];
  /** Committed earnings proven to belong to one day. */
  earnedOn?: readonly string[];
  /** Approved paid absence days owed under the employer's leave policy. */
  owedPaidOn?: readonly string[];
  /** Committed periods paid for the period rather than for hours. */
  paidPeriodsWithoutHours: readonly { from: string; to: string }[];
  /** Dates of observed paid holidays the employee was paid for. */
  paidHolidays: readonly string[];
}

/**
 * How many days of `window` satisfy the statute's own predicate — PURE, so the
 * three sentences are verifiable side by side with no database.
 *
 * `worked` is exactly what this engine has always counted. The two broader
 * predicates add the paid days above; a paid period with no hours is expanded
 * to the employee's NORMAL WORKING DAYS inside it, from `work_schedules`,
 * because "days on which wages were earned" is not every calendar day — BC's
 * guideline reaches twenty in thirty, not thirty in thirty, and a Sunday nobody
 * was scheduled for is not a day wages were earned on.
 *
 * With no schedule recorded it REFUSES rather than guess a working week. That
 * is the same refusal a `normal_day` basis already makes and for the same
 * reason: five days, or a fifth of a period, is a number indistinguishable on
 * the stub from a correct one. It can only fire where an untimed paid period
 * actually overlaps the window — every employee whose time is on a timesheet is
 * unaffected, and computes exactly as before.
 */
export function countHolidayQualifyingDays(input: {
  /** Named in the refusal. */
  employee: string;
  window: { from: string; to: string };
  counting: PayrollHolidayDayCounting;
  evidence: HolidayDayEvidence;
  /** The pattern in force on the holiday; null when none is recorded. */
  schedule?: ResolvedWorkSchedule | null;
}): number {
  const { window, counting, evidence } = input;
  const inWindow = (date: string) => date >= window.from && date <= window.to;
  const days = new Set<string>(evidence.workedOn.filter(inWindow));
  if (counting === "worked") return days.size;
  for (const date of evidence.earnedOn ?? []) if (inWindow(date)) days.add(date);
  if (counting === "entitled_to_pay") {
    for (const date of evidence.owedPaidOn ?? []) if (inWindow(date)) days.add(date);
  }
  for (const date of evidence.paidHolidays) if (inWindow(date)) days.add(date);

  for (const period of evidence.paidPeriodsWithoutHours) {
    const from = period.from > window.from ? period.from : window.from;
    const to = period.to < window.to ? period.to : window.to;
    if (from > to) continue;
    const schedule = input.schedule ?? null;
    if (!schedule || schedule.pattern === "varies") {
      throw new PayrollHolidayError(
        `${input.employee}: this jurisdiction counts the days on which the employee `
        + `${describeDayCounting(counting).toUpperCase()}, and ${from} to ${to} was paid with no `
        + "hours recorded at all — a salary, or leave paid from a bank. Which of those days were "
        + "working days is not something this "
        + (schedule ? "employee's 'hours vary' schedule can answer" : "calculation has been told")
        + ". Record the hours and days they are normally scheduled to work, or record the leave "
        + "as time entries. It will not assume a working week it has not been told about",
      );
    }
    for (let cursor = from; cursor <= to; cursor = shiftDays(cursor, 1)) {
      if (isScheduledOn(schedule, cursor) === true) days.add(cursor);
    }
  }
  return days.size;
}

/**
 * Every day-resolved fact for [from, to], in one pass.
 *
 * Loaded for the WIDEST window any of the rule's tests needs, then sliced by
 * `countHolidayQualifyingDays` — a rule with a 30-day qualifier and a 4-week
 * pay window makes one round trip, not two.
 */
/**
 * Exported for the work-triggered grant engine (remembrance-grants.ts), which
 * counts the same statute-defined day sets over its own window: one loader,
 * not two. The input's lookback fields it does not need still travel with it
 * — a narrower parameter would be a second contract for the same query.
 */
export async function loadHolidayDayEvidence(
  tx: Pick<typeof db, "execute">,
  input: Pick<StatutoryHolidayPayInput, "orgId" | "employeePartyId" | "excludeDocumentId">,
  window: { from: string; to: string },
  /** The observed calendar over the same window; empty when only worked days
   *  are being counted, in which case nothing below is read. */
  observedInWindow: readonly ObservedHoliday[],
  /** False when every predicate in play is `worked` — a jurisdiction that
   *  counts only days worked does not pay for the stub scan. */
  needsPaidDays: boolean,
): Promise<HolidayDayEvidence> {
  const worked = (await tx.execute<{ worked_on: string | Date }>(sql`
    select distinct worked_on
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and hours > 0
       and worked_on between ${window.from} and ${window.to}
  `));

  const day = (value: string | Date) =>
    String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  const workedOn = worked.rows.map((row) => day(row.worked_on));
  if (!needsPaidDays) {
    return { workedOn, paidPeriodsWithoutHours: [], paidHolidays: [] };
  }

  const [earned, owed] = await Promise.all([
    tx.execute<{ earned_on: string | Date }>(sql`
      select l.earned_from as earned_on
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       where l.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
         and r.run_status = 'committed' and s.pay_run_document_id <> ${input.excludeDocumentId}
         and l.kind = 'earning' and l.earned_from = l.earned_to
         and l.earned_from between ${window.from} and ${window.to}
       group by l.earned_from having sum(l.amount) > 0`),
    tx.execute<{ on_date: string | Date }>(sql`
      select distinct a.on_date
        from hrm_absences a
        join worker_employments e on e.id = a.employment_id and e.org_id = a.org_id
        join hrm_leave_requests r on r.id = a.leave_request_id and r.org_id = a.org_id
        join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
       where a.org_id = ${input.orgId} and e.worker_party_id = ${input.employeePartyId}
         and a.on_date between ${window.from} and ${window.to}
         and r.status = 'approved' and t.paid and a.hours > 0
         and a.reversal_of is null
         and not exists (select 1 from hrm_absences reversal
                          where reversal.org_id = a.org_id and reversal.reversal_of = a.id)`),
  ]);

  // One row per committed stub overlapping the window, with the hours and the
  // earnings on it. The classification is done here rather than in SQL so the
  // rule ("paid for the period, not for hours") is readable beside the comment
  // that justifies it.
  const stubs = (await tx.execute<{
      period_start: string | Date; period_end: string | Date;
      hours: string; earnings: string; holiday_pay: string;
    }>(sql`
    select r.period_start, r.period_end,
           coalesce(sum(case when l.kind = 'earning' then l.hours end), 0)::text as hours,
           coalesce(sum(case when l.kind = 'earning' and l.earned_from is null then l.amount end), 0)::text as earnings,
           coalesce(sum(case when l.kind = 'earning'
                              and c.system_key = 'stat_holiday' then l.amount end), 0)::text
             as holiday_pay
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      left join pay_stub_lines l on l.stub_id = s.id and l.org_id = s.org_id
      left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where s.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
       and s.pay_run_document_id <> ${input.excludeDocumentId}
       and r.period_start <= ${window.to} and r.period_end >= ${window.from}
     group by s.id, r.period_start, r.period_end
  `));

  const paidPeriodsWithoutHours: { from: string; to: string }[] = [];
  const holidayPaidPeriods: { from: string; to: string }[] = [];
  for (const row of stubs.rows) {
    const period = { from: day(row.period_start), to: day(row.period_end) };
    if (cmp(row.hours, "0") === 0 && cmp(row.earnings, "0") > 0) {
      paidPeriodsWithoutHours.push(period);
    }
    if (cmp(row.holiday_pay, "0") !== 0) holidayPaidPeriods.push(period);
  }

  const paidHolidays = observedInWindow
    .filter((holiday) => holiday.paid)
    .filter((holiday) =>
      holidayPaidPeriods.some((p) => p.from <= holiday.date && p.to >= holiday.date))
    .map((holiday) => holiday.date);

  return {
    workedOn,
    earnedOn: earned.rows.map((row) => day(row.earned_on)),
    owedPaidOn: owed.rows.map((row) => day(row.on_date)),
    paidPeriodsWithoutHours, paidHolidays,
  };
}

/** The current, independently computed count a run-specific assertion attests. */
export async function evidencedEntitledPayDays(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string; employeePartyId: string; employeeName: string;
    excludeDocumentId: string; jurisdiction: string; holidayDate: string;
  },
): Promise<number> {
  const rule = statutoryHolidayPayRule(input.jurisdiction, input.holidayDate);
  const qualifier = rule?.qualifying.minDaysWorkedInWindow;
  if (qualifier?.counting !== "entitled_to_pay") {
    throw new PayrollHolidayError(`${input.jurisdiction} does not declare an entitlement-to-pay day assessment on ${input.holidayDate}`);
  }
  const window = spanBefore(shiftDays(input.holidayDate, -1), qualifier.ofDays);
  const overrides = await loadHolidayOverrides(tx, input.orgId, input.jurisdiction);
  const observed = resolveObservedHolidays({
    jurisdiction: input.jurisdiction, from: window.from, to: window.to, overrides,
  });
  const schedule = await resolveWorkSchedule(tx, input.orgId, input.employeePartyId, input.holidayDate);
  const evidence = await loadHolidayDayEvidence(tx, input, window, observed, true);
  return countHolidayQualifyingDays({
    employee: input.employeeName, window, counting: "entitled_to_pay", evidence, schedule,
  });
}

/** Approved hours worked on the holiday itself. */
/**
 * Approved hours worked on the holiday itself. Exported with
 * loadHolidayDayEvidence above: the grant engine reads the same timesheets.
 */
export async function hoursOn(
  tx: Pick<typeof db, "execute">,
  input: Pick<StatutoryHolidayPayInput, "orgId" | "employeePartyId">,
  date: string,
): Promise<string> {
  const rows = (await tx.execute<{ hours: string }>(sql`
    select coalesce(sum(hours), 0)::text as hours
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and worked_on = ${date}
  `));
  return roundMoney(rows.rows[0]?.hours ?? "0", 2);
}

/** Approved time in a statute's average-hours lookback; timesheets own hours. */
async function hoursWorkedInLookback(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  window: { from: string; to: string },
): Promise<string> {
  const rows = (await tx.execute<{ hours: string }>(sql`
    select coalesce(sum(hours), 0)::text as hours
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and hours > 0
       and worked_on between ${window.from} and ${window.to}
  `));
  return rows.rows[0]?.hours ?? "0";
}

// ---------------------------------------------------------------------------
// The undeclared-jurisdiction gate
// ---------------------------------------------------------------------------

/** A statutory holiday that stops an undeclared jurisdiction's calculation. */
export interface UndeclaredJurisdictionHolidayConflict {
  jurisdiction: string;
  holidayName: string;
  date: string;
  /** The one message: the readiness blocker's detail and the calculate
   *  refusal are the SAME text, built here and nowhere else. */
  message: string;
}

/**
 * When statutory holiday pay is ON and an employee's jurisdiction is one no
 * pack has transcribed (CA-MB, US-MA…), the run may not guess. But it also may
 * not refuse a period with no holiday in it — an undeclared jurisdiction
 * calculates exactly as it did before the feature existed until a holiday
 * actually lands in the period.
 *
 * The undeclared jurisdiction has no declared calendar either, so "is a
 * holiday in the period" is probed against the MANDATORY days of the declared
 * EMPLOYMENT calendars in the same country (never a tax administration's
 * office calendar). A date must be observed by AT LEAST HALF of them before it
 * trips the gate: employment calendars overlap heavily on the days that matter
 * (the third Monday of February is Family Day in four provinces, Louis Riel
 * Day in Manitoba, Islander Day in Prince Edward Island and Heritage Day in
 * Nova Scotia — one date, four names, and an undeclared neighbour almost
 * certainly observes it too), while a day only one or two of them keep says
 * nothing about anywhere else and must not block.
 *
 * The fraction is deliberately proportional and not a constant. It was a
 * constant two, which discriminated well against six declared calendars and
 * stopped discriminating at all against fourteen: National Indigenous Peoples
 * Day binds exactly two jurisdictions (the Northwest Territories and Yukon)
 * and June 21 would have blocked every undeclared employment in the country.
 * A threshold that has to be re-tuned every time a jurisdiction is transcribed
 * is not a threshold.
 *
 * When the gate trips, the operator either declares the jurisdiction or turns
 * the feature off — both loud, neither a silent zero on what is probably a
 * paid holiday.
 *
 * Pure: pack declarations in, conflict out. Returns null when the period is
 * clear — or when the jurisdiction IS declared, which is not this gate's case.
 */
export function undeclaredJurisdictionHolidayConflict(input: {
  country: string;
  jurisdiction: string;
  from: string;
  to: string;
}): UndeclaredJurisdictionHolidayConflict | null {
  const { country, jurisdiction, from, to } = input;
  if (payrollJurisdictionDeclared(jurisdiction)) return null;

  const siblings = employmentJurisdictionsOf(country);
  const threshold = Math.max(1, Math.ceil(siblings.length / 2));
  const byDate = new Map<string, { observers: number; names: Map<string, number> }>();
  for (const declared of siblings) {
    for (const holiday of resolveObservedHolidays({ jurisdiction: declared.key, from, to })) {
      // Optional days are already absent without an election, and an election
      // can only exist for a DECLARED jurisdiction — so what remains is the
      // sibling calendar's statutory minimum.
      if (holiday.elected) continue;
      const entry = byDate.get(holiday.date) ?? { observers: 0, names: new Map() };
      entry.observers += 1;
      entry.names.set(holiday.name, (entry.names.get(holiday.name) ?? 0) + 1);
      byDate.set(holiday.date, entry);
    }
  }

  let first: { name: string; date: string } | null = null;
  for (const [date, entry] of byDate) {
    if (entry.observers < threshold) continue;
    if (!first || date < first.date) {
      // The day's most common name across the calendars that observe it.
      const name = [...entry.names.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
      first = { name, date };
    }
  }
  if (!first) return null;
  return {
    jurisdiction,
    holidayName: first.name,
    date: first.date,
    message:
      `statutory holiday pay is enabled and ${first.name} (${first.date}) falls in this pay `
      + `period, but no payroll pack declares a statutory holiday calendar or pay formula for `
      + `${jurisdiction} — transcribe the jurisdiction in engine/src/payroll/packs.ts, or turn `
      + "statutory holiday pay off in Payroll setup",
  };
}

/** The jurisdiction key an employee's payroll profile resolves to. Re-exported
 *  so callers need only this module. */
export { jurisdictionKey, payrollJurisdictionDeclared };
