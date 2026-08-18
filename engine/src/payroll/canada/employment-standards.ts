import type {
  PayrollHoliday,
  PayrollHolidayLookbackBoundary,
  PayrollHolidayPayEdition,
  PayrollHolidayPayRule,
  PayrollHolidayRule,
  PayrollJurisdiction,
} from "../packs.ts";

/**
 * Canada's employment-standards jurisdictions: which statutory holidays each
 * one observes, and the pay each one owes for them.
 *
 * Every fact here is a TRANSCRIPTION of a statute, cited on the declaration it
 * belongs to. Nothing in this file is a policy choice, a default, or a
 * convenience: the engine (engine/src/payroll-holidays.ts) executes these
 * declarations and knows no province, and a jurisdiction nobody has transcribed
 * is REFUSED by name rather than quietly inheriting a neighbour's formula.
 *
 * It imports TYPES ONLY from ../packs.ts. `packs.ts` imports the jurisdiction
 * list back, and a value import in both directions is a module-evaluation cycle
 * — the failure engine/src/payroll-error.ts exists to explain. Type imports are
 * erased, so this direction costs nothing at runtime.
 *
 * ---------------------------------------------------------------------------
 * WHAT DIFFERS BETWEEN THEM, SO THE SHAPE IS NOT MISTAKEN FOR BOILERPLATE
 * ---------------------------------------------------------------------------
 *
 * - THE LIST. Fourteen jurisdictions observe fourteen different sets. Boxing
 *   Day is statutory in Ontario and optional in Alberta; Remembrance Day is not
 *   an Ontario public holiday at all; the first Monday in August is a paid
 *   statutory holiday in six of them under six different names and an unpaid
 *   civic day in the rest; Truth and Reconciliation binds private employers in
 *   only some.
 * - THE FORMULA. A twentieth of four weeks, five per cent of four weeks, an
 *   average of the days actually worked, and — in three jurisdictions — the
 *   wages of the employee's own normal working day, which needs the schedule
 *   and not the ledger.
 * - THE QUALIFIERS. Thirty days of employment; fifteen of the last thirty days
 *   worked; ninety days in the last twelve months; the last-and-first scheduled
 *   shift; and, in two of them, nothing at all.
 * - THE PREMIUM. One and a half times the hours worked, sometimes on top of the
 *   day's pay and sometimes instead of it. That single boolean is the
 *   difference between paying a working holiday once and paying it twice.
 */

// --- Reusable holiday rules ------------------------------------------------
// The same day observed by several jurisdictions is declared once; the
// jurisdiction lists say WHICH days it observes, not what a day is.

const NEW_YEARS: PayrollHoliday = {
  key: "new_years", name: "New Year's Day",
  rule: { kind: "fixed", month: 1, day: 1 }, observance: "none",
};
const GOOD_FRIDAY: PayrollHoliday = {
  key: "good_friday", name: "Good Friday",
  rule: { kind: "easter_offset", days: -2 }, observance: "none",
};
const EASTER_MONDAY: PayrollHoliday = {
  key: "easter_monday", name: "Easter Monday",
  rule: { kind: "easter_offset", days: 1 }, observance: "none",
};
const VICTORIA_DAY: PayrollHoliday = {
  key: "victoria_day", name: "Victoria Day",
  // The Monday preceding May 25 — never May 25 itself when that is a Monday.
  rule: { kind: "weekday_before", month: 5, day: 25, weekday: 1 }, observance: "none",
};
const CANADA_DAY: PayrollHoliday = {
  key: "canada_day", name: "Canada Day",
  rule: { kind: "fixed", month: 7, day: 1 }, observance: "none",
};
const LABOUR_DAY: PayrollHoliday = {
  key: "labour_day", name: "Labour Day",
  rule: { kind: "nth_weekday", month: 9, weekday: 1, nth: 1 }, observance: "none",
};
const TRUTH_AND_RECONCILIATION: PayrollHoliday = {
  key: "truth_and_reconciliation", name: "National Day for Truth and Reconciliation",
  rule: { kind: "fixed", month: 9, day: 30 }, observance: "none", from: 2021,
};
const THANKSGIVING_CA: PayrollHoliday = {
  key: "thanksgiving", name: "Thanksgiving Day",
  rule: { kind: "nth_weekday", month: 10, weekday: 1, nth: 2 }, observance: "none",
};
const REMEMBRANCE_DAY: PayrollHoliday = {
  key: "remembrance_day", name: "Remembrance Day",
  rule: { kind: "fixed", month: 11, day: 11 }, observance: "none",
};
const CHRISTMAS: PayrollHoliday = {
  key: "christmas", name: "Christmas Day",
  rule: { kind: "fixed", month: 12, day: 25 }, observance: "none",
};
const BOXING_DAY: PayrollHoliday = {
  key: "boxing_day", name: "Boxing Day",
  rule: { kind: "fixed", month: 12, day: 26 }, observance: "none",
};
const THIRD_MONDAY_FEBRUARY: PayrollHolidayRule = {
  kind: "nth_weekday", month: 2, weekday: 1, nth: 3,
};
const FIRST_MONDAY_AUGUST: PayrollHolidayRule = {
  kind: "nth_weekday", month: 8, weekday: 1, nth: 1,
};

/** The Canada Labour Code moves a weekend general holiday to a working day. */
const federal = (holiday: PayrollHoliday): PayrollHoliday => ({
  ...holiday, observance: "next_monday",
});

// --- Canadian holiday-pay rules --------------------------------------------

/**
 * "…immediately preceding the general holiday": the window ends the day before
 * the holiday itself. Eight of the fourteen are worded this way.
 */
const ENDS_DAY_BEFORE: PayrollHolidayLookbackBoundary = { kind: "day_before" };

