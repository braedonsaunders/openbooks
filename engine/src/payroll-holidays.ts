import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, fromUnits, mul, mulDecimal, mulPercent, roundDiv, roundMoney, sum, toUnits } from "./money.ts";
import {
  jurisdictionKey,
  payrollJurisdiction,
  type PayrollHoliday,
  type PayrollHolidayObservance,
  type PayrollHolidayPayRule,
  type PayrollHolidayRule,
} from "./payroll/packs.ts";

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
 *    divides thirty days of wages by the days actually worked, Saskatchewan
 *    takes five per cent of four weeks — so the formula is declared per
 *    jurisdiction in the pack and this file only executes it. A jurisdiction
 *    whose rule nobody has transcribed REFUSES, loudly and by name; it never
 *    falls through to a neighbouring province's formula and never pays zero,
 *    because a silent zero is indistinguishable from a correct calculation for
 *    an employee who earned nothing.
 *
 * All money arithmetic goes through engine/src/money.ts. Never floats: a
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
  return iso(new Date(Date.UTC(year, month - 1, day)));
}

/** The calendar date a recurrence rule produces in a given year, before any
 *  weekend-observance shift. */
export function resolveHolidayRule(rule: PayrollHolidayRule, year: number): string {
  switch (rule.kind) {
    case "fixed":
      return iso(new Date(Date.UTC(year, rule.month - 1, rule.day)));
    case "easter_offset":
      return shiftDays(easterSunday(year), rule.days);
    case "nth_weekday": {
      if (rule.nth > 0) {
        const first = new Date(Date.UTC(year, rule.month - 1, 1));
        const offset = (rule.weekday - first.getUTCDay() + 7) % 7;
        return iso(new Date(Date.UTC(year, rule.month - 1, 1 + offset + (rule.nth - 1) * 7)));
      }
      // nth < 0 counts back from the end of the month: -1 is the LAST such
      // weekday (US Memorial Day is the last Monday in May, which is the
      // fourth Monday in four years out of seven and the fifth otherwise).
      const last = new Date(Date.UTC(year, rule.month, 0));
      const back = (last.getUTCDay() - rule.weekday + 7) % 7;
      return iso(new Date(last.getTime() - (back + (-rule.nth - 1) * 7) * DAY_MS));
    }
    case "weekday_before": {
      // The last <weekday> STRICTLY before month/day. Victoria Day is the
      // Monday preceding May 25, so when May 25 is itself a Monday the holiday
      // is May 18 — the single most commonly mis-implemented Canadian holiday.
      const anchor = new Date(Date.UTC(year, rule.month - 1, rule.day));
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
      const election = overrides.find(
        (o) => o.packKey === holiday.key && overrideCovers(o, statutoryDate),
      );
      // Optional days are OFF until elected; mandatory days are on unless an
      // election explicitly suppresses one (which the guard above forbids).
      const isObserved = election ? election.isObserved : !holiday.optional;
      if (!isObserved) continue;
      const date = applyObservance(statutoryDate, holiday.observance, taken);
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
      if (!statutoryDate || !overrideCovers(override, statutoryDate)) continue;
      // A one-off date is generated once, in its own year, not every year.
      if (override.ruleKind === "date" && statutoryDate.slice(0, 4) !== String(year)) continue;
      const date = applyObservance(statutoryDate, override.observance, taken);
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
  const rows = (await tx.execute(sql`
    select id, jurisdiction, pack_key, name, rule_kind, rule_month, rule_day,
           rule_weekday, rule_nth, rule_offset, observed_on, observance,
           is_observed, is_paid, effective_from, effective_to
      from payroll_holidays
     where org_id = ${orgId} and jurisdiction = ${jurisdiction}
     order by effective_from, pack_key nulls last, name
  `)) as unknown as {
    rows: {
      id: string; jurisdiction: string; pack_key: string | null; name: string | null;
      rule_kind: HolidayOverride["ruleKind"]; rule_month: number | null; rule_day: number | null;
      rule_weekday: number | null; rule_nth: number | null; rule_offset: number | null;
      observed_on: string | Date | null; observance: PayrollHolidayObservance;
      is_observed: boolean; is_paid: boolean;
      effective_from: string | Date; effective_to: string | Date | null;
    }[];
  };
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
 * The jurisdiction's holiday-pay rule, or `null` where the jurisdiction
 * genuinely mandates none (the United States). An UNDECLARED jurisdiction
 * throws out of `payrollJurisdiction` — that distinction is the whole design:
 * "the law requires nothing" and "nobody has transcribed the law" must never
 * produce the same payment.
 */
export function statutoryHolidayPayRule(jurisdiction: string): PayrollHolidayPayRule | null {
  return payrollJurisdiction(jurisdiction).holidayPay;
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
  /** Days worked, or on which wages were earned, in the lookback window. The
   *  denominator of an `average_day` rule. */
  daysWorked: number;
  /** Days worked in the QUALIFYING window, when the rule declares one that is
   *  a different length from the pay window (BC: 15 of the 30 days before). */
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
  /** Regular hourly rate, for the premium. */
  hourlyRate: string;
  /**
   * The employer asserting the last-and-first test was failed — the employee
   * was absent WITHOUT consent on the last scheduled shift before or the first
   * after. Only ever supplied deliberately; see `computeStatutoryHolidayPay`.
   */
  absentWithoutConsent?: boolean;
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
  if (qualifying.minEmploymentDays !== undefined) {
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
    const { days, ofDays } = qualifying.minDaysWorkedInWindow;
    const worked = context.daysWorkedInQualifyingWindow ?? context.daysWorked;
    if (worked < days) {
      return deny(
        `worked or earned wages on ${worked} of the ${ofDays} days before the holiday; `
        + `${days} are required`,
      );
    }
  }
  if (qualifying.lastAndFirstScheduledShift && context.absentWithoutConsent === true) {
    return deny(
      "absent without the employer's consent on the last scheduled shift before or the first after",
    );
  }

  // --- the day's pay -------------------------------------------------------
  let holidayPay: string;
  let basis: string;
  const basisRule = rule.basis;

  const commission = basisRule.kind === "fixed_divisor" ? basisRule.commission : undefined;
  const useCommission = Boolean(
    commission
    && context.paidOnCommission
    && (context.employmentWeeks ?? 0) >= commission.minWeeksEmployed,
  );

  if (basisRule.kind === "fixed_divisor" && useCommission && commission) {
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
    const window = basisRule.lookbackDays !== undefined
      ? `${basisRule.lookbackDays} days`
      : `${basisRule.lookbackWeeks} weeks`;
    if (context.daysWorked <= 0) {
      // An average-day jurisdiction with a zero denominator is undefined, not
      // zero. Paying nothing here would be a real entitlement quietly lost, so
      // it stops the run and names the employee.
      if (cmp(base, "0") === 0) {
        return deny(`no wages were earned in the ${window} before the holiday`);
      }
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} pays an average day's wage but no days `
        + `worked are recorded in the ${window} before it, while ${base} was earned — `
        + "the average is undefined; correct the timesheet before calculating",
      );
    }
    holidayPay = divideExact(base, context.daysWorked);
    basis = `${base} earned in the ${window} before the holiday ÷ ${context.daysWorked} days worked`;
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
}

/**
 * Statutory holiday pay for every observed paid holiday landing inside the pay
 * period, as pay-run INPUT lines.
 *
 * Returns an empty array — never throws — when the jurisdiction mandates no
 * holiday pay. Throws, naming the jurisdiction, when the pack does not declare
 * it at all.
 *
 * The lookback reads COMMITTED stubs only, and allocates a stub whose pay
 * period straddles the window boundary in proportion to the days of overlap.
 * Earnings are recorded per pay period, not per day, so some allocation is
 * unavoidable; doing it pro rata with exact ratio arithmetic (money.ts) is
 * the one choice that is both defensible and reproducible.
 */
export async function resolveStatutoryHolidayPay(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
): Promise<StatutoryHolidayEarningLine[]> {
  const rule = statutoryHolidayPayRule(input.jurisdiction);
  if (rule === null) return [];

  const holidays = (
    await observedHolidays(input.orgId, input.jurisdiction, input.periodStart, input.periodEnd, tx)
  ).filter((holiday) => holiday.paid);
  if (holidays.length === 0) return [];

  const hire = (await tx.execute(sql`
    select hired_on from employee_roles
     where org_id = ${input.orgId} and party_id = ${input.employeePartyId}
     order by hired_on nulls last limit 1
  `)) as unknown as { rows: { hired_on: string | Date | null }[] };
  const hiredOn = hire.rows[0]?.hired_on
    ? String(hire.rows[0].hired_on instanceof Date
        ? hire.rows[0].hired_on.toISOString()
        : hire.rows[0].hired_on).slice(0, 10)
    : null;

  const lines: StatutoryHolidayEarningLine[] = [];
  let sequence = 45;
  for (const holiday of holidays) {
    const window = lookbackWindow(rule, holiday.date);
    const earnings = await lookbackEarnings(tx, input, window);
    const daysWorked = await daysWithWages(tx, input, window);
    const qualifyingWindow = rule.qualifying.minDaysWorkedInWindow
      ? {
          from: shiftDays(holiday.date, -rule.qualifying.minDaysWorkedInWindow.ofDays),
          to: shiftDays(holiday.date, -1),
        }
      : window;
    const daysWorkedInQualifyingWindow = rule.qualifying.minDaysWorkedInWindow
      ? await daysWithWages(tx, input, qualifyingWindow)
      : daysWorked;
    const commissionWindow = rule.basis.kind === "fixed_divisor" && rule.basis.commission
      ? weeksBefore(holiday.date, rule.basis.commission.lookbackWeeks)
      : null;

    const result = computeStatutoryHolidayPay(rule, {
      employee: input.employeeName,
      holiday,
      earnings,
      daysWorked,
      daysWorkedInQualifyingWindow,
      employmentDays: hiredOn ? daysBetween(hiredOn, holiday.date) : null,
      employmentWeeks: hiredOn ? Math.floor(daysBetween(hiredOn, holiday.date) / 7) : null,
      commissionEarnings: commissionWindow
        ? await lookbackEarnings(tx, input, commissionWindow)
        : undefined,
      hoursWorked: await hoursOn(tx, input, holiday.date),
      hourlyRate: input.hourlyRate,
    });
    if (!result.qualified) continue;

    if (cmp(result.holidayPay, "0") !== 0) {
      lines.push({
        componentId: input.holidayComponentId, kind: "earning",
        description: `${holiday.name} — statutory holiday pay`,
        amount: result.holidayPay, sequence: sequence++,
        holidayKey: holiday.key, holidayDate: holiday.date, basis: result.basis,
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
  return lines;
}

/** [from, to] of the rule's lookback, ending the day before the holiday. */
export function lookbackWindow(
  rule: PayrollHolidayPayRule,
  holidayDate: string,
): { from: string; to: string } {
  switch (rule.basis.kind) {
    case "fixed_divisor":
    case "percent_of_earnings":
      return weeksBefore(holidayDate, rule.basis.lookbackWeeks);
    case "average_day":
      return rule.basis.lookbackDays !== undefined
        ? { from: shiftDays(holidayDate, -rule.basis.lookbackDays), to: shiftDays(holidayDate, -1) }
        : weeksBefore(holidayDate, rule.basis.lookbackWeeks ?? 4);
  }
}

const weeksBefore = (date: string, weeks: number) => ({
  from: shiftDays(date, -(weeks * 7)),
  to: shiftDays(date, -1),
});

/** Earnings from committed stubs, pro-rated where a pay period straddles the
 *  window. Categories follow the components' system keys, which is what makes
 *  "regular wages exclude overtime and other public holidays" (Ontario) a
 *  transcription rather than a guess. */
async function lookbackEarnings(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  window: { from: string; to: string },
): Promise<HolidayLookbackEarnings> {
  const rows = (await tx.execute(sql`
    select coalesce(c.system_key, '') as system_key,
           sum(l.amount) as amount,
           r.period_start, r.period_end
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      left join pay_components c on c.id = l.component_id
     where l.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
       and l.kind = 'earning'
       and s.pay_run_document_id <> ${input.excludeDocumentId}
       and r.period_start <= ${window.to} and r.period_end >= ${window.from}
     group by c.system_key, r.period_start, r.period_end
  `)) as unknown as {
    rows: {
      system_key: string; amount: string;
      period_start: string | Date; period_end: string | Date;
    }[];
  };

  const totals = emptyLookbackEarnings();
  for (const row of rows.rows) {
    const day = (value: string | Date) =>
      String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
    const periodStart = day(row.period_start);
    const periodEnd = day(row.period_end);
    const periodDays = daysBetween(periodStart, periodEnd) + 1;
    const overlapFrom = periodStart > window.from ? periodStart : window.from;
    const overlapTo = periodEnd < window.to ? periodEnd : window.to;
    const overlapDays = daysBetween(overlapFrom, overlapTo) + 1;
    if (overlapDays <= 0 || periodDays <= 0) continue;
    const amount = overlapDays >= periodDays
      ? roundMoney(row.amount, 4)
      : fromUnits(roundDiv(toUnits(row.amount) * BigInt(overlapDays), BigInt(periodDays)));

    const bucket: keyof HolidayLookbackEarnings =
      row.system_key === "overtime" ? "overtime"
      : row.system_key === "vacation_payout" ? "vacationPay"
      : row.system_key === "stat_holiday" || row.system_key === "stat_holiday_premium" ? "holidayPay"
      : "regular";
    totals[bucket] = add(totals[bucket], amount);
  }
  return totals;
}

/** Distinct days with approved time inside the window — the denominator of an
 *  average-day rule and the numerator of BC's 15-of-30 test. */
async function daysWithWages(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  window: { from: string; to: string },
): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(distinct worked_on)::int as days
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and hours > 0
       and worked_on between ${window.from} and ${window.to}
  `)) as unknown as { rows: { days: number }[] };
  return Number(rows.rows[0]?.days ?? 0);
}

/** Approved hours worked on the holiday itself. */
async function hoursOn(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  date: string,
): Promise<string> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(hours), 0)::text as hours
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and worked_on = ${date}
  `)) as unknown as { rows: { hours: string }[] };
  return roundMoney(rows.rows[0]?.hours ?? "0", 2);
}

/** The jurisdiction key an employee's payroll profile resolves to. Re-exported
 *  so callers need only this module. */
export { jurisdictionKey };
