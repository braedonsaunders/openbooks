import { readPayrollPriorEarnings } from "./prior-earnings.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { addCalendarDays, calendarDaysBetween } from "../platform/business-date.ts";
import { add, cmp, mulDecimalFactors, roundMoney } from "../money/money.ts";
import {
  employmentJurisdictionsOf,
  holidayPayLookbackBasis,
  payrollJurisdictionDeclared,
  type PayrollHolidayDayCounting,
  type PayrollHolidayPayRule,
} from "./packs.ts";
import { isScheduledOn, resolveWorkSchedule, type ResolvedWorkSchedule } from "./work-schedules.ts";
import {
  PayrollHolidayError,
  weekdayOf,
  resolveObservedHolidays,
  loadHolidayOverrides,
  type ObservedHoliday,
} from "./holiday-calendar.ts";
import {
  statutoryHolidayPayRule,
  describeDayCounting,
  type HolidayLookbackEarnings,
} from "./holiday-pay-computation.ts";
import type { StatutoryHolidayPayInput } from "./holiday-pay-eligibility.ts";

/** Holiday-pay lookback windows, stub-earnings attribution, and qualifying-day evidence. */

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
  if (boundary.kind === "day_before") return addCalendarDays(holidayDate, -1);
  // Back up to the first day of the holiday's own week, then take the day
  // before it: the last day of the preceding week.
  const weekStartsOn = employerWeekStartsOn ?? boundary.weekStartsOn;
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new PayrollHolidayError(`invalid employer work-week start day: ${weekStartsOn}`);
  }
  const intoWeek = (weekdayOf(holidayDate) - weekStartsOn + 7) % 7;
  return addCalendarDays(holidayDate, -(intoWeek + 1));
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
  // A `normal_day` rule with no declared fallback has no pay window: the
  // holiday date itself keeps the evidence-window math total, and the amount
  // path refuses before it ever reads earnings from it.
  if (!basis) return { from: holidayDate, to: holidayDate };
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
  from: addCalendarDays(to, -(days - 1)),
  to,
});

/** The commission earner's own window, on the same boundary as the rule's. */
export const commissionWindowOf = (
  rule: PayrollHolidayPayRule,
  holidayDate: string,
  weeks: number,
  employerWeekStartsOn?: number,
) => spanBefore(lookbackWindowEnd(rule, holidayDate, employerWeekStartsOn), weeks * 7);

/** Earnings from committed stubs. Categories follow component keys, which
 *  makes Ontario's wage exclusions a transcription rather than a guess. */
/**
 * Attribute one undated stub's earnings to the lookback window by
 * calendar-day overlap with its pay period. Every statute behind the pack
 * frames the window as a calendar span — Ontario's "regular wages earned in
 * the four work weeks before the work week" (ESA 2000 s. 24(1)(a)), British
 * Columbia's "gross earnings in the 30 calendar days before", Alberta's
 * average over the same four weeks — and none of them gives a daily split
 * for a stub whose lines carry no earned dates. The even spread is the only
 * auditable estimate, rounded once to the ledger quantum; each rule's own
 * averaging basis still governs the divisor, so only the window sum is
 * estimated, never the average itself. A stub fully inside the window
 * attributes its full amount, exactly as before.
 */
export function attributeStubEarningsToWindow(
  amount: string,
  periodStart: string,
  periodEnd: string,
  window: { from: string; to: string },
): { attributed: string; overlapDays: number; periodDays: number } {
  const overlapFrom = periodStart > window.from ? periodStart : window.from;
  const overlapTo = periodEnd < window.to ? periodEnd : window.to;
  const overlapDays = calendarDaysBetween(overlapFrom, overlapTo) + 1;
  const periodDays = calendarDaysBetween(periodStart, periodEnd) + 1;
  if (overlapDays <= 0 || periodDays <= 0) {
    return { attributed: "0.0000", overlapDays: 0, periodDays: Math.max(periodDays, 0) };
  }
  if (periodStart >= window.from && periodEnd <= window.to) {
    return { attributed: roundMoney(amount, 4), overlapDays, periodDays };
  }
  return {
    attributed: mulDecimalFactors(amount, [], {
      numerator: BigInt(overlapDays),
      denominator: BigInt(periodDays),
      decimalPlaces: 4,
    }),
    overlapDays,
    periodDays,
  };
}