/**
 * "…immediately preceding the WEEK in which the general holiday occurs": the
 * window ends on the Saturday before the holiday's own week, so the part-week
 * the holiday sits in is excluded. Sunday-start, which is the Canada Labour
 * Code's own definition of a week (s. 166) and Ontario's statutory fallback
 * where an employer has selected no work week of its own.
 *
 * NOT expressible here, and named rather than hidden: Ontario s. 1 and Quebec
 * s. 1(12) both let the EMPLOYER select the seven-day period. An employer whose
 * work week starts on a Monday has a window shifted by one day from this one.
 * Nothing records that election yet; when it does, it belongs beside the pay
 * schedule and overrides `weekStartsOn` for that employer.
 */
const ENDS_WEEK_BEFORE: PayrollHolidayLookbackBoundary = {
  kind: "week_before", weekStartsOn: 0,
};

/** The pack's only transcription of a jurisdiction's formula: offered for
 *  every date it is asked about, because no earlier edition is carried. */
const onlyEdition = (rule: PayrollHolidayPayRule): readonly PayrollHolidayPayEdition[] =>
  [{ effectiveFrom: null, effectiveTo: null, rule }];

/**
 * Canada Labour Code s. 196(1)–(2). One twentieth of the wages, excluding
 * overtime pay, earned in the four-week period immediately preceding the week
 * in which the holiday occurs; one sixtieth over twelve weeks for a commission
 * earner with at least twelve weeks of continuous employment. The thirty-day
 * qualifying period was repealed effective 2019-09-01, so there is none.
 */
const CLC_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Canada Labour Code, RSC 1985 c L-2, ss. 196–197",
  basis: {
    kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4,
    commission: { divisor: 60, lookbackWeeks: 12, minWeeksEmployed: 12 },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: false },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // s. 196(1)-(2): "in the four-week period immediately preceding the WEEK in
  // which the general holiday occurs", and the same for the twelve-week
  // commission window.
  lookbackEnds: ENDS_WEEK_BEFORE,
};

/**
 * Ontario ESA s. 24(1)(a). All of the REGULAR wages earned in the four work
 * weeks before the work week with the public holiday, plus all of the vacation
 * pay payable with respect to those four work weeks, divided by 20. Regular
 * wages exclude overtime pay, premium pay, and pay for other public holidays —
 * which is why `holidayPay` is false here and true federally.
 */
const ON_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act, 2000 (Ontario), ss. 24(1)(a), 26, 29",
  basis: { kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4 },
  include: { overtime: false, vacationPay: true, holidayPay: false },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // "the four work weeks BEFORE THE WORK WEEK with the public holiday" — the
  // part-week the holiday falls in is outside the window.
  lookbackEnds: ENDS_WEEK_BEFORE,
};

/**
 * Quebec LSA s. 62. One twentieth of the wages earned during the four complete
 * weeks of pay preceding the week of the holiday, excluding overtime; one
 * sixtieth over twelve complete weeks for an employee remunerated in whole or
 * in part on commission. No service requirement since 2003-05-01 (s. 65).
 */
const QC_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Act respecting labour standards (Quebec), CQLR c N-1.1, ss. 62–65",
  basis: {
    kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4,
    commission: { divisor: 60, lookbackWeeks: 12, minWeeksEmployed: 12 },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1", plusHolidayPay: true },
  // s. 62: "the four complete weeks of pay PRECEDING THE WEEK of the holiday".
  lookbackEnds: ENDS_WEEK_BEFORE,
};

/**
 * British Columbia ESA ss. 44–46. An average day's pay: the amount paid or
 * payable for work done and wages earned in the 30 calendar days preceding the
 * holiday — vacation pay for vacation days taken in the period included,
 * overtime excluded — divided by the number of days worked or on which wages
 * were earned. Qualifying: employed 30 calendar days AND worked or earned
 * wages on at least 15 of them. Premium: time and a half to 12 hours, double
 * beyond, plus the average day's pay.
 *
 * "WORKED OR EARNED WAGES" IS THE WHOLE TEST, TWICE — s. 44(a) as the
 * qualifier and s. 45(1) as the denominator, in the same words. The Branch's
 * interpretive guideline for s. 45 states that "days worked" here "includes any
 * days when wages were earned … days of paid annual vacation, paid sick days
 * required by the Act, or other paid statutory holidays that occur in the 30
 * calendar days prior", and its worked example ($3,200 ÷ 20) reaches 20 by
 * counting nineteen worked days plus a paid Christmas Day. Declared with
 * `counting: "worked_or_earned_wages"` on both, which is what the engine
 * previously had no way to say — it counted approved timesheets and nothing
 * else, so an employee on paid vacation before the holiday was refused.
 *
 * NOT transcribed: s. 44(b) qualifies an employee who worked under a s. 37
 * averaging agreement at any time in the thirty days, whatever their day count.
 * Nothing records an averaging agreement, so an employee under one who falls
 * short of fifteen days is denied here and should not be.
 */
const BC_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act (British Columbia), RSBC 1996 c 113, ss. 44–46",
  basis: { kind: "average_day", lookbackDays: 30, counting: "worked_or_earned_wages" },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: {
    minEmploymentDays: 30,
    minDaysWorkedInWindow: { days: 15, ofDays: 30, counting: "worked_or_earned_wages" },
    lastAndFirstScheduledShift: false,
  },
  premium: {
    multiplier: "1.5", overtimeAfterHours: 12, overtimeMultiplier: "2",
    plusHolidayPay: true,
  },
  // s. 45(1): "the 30 calendar day period preceding the statutory holiday" —
  // the day, not the week.
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * Alberta Employment Standards Code. Average daily wage = wages divided by the
 * number of days worked, over the four weeks immediately preceding the holiday
 * (an employer may instead use the four weeks ending on the last day of the
 * preceding pay period; this declares the statutory default). Overtime pay is
 * not wages for this purpose. An employee absent without the employer's
 * consent on the last scheduled workday before or the first after loses the
 * day.
 */
