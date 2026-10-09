import type { ContractorWithholdingSchemeDefinition, ContractorWithholdingRemittanceSchedule } from "../country-tax-packs/index.ts";
import { cmp } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { addCalendarDays, civilDateFromParts, parseIsoDate } from "../platform/civil-date.ts";
import { ContractorWithholdingError } from "./scheme.ts";

/** Authority-confirmed non-business days, including exceptional filing/deposit extensions. */
export interface WithholdingRemittanceCalendar {
  from: string;
  to: string;
  closedDates: readonly string[];
  /** Published authority calendar; employer closure calendars cannot defer tax deadlines. */
  sourceReference: string;
}

export interface SchemeRemittanceDueInput {
  scheme: ContractorWithholdingSchemeDefinition;
  enrollmentSchedule: string;
  paidOn: string;
  /** Outstanding withholding in the current deposit period, including every Form 945 category. */
  accumulatedLiability: string;
  calendar: WithholdingRemittanceCalendar;
  /** Form 945 total tax from the second preceding calendar year. */
  lookback?: { taxYear: number; totalTax: string };
  /** Records a prior $100,000 next-day event; applies through the following calendar year. */
  nextDayEventOn?: string | null;
  /** Annual-payment election is available only for a complete, finalized all-category annual liability. */
  finalAnnualLiability?: { taxYear: number; totalTax: string };
}

export interface SchemeRemittanceDue {
  scheduleCode: string;
  dueDate: string;
  nextScheduleCode?: string;
  nextScheduleEffectiveFrom?: string;
  reason: "monthly" | "semiweekly" | "next_business_day" | "mandatory_cutoff" | "annual_small_liability";
}

function amount(value: string, label: string): string {
  if (canonicalDecimal(value, 4) === null || cmp(value, "0") < 0) {
    throw new ContractorWithholdingError(`${label} must be an exact nonnegative amount`);
  }
  return value;
}

function scheduleOn(input: SchemeRemittanceDueInput): ContractorWithholdingRemittanceSchedule {
  const schedules = (input.scheme.remittanceSchedules ?? []).filter((schedule) =>
    schedule.code === input.enrollmentSchedule && schedule.effectiveFrom <= input.paidOn &&
    (!schedule.effectiveTo || schedule.effectiveTo >= input.paidOn));
  if (schedules.length !== 1) throw new ContractorWithholdingError("Select a remittance schedule in force on the payment date in Setup → Withholding enrollments.");
  return schedules[0]!;
}

function calendarTools(calendar: WithholdingRemittanceCalendar, country: string) {
  if (!calendar.sourceReference?.trim()) throw new ContractorWithholdingError("The remittance calendar requires its published authority source reference.");
  parseIsoDate(calendar.from); parseIsoDate(calendar.to);
  if (calendar.from > calendar.to) throw new ContractorWithholdingError("The authority remittance calendar has an invalid coverage period.");
  const closed = new Set(calendar.closedDates);
  for (const date of closed) parseIsoDate(date);
  if (country === "US") {
    // IRS legal holidays include District of Columbia Emancipation Day.
    for (let year = Number(calendar.from.slice(0, 4)); year <= Number(calendar.to.slice(0, 4)); year++) {
      const nominal = civilDateFromParts(year, 4, 16);
      const weekday = parseIsoDate(nominal).getUTCDay();
      const observed = addCalendarDays(nominal, weekday === 6 ? -1 : weekday === 0 ? 1 : 0);
      if (observed >= calendar.from && observed <= calendar.to && !closed.has(observed)) throw new ContractorWithholdingError("The IRS calendar must include observed District of Columbia Emancipation Day.", "Confirm IRS legal holidays rather than employer closure dates in the enrollment calendar.");
    }
  }
  const businessDay = (date: string): boolean => {
    if (date < calendar.from || date > calendar.to) throw new ContractorWithholdingError("The authority remittance calendar does not cover the due date.", "Extend the confirmed calendar before preparing the remittance.");
    const weekday = parseIsoDate(date).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !closed.has(date);
  };
  const rollForward = (date: string): string => {
    let due = date;
    while (!businessDay(due)) due = addCalendarDays(due, 1);
    return due;
  };
  const followingBusinessDays = (date: string, count: number): string => {
    let due = date;
    let remaining = count;
    while (remaining > 0) {
      due = addCalendarDays(due, 1);
      if (businessDay(due)) remaining -= 1;
    }
    return due;
  };
  return { rollForward, followingBusinessDays };
}