export async function lookbackEarnings(
  tx: Pick<typeof db, "execute">,
  input: Pick<StatutoryHolidayPayInput, "orgId" | "employeePartyId" | "excludeDocumentId">,
  window: { from: string; to: string },
): Promise<{ earnings: HolidayLookbackEarnings; proratedPeriods: string[] }> {
  const rows = await tx.execute<{
    system_key: string;
    amount: string;
    earned_from: string | Date | null;
    earned_to: string | Date | null;
    period_start: string | Date | null;
    period_end: string | Date | null;
  }>(
    sql`
    select coalesce(c.system_key, '') as system_key, l.amount,
           l.earned_from, l.earned_to,
           r.period_start, r.period_end
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents historical_document on historical_document.org_id=r.org_id and historical_document.id=r.document_id
      join documents current_document on current_document.org_id=r.org_id and current_document.id=${input.excludeDocumentId}
        and historical_document.subsidiary_id=current_document.subsidiary_id
        and historical_document.currency=current_document.currency
      left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
       and l.kind = 'earning'
       and s.pay_run_document_id <> ${input.excludeDocumentId}
       and r.period_start <= ${window.to} and r.period_end >= ${window.from}
  `,
    "objects",
  );

  // A stub whose own pay period is unknown cannot be placed in the window at
  // all: that stays a refusal, because no span exists to attribute across.
  // Everything else with a period is attributable — dated lines exactly,
  // undated spans by calendar-day overlap (see
  // attributeStubEarningsToWindow), so a straddling undated stub estimates
  // instead of refusing.
  const unknownPeriod = rows.filter((row) => row.period_start == null || row.period_end == null);
  if (unknownPeriod.length > 0) {
    throw new PayrollHolidayError(
      `${input.employeePartyId}: statutory holiday lookback earnings overlap ${window.from} through ${window.to}, but a committed pay stub has no pay period recorded; correct the pay stub before calculating holiday pay`,
    );
  }
  const totals = await readPayrollPriorEarnings(tx, input, window);
  const proratedPeriods: string[] = [];
  for (const row of rows) {
    const day = (value: string | Date) =>
      String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
    // Refused above when unknown; the guard narrows the type for the rest.
    if (row.period_start == null || row.period_end == null) continue;
    const periodStart = day(row.period_start);
    const periodEnd = day(row.period_end);
    const earnedFrom = row.earned_from == null ? null : day(row.earned_from);
    const earnedTo = row.earned_to == null ? null : day(row.earned_to);
    let amount: string;
    if (earnedFrom === null || earnedTo === null) {
      const attributed = attributeStubEarningsToWindow(row.amount, periodStart, periodEnd, window);
      if (attributed.overlapDays <= 0) continue;
      if (!(periodStart >= window.from && periodEnd <= window.to)) {
        proratedPeriods.push(`${periodStart} through ${periodEnd}`);
      }
      amount = attributed.attributed;
    } else {
      const earningOverlaps = earnedFrom <= window.to && earnedTo >= window.from;
      if (!earningOverlaps) continue;
      if (earnedFrom < window.from || earnedTo > window.to) {
        // An earning dated across the boundary (a salary earned over its
        // whole pay period) is earned evenly over its own dates: the window
        // takes its calendar-day share, recorded as a proration, the same
        // attribution an undated stub receives over its pay period.
        const attributed = attributeStubEarningsToWindow(row.amount, earnedFrom, earnedTo, window);
        if (attributed.overlapDays <= 0) continue;
        proratedPeriods.push(`${earnedFrom} through ${earnedTo}`);
        amount = attributed.attributed;
      } else {
        amount = roundMoney(row.amount, 4);
      }
    }

    const bucket: keyof HolidayLookbackEarnings =
      row.system_key === "overtime"
        ? "overtime"
        : row.system_key === "vacation_payout"
          ? "vacationPay"
          : row.system_key === "stat_holiday" || row.system_key === "stat_holiday_premium"
            ? "holidayPay"
            : "regular";
    totals[bucket] = add(totals[bucket], amount);
  }
  return { earnings: totals, proratedPeriods: [...new Set(proratedPeriods)] };
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
        `${input.employee}: this jurisdiction counts the days on which the employee ` +
          `${describeDayCounting(counting).toUpperCase()}, and ${from} to ${to} was paid with no ` +
          "hours recorded at all — a salary, or leave paid from a bank. Which of those days were " +
          "working days is not something this " +
          (schedule ? "employee's 'hours vary' schedule can answer" : "calculation has been told") +
          ". Record the hours and days they are normally scheduled to work, or record the leave " +
          "as time entries. It will not assume a working week it has not been told about",
      );
    }
    for (let cursor = from; cursor <= to; cursor = addCalendarDays(cursor, 1)) {
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
  const worked = await tx.execute<{ worked_on: string | Date }>(
    sql`
    select distinct worked_on
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and hours > 0
       and worked_on between ${window.from} and ${window.to}
  `,
    "objects",
  );

  const day = (value: string | Date) =>
    String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  const workedOn = worked.map((row) => day(row.worked_on));
  if (!needsPaidDays) {
    return { workedOn, paidPeriodsWithoutHours: [], paidHolidays: [] };
  }

  // Sequential reads: the run calculation passes its transaction client,
  // which is one pg connection — fanning out queues concurrent queries on it.
  const earned = await tx.execute<{ earned_on: string | Date }>(
    sql`
      select l.earned_from as earned_on
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       where l.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
         and r.run_status = 'committed' and s.pay_run_document_id <> ${input.excludeDocumentId}
         and l.kind = 'earning' and l.earned_from = l.earned_to
         and l.earned_from between ${window.from} and ${window.to}
       group by l.earned_from having sum(l.amount) > 0`,
    "objects",
  );
  const owed = await tx.execute<{ on_date: string | Date }>(
    sql`
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
                          where reversal.org_id = a.org_id and reversal.reversal_of = a.id)`,
    "objects",
  );

  // One row per committed stub overlapping the window, with the hours and the
  // earnings on it. The classification is done here rather than in SQL so the
  // rule ("paid for the period, not for hours") is readable beside the comment
  // that justifies it.
  const stubs = await tx.execute<{
    period_start: string | Date;
    period_end: string | Date;
    hours: string;
    earnings: string;
    holiday_pay: string;
  }>(
    sql`
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
  `,
    "objects",
  );

  const paidPeriodsWithoutHours: { from: string; to: string }[] = [];
  const holidayPaidPeriods: { from: string; to: string }[] = [];
  for (const row of stubs) {
    const period = { from: day(row.period_start), to: day(row.period_end) };
    if (cmp(row.hours, "0") === 0 && cmp(row.earnings, "0") > 0) {
      paidPeriodsWithoutHours.push(period);
    }
    if (cmp(row.holiday_pay, "0") !== 0) holidayPaidPeriods.push(period);
  }

  const paidHolidays = observedInWindow
    .filter((holiday) => holiday.paid)
    .filter((holiday) =>
      holidayPaidPeriods.some((p) => p.from <= holiday.date && p.to >= holiday.date),
    )
    .map((holiday) => holiday.date);

  return {
    workedOn,
    earnedOn: earned.map((row) => day(row.earned_on)),
    owedPaidOn: owed.map((row) => day(row.on_date)),
    paidPeriodsWithoutHours,
    paidHolidays,
  };
}