const AB_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Code (Alberta), RSA 2000 c E-9, Part 2 Div. 5",
  // "wages divided by the number of days the employee WORKED" — Alberta's
  // denominator is days worked and nothing else, unlike British Columbia's.
  basis: { kind: "average_day", lookbackWeeks: 4, counting: "worked" },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // "the 4 weeks immediately preceding the general holiday" — the day, not the
  // week. (The Code's alternative, four weeks ending on the last day of the
  // preceding pay period, is an employer election this shape does not carry.)
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * Saskatchewan Employment Act s. 2-33. Five per cent of the employee's wages,
 * not including overtime, in the four weeks preceding the public holiday. An
 * employee who has worked less than four weeks is still entitled to 5% of what
 * they have earned, so there is no service qualifier.
 */
const SK_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "The Saskatchewan Employment Act, SS 2013 c S-15.1, s. 2-33",
  basis: { kind: "percent_of_earnings", percent: "5", lookbackWeeks: 4 },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: false },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // s. 2-33: "in the four weeks preceding the public holiday".
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * Manitoba, The Employment Standards Code, CCSM c E110, ss. 22–25.
 *
 * s. 23(1): not less than the wages for the employee's regular hours of work on
 * a NORMAL WORKDAY. Manitoba's own guidance is explicit that this is a normal
 * workday and not the calendar day — where the holiday falls on a weekday the
 * employee does not normally work, the employer must give a normal workday off
 * with general holiday pay — which is why the basis is `normal_day` and not
 * "the hours scheduled on September 30".
 *
 * s. 23(2): where the normal workday's wage CANNOT be determined, because the
 * hours in a normal workday vary from day to day or the wage for regular hours
 * varies from pay period to pay period, five per cent of total wages excluding
 * overtime for the four weeks immediately preceding the holiday. Overtime is
 * the only express carve-out, so vacation pay and prior general holiday pay
 * stay in the base.
 *
 * s. 22: no minimum length of employment AT ALL — the only test is the last
 * scheduled workday before and the first after, and s. 22(2) deems the
 * employer's consent where the absence is a leave or illness.
 *
 * s. 25(1): an employee who works the day gets the overtime wage rate for the
 * hours worked IN ADDITION to the general holiday pay.
 *
 * NOT transcribed, deliberately: s. 30 puts CONSTRUCTION employees on a
 * separate regime entirely — 4% of annual wages in place of any per-holiday
 * entitlement, ss. 22–29 disapplied. This declaration is the general regime; a
 * Manitoba construction employer is over-paid by it, not under-paid, but it is
 * a real gap and it is named here rather than hidden.
 */