/** Resolve a deposit deadline from the effective scheme, explicit payer election and exact liability evidence. */
export function resolveSchemeRemittanceDue(input: SchemeRemittanceDueInput): SchemeRemittanceDue {
  const paid = parseIsoDate(input.paidOn);
  const year = paid.getUTCFullYear();
  const month = paid.getUTCMonth() + 1;
  const schedule = scheduleOn(input);
  const liability = amount(input.accumulatedLiability, "Accumulated remittance liability");
  const calendar = calendarTools(input.calendar, input.scheme.country);
  const monthly = (day: number): string => {
    let nominal = civilDateFromParts(year, month + 1, day);
    // Italy suspends ordinary August remittances through 20 August.
    if (input.scheme.country === "IT" && nominal.slice(5, 10) === "08-16") nominal = `${year}-08-20`;
    return calendar.rollForward(nominal);
  };
  if (schedule.kind === "monthly") {
    if (!schedule.dayOfMonth) throw new ContractorWithholdingError("The remittance schedule declares no monthly due day.");
    return { scheduleCode: schedule.code, dueDate: monthly(schedule.dayOfMonth), reason: "monthly" };
  }
  if (schedule.kind === "italian_accumulated") {
    if (!schedule.accumulationThreshold || !schedule.mandatoryCutoffs?.length) throw new ContractorWithholdingError("The accumulated remittance schedule is incomplete.");
    const cutoffDates = [year, year + 1].flatMap((cutoffYear) =>
      schedule.mandatoryCutoffs!.map((cutoff) => civilDateFromParts(cutoffYear, cutoff.month, cutoff.day)))
      // December–May withholding clears in June; June–November clears in December.
      .sort().filter((date) => date.slice(0, 7) > input.paidOn.slice(0, 7));
    const cutoff = calendar.rollForward(cutoffDates[0]!);
    const crossesThreshold = cmp(liability, schedule.accumulationThreshold) >= 0;
    const monthAfter = crossesThreshold ? monthly(16) : cutoff;
    return {
      scheduleCode: schedule.code,
      dueDate: crossesThreshold && monthAfter < cutoff ? monthAfter : cutoff,
      reason: crossesThreshold && monthAfter < cutoff ? "monthly" : "mandatory_cutoff",
    };
  }
  // The next-day rule applies before either the monthly/semiweekly or small-liability election.
  if (cmp(liability, "100000") >= 0) {
    return { scheduleCode: schedule.code, dueDate: calendar.followingBusinessDays(input.paidOn, 1), reason: "next_business_day",
      nextScheduleCode: "US_SEMIWEEKLY", nextScheduleEffectiveFrom: addCalendarDays(input.paidOn, 1) };
  }
  let semiweekly = false;
  if (input.nextDayEventOn) {
    parseIsoDate(input.nextDayEventOn);
    const eventYear = Number(input.nextDayEventOn.slice(0, 4));
    semiweekly = input.nextDayEventOn < input.paidOn && year <= eventYear + 1;
  }
  if (schedule.kind === "us_annual_small_liability") {
    const annual = input.finalAnnualLiability;
    if (!annual || annual.taxYear !== year || cmp(amount(annual.totalTax, "Final annual Form 945 liability"), "2500") >= 0) {
      throw new ContractorWithholdingError("Annual Form 945 payment requires finalized all-category liability below $2,500 for this tax year.", "Select the applicable deposit schedule until the full annual liability is finalized.");
    }
    return { scheduleCode: schedule.code, dueDate: calendar.rollForward(civilDateFromParts(year + 1, 1, 31)), reason: "annual_small_liability" };
  }
  if (!input.lookback || input.lookback.taxYear !== year - 2) throw new ContractorWithholdingError("Form 945 deposit determination requires the second preceding year's total Form 945 tax.");
  semiweekly ||= cmp(amount(input.lookback.totalTax, "Lookback Form 945 tax"), "50000") > 0;
  if ((schedule.kind === "us_monthly" && semiweekly) || (schedule.kind === "us_semiweekly" && !semiweekly)) {
    throw new ContractorWithholdingError("The selected Form 945 deposit schedule disagrees with its lookback and next-day event evidence.");
  }
  if (!semiweekly) return { scheduleCode: schedule.code, dueDate: monthly(15), reason: "monthly" };
  const weekday = paid.getUTCDay();
  // Wed–Fri payments close on Friday; Sat–Tue payments close on Tuesday.
  const periodEnd = addCalendarDays(input.paidOn, weekday >= 3 && weekday <= 5 ? 5 - weekday : (2 - weekday + 7) % 7);
  return { scheduleCode: schedule.code, dueDate: calendar.followingBusinessDays(periodEnd, 3), reason: "semiweekly" };
}