/** The current, independently computed count a run-specific assertion attests. */
export async function evidencedEntitledPayDays(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    employeePartyId: string;
    employeeName: string;
    excludeDocumentId: string;
    jurisdiction: string;
    holidayDate: string;
  },
): Promise<number> {
  const rule = statutoryHolidayPayRule(input.jurisdiction, input.holidayDate);
  const qualifier = rule?.qualifying.minDaysWorkedInWindow;
  if (qualifier?.counting !== "entitled_to_pay") {
    throw new PayrollHolidayError(
      `${input.jurisdiction} does not declare an entitlement-to-pay day assessment on ${input.holidayDate}`,
    );
  }
  const window = spanBefore(addCalendarDays(input.holidayDate, -1), qualifier.ofDays);
  const overrides = await loadHolidayOverrides(tx, input.orgId, input.jurisdiction);
  const observed = resolveObservedHolidays({
    jurisdiction: input.jurisdiction,
    from: window.from,
    to: window.to,
    overrides,
  });
  const schedule = await resolveWorkSchedule(
    tx,
    input.orgId,
    input.employeePartyId,
    input.holidayDate,
  );
  const evidence = await loadHolidayDayEvidence(tx, input, window, observed, true);
  return countHolidayQualifyingDays({
    employee: input.employeeName,
    window,
    counting: "entitled_to_pay",
    evidence,
    schedule,
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
  const rows = await tx.execute<{ hours: string }>(
    sql`
    select coalesce(sum(hours), 0)::text as hours
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and worked_on = ${date}
  `,
    "objects",
  );
  return roundMoney(rows[0]?.hours ?? "0", 2);
}

/** Approved time in a statute's average-hours lookback; timesheets own hours. */
export async function hoursWorkedInLookback(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  window: { from: string; to: string },
): Promise<string> {
  const rows = await tx.execute<{ hours: string }>(
    sql`
    select coalesce(sum(hours), 0)::text as hours
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and hours > 0
       and worked_on between ${window.from} and ${window.to}
  `,
    "objects",
  );
  return rows[0]?.hours ?? "0";
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
      const name = [...entry.names.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]![0];
      first = { name, date };
    }
  }
  if (!first) return null;
  return {
    jurisdiction,
    holidayName: first.name,
    date: first.date,
    message:
      `statutory holiday pay is enabled and ${first.name} (${first.date}) falls in this pay ` +
      `period, but no payroll pack declares a statutory holiday calendar or pay formula for ` +
      `${jurisdiction} — this jurisdiction is not yet supported by any payroll pack; contact ` +
      "support, or turn statutory holiday pay off in Payroll setup",
  };
}