const MB_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "The Employment Standards Code (Manitoba), CCSM c E110, ss. 22–25",
  basis: {
    kind: "normal_day",
    whenIrregular: { kind: "percent_of_earnings", percent: "5", lookbackWeeks: 4 },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // s. 23(2): "the four week period immediately preceding the general holiday".
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * New Brunswick, Employment Standards Act, SNB 1982 c E-7.2, ss. 18–21.
 *
 * s. 18(2): the employee's regular wages for the day. s. 21(1), where the wages
 * vary from day to day: the average daily earnings, exclusive of overtime, for
 * the days on which the employee WORKED during the thirty calendar days
 * immediately preceding the holiday — a days-worked denominator, not
 * days-worked-and-paid.
 *
 * s. 18(1): employed at least ninety days during the twelve months before the
 * holiday, and worked the scheduled day of work before and after unless there
 * was reasonable cause. The ninety-day test is the longest service qualifier in
 * the country.
 *
 * s. 19(1): time and a half for the hours worked, in addition to the day's
 * regular wages where the employee qualifies.
 *
 * NOT transcribed: s. 21(2) caps a ROUTE SALESPERSON's holiday pay so that
 * week's earnings cannot exceed their average weekly wages over the preceding
 * four weeks. It applies to one named occupation and there is no way to say so
 * in this shape; a route salesperson is therefore over-paid at the margin.
 */
const NB_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act (New Brunswick), SNB 1982 c E-7.2, ss. 18–21",
  basis: {
    kind: "normal_day",
    // s. 21(1): "for the days on which the employee WORKED during the thirty
    // calendar days" — days worked, not days paid.
    whenIrregular: { kind: "average_day", lookbackDays: 30, counting: "worked" },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  // "Ninety days during the previous twelve calendar months" is read here as
  // ninety calendar days of employment before the holiday, which is how the
  // province's own guidance states it. Broken service across the twelve months
  // is NOT reconstructed — an employee rehired after a gap qualifies here on
  // continuous days since their latest hire date.
  qualifying: { minEmploymentDays: 90, lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // s. 21(1): "the thirty calendar days immediately preceding the holiday".
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * Newfoundland and Labrador, Labour Standards Act, RSNL 1990 c L-2, ss. 15–19.
 *
 * s. 15: the employee's hourly rate of pay multiplied by the AVERAGE NUMBER OF
 * HOURS worked in a day over the three weeks immediately preceding the holiday.
 * Declared as `average_day` over three weeks — wages ÷ days worked — which is
 * arithmetically identical for an employee on one hourly rate throughout the
 * window, and is what the province's own guidance restates. The two diverge for
 * an employee whose rate changed mid-window; NL is the only jurisdiction whose
 * statute is worded rate-times-hours rather than wages-over-days, and this
 * shape cannot express the difference.
 *
 * s. 19(1): not entitled where the holiday falls within thirty days of the
 * start of employment, or where the employee fails WITHOUT JUST CAUSE to work
 * the regular working day before and after.
 *
 * s. 17(1): NL is the one jurisdiction whose worked-holiday pay REPLACES the
 * day's holiday pay instead of stacking on it. The employee elects between
 * double wages for the day, a day off with pay within thirty days, or an extra
 * vacation day — so `plusHolidayPay` is false and the multiplier is 2. The two
 * lieu-day elections are scheduling acts an employer records as a company
 * holiday, not amounts this engine can compute.
 */
const NL_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Labour Standards Act (Newfoundland and Labrador), RSNL 1990 c L-2, ss. 15–19",
  // s. 15 averages "the number of hours WORKED in a day": days worked.
  basis: { kind: "average_day", lookbackWeeks: 3, counting: "worked" },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { minEmploymentDays: 30, lastAndFirstScheduledShift: true },
  premium: { multiplier: "2", plusHolidayPay: false },
  // s. 15: "the three weeks immediately preceding the holiday".
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * Nova Scotia, Labour Standards Code, RSNS 1989 c 246, ss. 40–42.
 *
 * s. 40: a regular day's pay — wages at the regular rate for the employee's
 * normal hours (s. 40(2)), or for a normal working day on any other basis
 * (s. 40(3)); a weekly or monthly employee's wages simply may not be reduced
 * (s. 40(1)). As in Manitoba, a holiday landing on the employee's day off is a
 * different day off WITH PAY, so what is owed is one normal working day.
 *
 * The Code is SILENT on employees whose hours vary. Labour Standards'
 * administrative guidance says to average the hours worked over the thirty days
 * immediately before the holiday, and that is what `whenIrregular` declares —
 * flagged here because it is published guidance, not statutory text, and it is
 * the only arm in this file that is not a transcription of an Act.
 *
 * s. 42(1): entitled where the employee received or was ENTITLED TO RECEIVE pay
 * for at least fifteen of the thirty calendar days before the holiday, and
 * worked the scheduled day before and after. That is the broadest of the three
 * day-counting sentences in Canada — broader than British Columbia's "worked or
 * earned wages", because it reaches pay the employer owes and has not paid —
 * and it is declared as the one it is, `counting: "entitled_to_pay"`.
 *
 * s. 41(2): the amount otherwise payable for the holiday PLUS at least time and
 * a half for the hours worked.
 */
const NS_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Labour Standards Code (Nova Scotia), RSNS 1989 c 246, ss. 40–42",
  basis: {
    kind: "normal_day",
    // The averaging arm is the Branch's published guidance and it says to
    // average the hours WORKED over the thirty days — a narrower measure than
    // the s. 42(1) qualifier above, and deliberately not the same value.
    whenIrregular: { kind: "average_day", lookbackDays: 30, counting: "worked" },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: {
    minDaysWorkedInWindow: { days: 15, ofDays: 30, counting: "entitled_to_pay" },
    lastAndFirstScheduledShift: true,
  },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // "the thirty calendar days immediately preceding the holiday".
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * Northwest Territories, Employment Standards Act, SNWT 2007 c 13, ss. 22–23,
 * and Nunavut, Labour Standards Act, RSNWT (Nu) 1988 c L-1, ss. 24–28.
 *
 * The two territories inherited one statute and their holiday-pay arithmetic is
 * still word for word the same, so the rule is built once and cited twice. The
 * CALENDARS differ — Nunavut Day and the Sovereign's birthday against National
 * Indigenous Peoples Day — and those are declared separately below.
 *
 * NT s. 23(1) / NU s. 24: where wages are calculated on the basis of TIME, the
 * wages the employee would have earned at the regular rate for their normal
 * hours; on any other basis, the average of the daily wages for the four weeks
 * THE EMPLOYEE WORKED immediately preceding the week of the holiday. The split
 * is on how the employee is paid rather than on whether their hours vary, which
 * the two arms here approximate exactly: an employee not paid by time is one
 * paid on commission or piece rate, and one with no settled daily hours has no
 * "normal hours" to be paid for either.
 *
 * NT s. 22(1) / NU s. 25(2) both say the entitlement arises whether or not the
 * holiday falls on a day of work — the same reason the basis is a normal
 * working day rather than the calendar day.
 *
 * NT s. 23(7)(a) / NU s. 28(a): no entitlement to an unworked holiday where the
 * employee has not WORKED at least thirty days for the employer in the
 * preceding twelve months. That is a days-worked test, not a length-of-service
 * one, and it is declared as such.
 *
 * NT s. 23(2) / NU s. 25(1): the holiday pay PLUS overtime pay for the hours
 * worked, or a substitute holiday.
 *
 * NOT transcribed: NT s. 23(3) and NU s. 26 require double the regular rate
 * where an employee who was NOT required to work the holiday is then required
 * to work another of their non-working days in the same week. That is an
 * overtime rule about a different day, not holiday pay, and it does not belong
 * in this declaration.
 */
const TERRITORIAL_HOLIDAY_PAY = {
  basis: {
    kind: "normal_day" as const,
    // "the average of his or her daily wages for the four weeks THE EMPLOYEE
    // WORKED immediately preceding the week in which the statutory holiday
    // occurs" — days worked.
    whenIrregular: {
      kind: "average_day" as const, lookbackWeeks: 4, counting: "worked" as const,
    },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: {
    // NT s. 23(7)(a) / NU s. 28(a): "has not WORKED at least 30 days for the
    // employer in the preceding 12 months" — a days-worked test.
    minDaysWorkedInWindow: { days: 30, ofDays: 365, counting: "worked" as const },
    lastAndFirstScheduledShift: true,
  },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // "…immediately preceding the WEEK in which the statutory holiday occurs".
  lookbackEnds: ENDS_WEEK_BEFORE,
};

const NT_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act (Northwest Territories), SNWT 2007 c 13, ss. 22–23",
  ...TERRITORIAL_HOLIDAY_PAY,
};

const NU_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Labour Standards Act (Nunavut), RSNWT (Nu) 1988 c L-1, ss. 24–28",
  ...TERRITORIAL_HOLIDAY_PAY,
};

/**
 * Prince Edward Island, Employment Standards Act, SPEI 2024 c 66, ss. 27–28.
 *
 * THE ACT TRANSCRIBED HERE STARTS ON 2026-06-30. It replaced RSPEI 1988
 * c E-6.2 (repealed by s. 105) and CHANGED the measure: the old Act paid a
 * regular day's pay, the new one pays a percentage. This declaration is
 * therefore an EDITION with `effectiveFrom: "2026-06-30"` and no earlier
 * sibling, so a Prince Edward Island holiday before that date resolves to no
 * edition at all and the run REFUSES by name. That is the correct answer and
 * not a gap being papered over: the repealed Act has not been transcribed, and
 * computing a June 2026 period on a formula that did not yet exist is wrong
 * money that nobody would ever see. Transcribing RSPEI 1988 c E-6.2 as a second
 * edition, `effectiveTo: "2026-06-29"`, is the whole of the fix when someone
 * has the repealed text in front of them.
 *
 * s. 28(1)(a): five per cent of the employee's wages, not including overtime
 * pay, earned in the four weeks before the paid holiday. s. 28(2) expressly
 * puts pay for vacation taken and pay for ANY OTHER PAID HOLIDAY in that window
 * into the base — the only jurisdiction in the country that says so out loud,
 * and the reason both inclusions are true here rather than inferred.
 *
 * s. 27(1): entitled unless the employee, without direction or permission and
 * without reasonable cause, failed to work BOTH the last work day before and
 * the first after — conjunctive, so missing one side alone does not disqualify.
 * The engine's `lastAndFirstScheduledShift` denial is asserted by the employer
 * in either case, so the conjunction is the employer's to apply.
 *
 * NO SERVICE QUALIFIER IS DECLARED, and that is a deliberate reading rather
 * than an omission: the new Act's own qualifying section states none, where the
 * repealed Act had one. If a qualifying period turns out to sit in the new
 * Employment Standards Regulations it belongs here and this comment is the
 * place it was missed.
 *
 * s. 27(3)(a): time and a half for the hours worked plus the paid holiday.
 * s. 27(3)(b) offers the employer the alternative of straight time plus a lieu
 * holiday, which is a scheduling election, not an amount.
 */
const PE_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act (Prince Edward Island), SPEI 2024 c 66, ss. 27–28 "
    + "(in force 2026-06-30; earlier periods are governed by the repealed RSPEI 1988 c E-6.2 "
    + "and are NOT transcribed)",
  basis: { kind: "percent_of_earnings", percent: "5", lookbackWeeks: 4 },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // s. 28(1)(a): "in the four weeks before the paid holiday".
  lookbackEnds: ENDS_DAY_BEFORE,
};

/**
 * Prince Edward Island's editions — the one jurisdiction in the country whose
 * holiday-pay measure changed inside this product's lifetime.
 *
 * There is deliberately NO edition before 2026-06-30. A PEI holiday earlier
 * than that resolves to nothing and refuses, naming the repealed Act; it does
 * not fall back to the new percentage, and it does not pay zero.
 */
const PE_HOLIDAY_PAY_EDITIONS: readonly PayrollHolidayPayEdition[] = [
  { effectiveFrom: "2026-06-30", effectiveTo: null, rule: PE_HOLIDAY_PAY },
];

/**
 * Yukon, Employment Standards Act, RSY 2002 c 72, ss. 29–31.
 *
 * The only jurisdiction in the country whose split is not "do the hours vary"
 * but "are the hours STANDARD". s. 30(1) pays a standard-hours employee an
 * average day's wages at the regular rate; s. 30(2) pays an employee who works
 * LESS THAN STANDARD HOURS OR IRREGULAR HOURS at least ten per cent of their
 * wages, excluding vacation pay, for the hours worked in the two-week period
 * immediately preceding the week of the holiday. Standard hours are eight in a
 * day and forty in a week, hence `minWeeklyHours: 40` — a settled, perfectly
 * regular twenty-hour week takes the percentage arm here and the normal-day arm
 * everywhere else in Canada, and that is the statute, not a rounding.
 *
 * The inclusions are Yukon's own and they are the mirror image of everyone
 * else's: overtime earned in the window IS included (the province's guidance
 * says so) and vacation pay is expressly excluded. The base is "wages for the
 * hours worked", so an earlier holiday's unworked pay is not in it either.
 *
 * s. 29: thirty calendar days of employment, and the last scheduled shift
 * before and the first after. Yukon's guidance is explicit that this gates the
 * UNWORKED holiday only — an employee with less than thirty days who actually
 * works the day still gets both the holiday pay and the overtime. That is not
 * expressible here: `minEmploymentDays` denies the whole day. A Yukon employee
 * inside their first month who works a general holiday is therefore under-paid
 * by this declaration, and it is named here rather than left to be discovered.
 *
 * s. 31: the overtime rate for the hours worked in addition to the s. 30 pay.
 */
const YT_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act (Yukon), RSY 2002 c 72, ss. 29–31",
  basis: {
    kind: "normal_day",
    minWeeklyHours: 40,
    whenIrregular: { kind: "percent_of_earnings", percent: "10", lookbackWeeks: 2 },
  },
  include: { overtime: true, vacationPay: false, holidayPay: false },
  qualifying: { minEmploymentDays: 30, lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
  // s. 30(2): "the two week period immediately preceding the WEEK in which the
  // general holiday occurs".
  lookbackEnds: ENDS_WEEK_BEFORE,
};

// --- Canadian jurisdictions ------------------------------------------------

export const CA_JURISDICTIONS: readonly PayrollJurisdiction[] = [
  {
    key: "CA",
    name: "Canada (federally regulated)",
    scope: "employment",
    citation: "Canada Labour Code, RSC 1985 c L-2, ss. 191–197",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY, LABOUR_DAY,
      TRUTH_AND_RECONCILIATION, THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      BOXING_DAY,
    ].map(federal),
    holidayPay: onlyEdition(CLC_HOLIDAY_PAY),
  },
  {
    key: "CA-ON",
    name: "Ontario",
    scope: "employment",
    citation: "Employment Standards Act, 2000 (Ontario), s. 1 'public holiday'",
    holidays: [
      NEW_YEARS,
      { key: "family_day", name: "Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none" },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY, LABOUR_DAY, THANKSGIVING_CA,
      CHRISTMAS, BOXING_DAY,
      // Not ESA public holidays. An Ontario employer may observe them, and
      // many do, but only by election — hence optional, not absent.
      { key: "civic_holiday", name: "Civic Holiday", rule: FIRST_MONDAY_AUGUST, observance: "none", optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
      { ...REMEMBRANCE_DAY, optional: true },
      { ...EASTER_MONDAY, optional: true },
    ],
    holidayPay: onlyEdition(ON_HOLIDAY_PAY),
  },
  {
    key: "CA-QC",
    name: "Quebec",
    scope: "employment",
    citation: "Act respecting labour standards (Quebec), s. 60; National Holiday Act, CQLR c F-1.1",
    holidays: [
      NEW_YEARS,
      // s. 60(2): Good Friday OR Easter Monday, at the employer's option. The
      // statutory default declared here is Good Friday; an employer that
      // chooses Easter Monday turns the optional day on and this one off.
      GOOD_FRIDAY,
      { ...EASTER_MONDAY, optional: true },
      { key: "national_patriots_day", name: "National Patriots' Day",
        rule: { kind: "weekday_before", month: 5, day: 25, weekday: 1 }, observance: "none" },
      { key: "st_jean_baptiste", name: "National Holiday (Saint-Jean-Baptiste)",
        rule: { kind: "fixed", month: 6, day: 24 }, observance: "none" },
      CANADA_DAY, LABOUR_DAY, THANKSGIVING_CA, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
      { ...REMEMBRANCE_DAY, optional: true },
    ],
    holidayPay: onlyEdition(QC_HOLIDAY_PAY),
  },
  {
    key: "CA-BC",
    name: "British Columbia",
    scope: "employment",
    citation: "Employment Standards Act (British Columbia), s. 1 'statutory holiday'",
    holidays: [
      NEW_YEARS,
      // Moved from the second to the THIRD Monday in February in 2019.
      { key: "family_day", name: "Family Day",
        rule: { kind: "nth_weekday", month: 2, weekday: 1, nth: 2 }, observance: "none", until: 2018 },
      { key: "family_day", name: "Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none", from: 2019 },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY,
      { key: "bc_day", name: "British Columbia Day", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY,
      // A BC statutory holiday from 2023 (Bill 2, 2023).
      { ...TRUTH_AND_RECONCILIATION, from: 2023 },
      THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: onlyEdition(BC_HOLIDAY_PAY),
  },
  {
    key: "CA-AB",
    name: "Alberta",
    scope: "employment",
    citation: "Employment Standards Code (Alberta), s. 1(1)(n) 'general holiday'",
    holidays: [
      NEW_YEARS,
      { key: "family_day", name: "Alberta Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none" },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY, LABOUR_DAY, THANKSGIVING_CA,
      REMEMBRANCE_DAY, CHRISTMAS,
      // Alberta's optional general holidays, listed by the Code itself.
      { ...EASTER_MONDAY, optional: true },
      { key: "heritage_day", name: "Heritage Day", rule: FIRST_MONDAY_AUGUST, observance: "none", optional: true },
      { ...BOXING_DAY, optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
    ],
    holidayPay: onlyEdition(AB_HOLIDAY_PAY),
  },
  {
    key: "CA-SK",
    name: "Saskatchewan",
    scope: "employment",
    citation: "The Saskatchewan Employment Act, s. 2-1(1)(o) 'public holiday'",
    holidays: [
      NEW_YEARS,
      { key: "family_day", name: "Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none" },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY,
      { key: "saskatchewan_day", name: "Saskatchewan Day", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY, THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
    ],
    holidayPay: onlyEdition(SK_HOLIDAY_PAY),
  },
  {
    key: "CA-MB",
    name: "Manitoba",
    scope: "employment",
    citation: "The Employment Standards Code (Manitoba), CCSM c E110, s. 21(1) 'general holiday'",
    holidays: [
      NEW_YEARS,
      { key: "louis_riel_day", name: "Louis Riel Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none" },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY, LABOUR_DAY,
      // s. 21(1)(e.1), added by S.M. 2023, c. 50 (Bill 4, royal assent
      // 2023-12-07): first observed as a general holiday on 2024-09-30.
      // s. 28(4) makes it the ONE general holiday an employer may not
      // substitute another day for — a fact this shape cannot carry, so an
      // employer that substitutes it is out of compliance in a way the payroll
      // engine will not catch.
      { ...TRUTH_AND_RECONCILIATION, name: "Orange Shirt Day (National Day for Truth and Reconciliation)", from: 2024 },
      THANKSGIVING_CA, CHRISTMAS,
      // Remembrance Day is deliberately ABSENT. It is not a general holiday
      // under the Code; The Remembrance Day Act, CCSM c R80 s. 3.4 governs it
      // and inverts the usual rule — an employee who does NOT work November 11
      // gets nothing, and one who DOES gets the general-holiday pay that would
      // have been payable plus the overtime rate on the greater of the hours
      // worked or half a normal day. No `holidayPay` shape can say that, and
      // declaring the day as an ordinary Manitoba general holiday would pay
      // every employee who stayed home a day's wages the law does not require.
      // An employer that closes may add it as a company holiday.
      // Not general holidays in Manitoba: Boxing Day, Easter Monday, and the
      // first Monday in August.
    ],
    holidayPay: onlyEdition(MB_HOLIDAY_PAY),
  },
  {
    key: "CA-NB",
    name: "New Brunswick",
    scope: "employment",
    citation: "Employment Standards Act (New Brunswick), SNB 1982 c E-7.2, s. 1 'public holiday'",
    holidays: [
      NEW_YEARS,
      // New Brunswick Family Day, first observed in 2018.
      { key: "family_day", name: "Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none", from: 2018 },
      GOOD_FRIDAY, CANADA_DAY,
      { key: "new_brunswick_day", name: "New Brunswick Day", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY,
      // Unlike Manitoba and Nova Scotia, Remembrance Day IS a public holiday
      // under New Brunswick's employment standards and carries holiday pay.
      REMEMBRANCE_DAY, CHRISTMAS,
      // Not public holidays in New Brunswick: Victoria Day, Thanksgiving,
      // Boxing Day, Easter Monday, and September 30. An employer may observe
      // any of them, so they are electable rather than absent.
      { ...VICTORIA_DAY, optional: true },
      { ...THANKSGIVING_CA, optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: onlyEdition(NB_HOLIDAY_PAY),
  },
  {
    key: "CA-NL",
    name: "Newfoundland and Labrador",
    scope: "employment",
    citation: "Labour Standards Act (Newfoundland and Labrador), RSNL 1990 c L-2, s. 14(1)",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY,
      // July 1 is Memorial Day in Newfoundland and Labrador, commemorating
      // Beaumont-Hamel. Same date as Canada Day, different day.
      { key: "memorial_day", name: "Memorial Day", rule: { kind: "fixed", month: 7, day: 1 }, observance: "none" },
      LABOUR_DAY, REMEMBRANCE_DAY, CHRISTMAS,
      // s. 14(1) lists six and no more. Victoria Day, Thanksgiving, Boxing Day,
      // Easter Monday, the Regatta and the provincial closure days in the Shops
      // Closing Act are not paid public holidays here — several are closure
      // days with no pay attached, which is why they are electable and not
      // declared. September 30 binds federally regulated employers in the
      // province but not provincially regulated ones.
      { ...VICTORIA_DAY, optional: true },
      { ...THANKSGIVING_CA, optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: onlyEdition(NL_HOLIDAY_PAY),
  },
  {
    key: "CA-NS",
    name: "Nova Scotia",
    scope: "employment",
    citation: "Labour Standards Code (Nova Scotia), RSNS 1989 c 246, s. 2(ga) 'holiday'",
    holidays: [
      NEW_YEARS,
      // s. 2(ga) states the recurrence and not the name; the day is called
      // Nova Scotia Heritage Day. First observed 2015.
      { key: "heritage_day", name: "Nova Scotia Heritage Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none", from: 2015 },
      GOOD_FRIDAY, CANADA_DAY, LABOUR_DAY, CHRISTMAS,
      // Six, and the thinnest list in the country. Remembrance Day is ABSENT
      // for the same reason as in Manitoba: the Remembrance Day Act, RSNS 1989
      // c 396 is a business-closing statute, and its pay rule is inverted — an
      // employee who does not work November 11 gets NOTHING, and one who does,
      // and who was paid for fifteen of the preceding thirty days, may get
      // another day off with pay. Declaring it here would pay a day's wages the
      // Code does not require.
      // Natal Day (the first Monday in August) is NOT a general holiday in Nova
      // Scotia, and neither are Victoria Day, Thanksgiving, Boxing Day, Easter
      // Monday or September 30. All are electable.
      { ...VICTORIA_DAY, optional: true },
      { key: "natal_day", name: "Natal Day", rule: FIRST_MONDAY_AUGUST, observance: "none", optional: true },
      { ...THANKSGIVING_CA, optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: onlyEdition(NS_HOLIDAY_PAY),
  },
  {
    key: "CA-NT",
    name: "Northwest Territories",
    scope: "employment",
    citation: "Employment Standards Act (Northwest Territories), SNWT 2007 c 13, s. 22(1)",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, VICTORIA_DAY,
      // A full statutory holiday in the Northwest Territories since 2001 — one
      // of only two jurisdictions where June 21 binds private employers.
      { key: "national_indigenous_peoples_day", name: "National Indigenous Peoples Day",
        rule: { kind: "fixed", month: 6, day: 21 }, observance: "none" },
      CANADA_DAY,
      // s. 22(1)(f) names no day, only "the first Monday in August".
      { key: "august_civic_holiday", name: "August Civic Holiday", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY,
      // s. 22(1)(g.1), in force 2022-06-03, so first observed 2022-09-30.
      { ...TRUTH_AND_RECONCILIATION, from: 2022 },
      THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: onlyEdition(NT_HOLIDAY_PAY),
  },
  {
    key: "CA-NU",
    name: "Nunavut",
    scope: "employment",
    citation: "Labour Standards Act (Nunavut), RSNWT (Nu) 1988 c L-1, s. 1 'general holiday'",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY,
      // Nunavut's statute names no "Victoria Day": it is the day fixed by the
      // Governor General for the observance of the reigning sovereign's
      // birthday, which is in practice the Monday preceding May 25.
      { ...VICTORIA_DAY, name: "Sovereign's Birthday (Victoria Day)" },
      CANADA_DAY,
      // Added by Bill 29 (assent 2019-11-29); first observed as a territorial
      // statutory holiday on 2020-07-09. It bound Government of Nunavut
      // employees before that, which is not the same thing.
      { key: "nunavut_day", name: "Nunavut Day", rule: { kind: "fixed", month: 7, day: 9 }, observance: "none", from: 2020 },
      { key: "august_civic_holiday", name: "August Civic Holiday", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY,
      { ...TRUTH_AND_RECONCILIATION, from: 2022 },
      THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: onlyEdition(NU_HOLIDAY_PAY),
  },
  {
    key: "CA-PE",
    name: "Prince Edward Island",
    scope: "employment",
    citation: "Employment Standards Act (Prince Edward Island), SPEI 2024 c 66, s. 1(n) 'paid holiday'",
    holidays: [
      NEW_YEARS,
      // Islander Day, first observed in 2009 on the SECOND Monday in February
      // and moved to the third for 2010 to line up with the rest of the
      // country. Both are declared, the same way British Columbia's Family Day
      // move is, so a historical calendar reproduces the day it actually was.
      { key: "islander_day", name: "Islander Day",
        rule: { kind: "nth_weekday", month: 2, weekday: 1, nth: 2 }, observance: "none",
        from: 2009, until: 2009 },
      { key: "islander_day", name: "Islander Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none", from: 2010 },
      GOOD_FRIDAY,
      // The new Act says "July 1" and drops the words "Canada Day".
      CANADA_DAY, LABOUR_DAY,
      // Added to the repealed Act by Bill 22 in force 2021-11-17 and carried
      // into s. 1(n)(vi) of the new one. PEI was among the first provinces to
      // bind private employers to September 30.
      { ...TRUTH_AND_RECONCILIATION, from: 2021 },
      REMEMBRANCE_DAY, CHRISTMAS,
      // Not paid holidays in PEI: Victoria Day, Thanksgiving, Boxing Day,
      // Easter Monday, the August civic day.
      { ...VICTORIA_DAY, optional: true },
      { ...THANKSGIVING_CA, optional: true },
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: PE_HOLIDAY_PAY_EDITIONS,
  },
  {
    key: "CA-YT",
    name: "Yukon",
    scope: "employment",
    citation: "Employment Standards Act (Yukon), RSY 2002 c 72, s. 1(1) 'general holiday'",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, VICTORIA_DAY,
      // Added to the ESA definition by the National Aboriginal Day Act,
      // SY 2017 c 1, and later renamed. Yukon and the Northwest Territories are
      // the only jurisdictions where June 21 is a statutory holiday.
      { key: "national_indigenous_peoples_day", name: "National Indigenous Peoples Day",
        rule: { kind: "fixed", month: 6, day: 21 }, observance: "none", from: 2017 },
      CANADA_DAY,
      // Discovery Day is the THIRD Monday in August. Yukon has no first-Monday
      // civic holiday, and getting this wrong moves a paid day by a fortnight.
      { key: "discovery_day", name: "Discovery Day",
        rule: { kind: "nth_weekday", month: 8, weekday: 1, nth: 3 }, observance: "none" },
      LABOUR_DAY,
      // Legislated by Bill 305 (assent 2022-11-24); first observed 2023-09-30.
      { ...TRUTH_AND_RECONCILIATION, from: 2023 },
      THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      // Yukon Heritage Day (the last Friday in February) binds Yukon government
      // employees ONLY and is not a general holiday — a common and expensive
      // mistake. Declared electable so an employer that observes it can say so.
      { key: "heritage_day", name: "Yukon Heritage Day",
        rule: { kind: "nth_weekday", month: 2, weekday: 5, nth: -1 }, observance: "none", optional: true },
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: onlyEdition(YT_HOLIDAY_PAY),
  },
  {
    /**
     * The CRA's OWN office calendar, which is not any employment-standards
     * calendar: it carries Easter Monday and the Civic Holiday, which no
     * province's ESA lists, and it is the calendar a remittance due date moves
     * against ("a public holiday recognized by the CRA"). Declaring it as a
     * jurisdiction keeps the tax administration's calendar from being confused
     * with an employer's — they genuinely differ, and using one for the other
     * is how a remittance lands a day late.
     *
     * It pays nobody: `holidayPay: null` says the CRA calendar mandates no
     * employee entitlement, which is true — it is a due-date calendar.
     */
    key: "CA-CRA",
    name: "Canada Revenue Agency (remittance due dates)",
    scope: "tax_administration",
    citation: "https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, EASTER_MONDAY, VICTORIA_DAY, CANADA_DAY,
      { key: "civic_holiday", name: "Civic Holiday", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY, TRUTH_AND_RECONCILIATION, THANKSGIVING_CA, REMEMBRANCE_DAY,
      CHRISTMAS, BOXING_DAY,
    ],
    holidayPay: null,
  },
  {
    /** The CRA calendar as it applies in Quebec: Saint-Jean-Baptiste Day is
     *  recognized there and the Civic Holiday is not. */
    key: "CA-CRA-QC",
    name: "Canada Revenue Agency — Quebec (remittance due dates)",
    scope: "tax_administration",
    citation: "https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, EASTER_MONDAY, VICTORIA_DAY,
      { key: "st_jean_baptiste", name: "Saint-Jean-Baptiste Day",
        rule: { kind: "fixed", month: 6, day: 24 }, observance: "none" },
      CANADA_DAY, LABOUR_DAY, TRUTH_AND_RECONCILIATION, THANKSGIVING_CA,
      REMEMBRANCE_DAY, CHRISTMAS, BOXING_DAY,
    ],
    holidayPay: null,
  },
] as const;
