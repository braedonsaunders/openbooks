import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, fromUnits, mulRatio, roundMoney, sum, toUnits } from "./money.ts";

/**
 * Scheduled hours — the hours and days an employee is NORMALLY scheduled to
 * work.
 *
 * A GENERIC employment attribute. Nothing in this file names a country, a
 * province, a statute or a payroll pack, and nothing in it may: "what hours
 * does this person normally work" is a fact about an employment, and every
 * employment-standards regime, scheduling report, capacity forecast and
 * leave-accrual rule that wants it wants the same fact. The payroll packs
 * DECLARE which formulas consume it (engine/src/payroll/packs.ts); this module
 * only answers the question.
 *
 * ---------------------------------------------------------------------------
 * WHY A CYCLE AND NOT A NUMBER
 * ---------------------------------------------------------------------------
 *
 * The obvious model is one `weekly_hours` column. It is not sufficient, and the
 * consuming formulas say so out loud. The two questions employment standards
 * actually ask are:
 *
 *   1. "what would this employee have earned on the day the holiday fell?"
 *   2. "did they work their scheduled shift before it and after it?"
 *
 * (1) needs the hours of a PARTICULAR DAY: a compressed week of four ten-hour
 * days owes ten hours for a holiday that lands on a working day and nothing for
 * one that lands on the fifth. 40 ÷ 5 would pay eight, which is wrong twice.
 * (2) needs to know WHICH days are working days, which a weekly total cannot
 * say at all.
 *
 * So the model is a repeating CYCLE of `cycleDays` days anchored on a date,
 * with the hours normally worked at each position. `cycleDays = 7` anchored on
 * a Sunday is the ordinary week and the position is the weekday; 14 is a
 * compressed fortnight; 8 is a four-on-four-off rotation that deliberately
 * never lines up with the week — which is precisely why seven weekday columns
 * would have been the wrong shape.
 *
 * `varies` is the other real answer: no regular schedule at all. It is a
 * POSITIVE declaration, distinct from having no schedule recorded, because
 * several statutes branch on exactly that fact ("where the employee's hours
 * vary, use the average rather than the day").
 *
 * ---------------------------------------------------------------------------
 * UNKNOWN IS NOT ZERO AND NOT EIGHT
 * ---------------------------------------------------------------------------
 *
 * `resolveWorkSchedule` returns `null` when nothing is recorded, which is true
 * of every employee in every existing tenant. `null` means UNKNOWN. A consumer
 * that needs the pattern must refuse by name; a consumer that does not must be
 * unaffected. There is no default pattern in this module, and adding one would
 * make an invented day's pay indistinguishable from a correct one.
 *
 * ---------------------------------------------------------------------------
 * RESOLUTION
 * ---------------------------------------------------------------------------
 *
 * Exactly the mechanism `labor-costing.ts` `resolveWage` and
 * `payroll-entitlements.ts` `pickPlanLimit` already use, because this product
 * resolves scoped effective-dated rules ONE way: a row competes only if its
 * scope key matches the employee, the most specific competing scope wins, and
 * within the winning scope the latest `effectiveFrom` ≤ the date takes it. The
 * date is the WORK DATE, never today.
 *
 * Shape follows the same house split: the decision kernel (`pickWorkSchedule`
 * and the pure readers below) takes rows and returns answers with no database
 * at all; the async functions are thin adapters that load rows and call it.
 *
 * Hours are decimals and go through money.ts. Never floats: 7.4-hour days
 * summed in binary floating point drift, and the drift lands in a day's pay.
 */

export class WorkScheduleError extends Error {}

// ---------------------------------------------------------------------------
// Civil-date arithmetic
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an ISO date as UTC midnight. Dates here are civil dates, never
 *  instants — a local-time Date would shift a cycle position for anyone west
 *  of Greenwich, which is a whole different day's hours. */
function at(date: string): Date {
  const parsed = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new WorkScheduleError(`not a date: "${date}"`);
  return parsed;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export const daysApart = (from: string, to: string): number =>
  Math.round((at(to).getTime() - at(from).getTime()) / DAY_MS);

export const shiftDay = (date: string, days: number): string =>
  isoDay(new Date(at(date).getTime() + days * DAY_MS));

/** 0 = Sunday … 6 = Saturday. */
export const weekdayIndex = (date: string): number => at(date).getUTCDay();

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** Resolution order for a scoped schedule row — most specific first. */
export type WorkScheduleScope =
  | "employee"
  | "job_title"
  | "trade"
  | "department"
  | "subsidiary"
  | "organization";

const SCOPE_RANK: Record<WorkScheduleScope, number> = {
  employee: 0, job_title: 1, trade: 2, department: 3, subsidiary: 4, organization: 5,
};

/**
 * `cycle` — a repeating pattern of days.
 * `varies` — no regular schedule; the employee's hours are set period by
 * period. DECLARED, never inferred, and never the same as an absent row.
 */
export type WorkPattern = "cycle" | "varies";

/** Hours normally worked at one position of the cycle. */
export interface WorkScheduleDay {
  /** 0 … cycleDays − 1. For a weekly cycle anchored on a Sunday, the weekday. */
  dayIndex: number;
  hours: string;
}

/** A schedule row as loaded, before scope resolution. */
export interface WorkScheduleRow {
  id: string;
  name: string | null;
  employeePartyId: string | null;
  jobTitle: string | null;
  tradeId: string | null;
  departmentId: string | null;
  subsidiaryId: string | null;
  pattern: WorkPattern;
  cycleDays: number | null;
  cycleAnchor: string | null;
  days: readonly WorkScheduleDay[];
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

/** The row that won, plus the scope it won on. */
export interface ResolvedWorkSchedule {
  id: string;
  name: string | null;
  scope: WorkScheduleScope;
  pattern: WorkPattern;
  cycleDays: number | null;
  cycleAnchor: string | null;
  days: readonly WorkScheduleDay[];
  effectiveFrom: string;
}

/** The employee facts a scope key is matched against. Mirrors
 *  `EntitlementScopeKeys`; one scoping vocabulary in this product, not two. */
export interface WorkScheduleScopeKeys {
  employeePartyId: string;
  jobTitle?: string | null;
  tradeId?: string | null;
  departmentId?: string | null;
  subsidiaryId?: string | null;
}

const scopeOf = (row: WorkScheduleRow): WorkScheduleScope =>
  row.employeePartyId !== null ? "employee"
  : row.jobTitle !== null ? "job_title"
  : row.tradeId !== null ? "trade"
  : row.departmentId !== null ? "department"
  : row.subsidiaryId !== null ? "subsidiary"
  : "organization";

/**
 * The schedule in force for an employee on a date, or null when none is —
 * PURE, so the resolution order is verifiable with no database.
 *
 * Null is UNKNOWN, not "works no hours". Callers that need the pattern refuse;
 * callers that do not are unaffected.
 */
export function pickWorkSchedule(
  rows: readonly WorkScheduleRow[],
  employee: WorkScheduleScopeKeys,
  onDate: string,
): ResolvedWorkSchedule | null {
  let best: { row: WorkScheduleRow; scope: WorkScheduleScope } | null = null;
  for (const row of rows) {
    if (!row.isActive) continue;
    if (row.effectiveFrom > onDate) continue;
    if (row.effectiveTo && row.effectiveTo < onDate) continue;
    const scope = scopeOf(row);
    if (scope === "employee" && row.employeePartyId !== employee.employeePartyId) continue;
    if (scope === "job_title"
      && (employee.jobTitle ?? "").toLowerCase() !== (row.jobTitle ?? "").toLowerCase()) continue;
    if (scope === "trade" && row.tradeId !== (employee.tradeId ?? null)) continue;
    if (scope === "department" && row.departmentId !== (employee.departmentId ?? null)) continue;
    if (scope === "subsidiary" && row.subsidiaryId !== (employee.subsidiaryId ?? null)) continue;
    if (
      best === null
      || SCOPE_RANK[scope] < SCOPE_RANK[best.scope]
      || (SCOPE_RANK[scope] === SCOPE_RANK[best.scope] && row.effectiveFrom > best.row.effectiveFrom)
    ) {
      best = { row, scope };
    }
  }
  if (!best) return null;
  return {
    id: best.row.id,
    name: best.row.name,
    scope: best.scope,
    pattern: best.row.pattern,
    cycleDays: best.row.cycleDays,
    cycleAnchor: best.row.cycleAnchor,
    days: best.row.days,
    effectiveFrom: best.row.effectiveFrom,
  };
}

// ---------------------------------------------------------------------------
// Reading a pattern
// ---------------------------------------------------------------------------

/** The cycle position a date falls on. Negative offsets wrap correctly — a
 *  pattern anchored in 2026 still describes 2019. */
export function cyclePositionOn(schedule: ResolvedWorkSchedule, date: string): number {
  if (schedule.pattern !== "cycle" || !schedule.cycleDays || !schedule.cycleAnchor) {
    throw new WorkScheduleError(
      `schedule ${schedule.id} has no cycle — its hours vary, so no position is defined`,
    );
  }
  const offset = daysApart(schedule.cycleAnchor, date);
  return ((offset % schedule.cycleDays) + schedule.cycleDays) % schedule.cycleDays;
}

/**
 * Hours normally scheduled on a date, or NULL when the schedule declares that
 * the employee's hours vary and there is therefore no such thing.
 *
 * A cycle position with no day row is zero hours — a scheduled day off — which
 * is a real, known answer and not the same as null.
 */
export function scheduledHoursOn(
  schedule: ResolvedWorkSchedule,
  date: string,
): string | null {
  if (schedule.pattern === "varies") return null;
  const position = cyclePositionOn(schedule, date);
  const day = schedule.days.find((entry) => entry.dayIndex === position);
  return roundMoney(day?.hours ?? "0", 4);
}

/** Is the date a normal working day? Null when the hours vary. */
export function isScheduledOn(schedule: ResolvedWorkSchedule, date: string): boolean | null {
  const hours = scheduledHoursOn(schedule, date);
  return hours === null ? null : cmp(hours, "0") > 0;
}

/** Hours over one full cycle. Null when the hours vary. */
export function hoursPerCycle(schedule: ResolvedWorkSchedule): string | null {
  if (schedule.pattern === "varies") return null;
  return sum(schedule.days.map((day) => roundMoney(day.hours, 4)));
}

/** Working days in one full cycle. Null when the hours vary. */
export function daysPerCycle(schedule: ResolvedWorkSchedule): number | null {
  if (schedule.pattern === "varies") return null;
  return schedule.days.filter((day) => cmp(roundMoney(day.hours, 4), "0") > 0).length;
}

/**
 * Hours in a notional week — the cycle's hours scaled by 7 ÷ cycleDays.
 *
 * Offered because reports and estimates legitimately want one number, and
 * deriving it here once beats every caller dividing by a guess. It is NEVER
 * what a day's pay is computed from: a day's pay comes from the day.
 */
export function scheduledHoursPerWeek(schedule: ResolvedWorkSchedule): string | null {
  const perCycle = hoursPerCycle(schedule);
  if (perCycle === null || !schedule.cycleDays) return null;
  return roundMoney(mulRatio(perCycle, 7n, BigInt(schedule.cycleDays)), 4);
}

/** Working days in a notional week. Null when the hours vary. */
export function scheduledDaysPerWeek(schedule: ResolvedWorkSchedule): string | null {
  const days = daysPerCycle(schedule);
  if (days === null || !schedule.cycleDays) return null;
  return roundMoney(mulRatio(String(days), 7n, BigInt(schedule.cycleDays)), 4);
}

/**
 * Do the employee's hours differ from working day to working day?
 *
 * A declared `varies` pattern is the loudest yes. A cycle whose working days
 * carry unequal hours is the quieter one, and it is the same fact: a statute
 * that says "where the hours of work vary" is satisfied by four ten-hour days
 * and one four-hour day just as much as by a casual with no roster.
 *
 * A cycle with no working days at all is also "varies": there is no normal day
 * to pay, so the average is the only defined answer.
 */
export function hoursVaryByDay(schedule: ResolvedWorkSchedule): boolean {
  if (schedule.pattern === "varies") return true;
  const working = schedule.days
    .map((day) => roundMoney(day.hours, 4))
    .filter((hours) => cmp(hours, "0") > 0);
  if (working.length === 0) return true;
  return working.some((hours) => cmp(hours, working[0]!) !== 0);
}

/**
 * The hours of ONE NORMAL WORKING DAY, or null when there is no such thing.
 *
 * This — not the hours of a particular calendar date — is what statutes mean by
 * "a regular day's pay", and the difference is not academic. Every employment-
 * standards regime that words a holiday entitlement that way also says that
 * when the holiday lands on a day the employee does not work they get a
 * substitute day off WITH PAY, so what is owed is always one normal day, never
 * the zero hours of the calendar day the holiday happened to fall on.
 *
 * Null when the hours vary — which is precisely the condition those same
 * statutes name when they switch to an average or a percentage. A weekly-hours
 * number cannot produce this: four ten-hour days is forty hours a week and a
 * TEN-hour normal day, and dividing forty by five would pay eight.
 */
export function normalWorkdayHours(schedule: ResolvedWorkSchedule): string | null {
  if (hoursVaryByDay(schedule)) return null;
  const working = schedule.days
    .map((day) => roundMoney(day.hours, 4))
    .filter((hours) => cmp(hours, "0") > 0);
  return working[0] ?? null;
}

/**
 * The nearest working day strictly before `date` (`direction` −1) or strictly
 * after it (+1), or null when the schedule has no working day at all or its
 * hours vary.
 *
 * This is the fact behind a "last scheduled shift before, first scheduled shift
 * after" test. It says WHICH day the shift was; it never says whether the
 * employee attended it, and it must not be used to infer an absence — a
 * timesheet gap is as likely to be approved leave, and consent is not a fact
 * any timesheet records.
 */
export function adjacentScheduledDay(
  schedule: ResolvedWorkSchedule,
  date: string,
  direction: -1 | 1,
): string | null {
  if (schedule.pattern === "varies") return null;
  const span = schedule.cycleDays ?? 0;
  if (span <= 0) return null;
  for (let step = 1; step <= span; step += 1) {
    const candidate = shiftDay(date, direction * step);
    if (isScheduledOn(schedule, candidate) === true) return candidate;
  }
  return null;
}

/** Total hours the pattern schedules across [from, to] inclusive. Null when
 *  the hours vary. The obvious consumer is an accrual or a capacity forecast,
 *  neither of which may guess either. */
export function scheduledHoursBetween(
  schedule: ResolvedWorkSchedule,
  from: string,
  to: string,
): string | null {
  if (schedule.pattern === "varies") return null;
  if (daysApart(from, to) < 0) return "0";
  let total = "0";
  for (let cursor = from; cursor <= to; cursor = shiftDay(cursor, 1)) {
    total = add(total, scheduledHoursOn(schedule, cursor) ?? "0");
  }
  return total;
}

/** Trailing zeros off a decimal, for prose. Presentation only — never used to
 *  produce a value anything is computed from. */
const plain = (value: string): string =>
  value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;

/** A one-line description of the pattern, for a stub's audit trail and for an
 *  operator reading a refusal. */
export function describeWorkSchedule(schedule: ResolvedWorkSchedule): string {
  if (schedule.pattern === "varies") return "hours vary — no regular schedule";
  const perCycle = hoursPerCycle(schedule) ?? "0";
  const days = daysPerCycle(schedule) ?? 0;
  const span = schedule.cycleDays ?? 0;
  const cycle = span === 7 ? "week" : `${span}-day cycle`;
  return `${plain(perCycle)} hours over ${days} day${days === 1 ? "" : "s"} per ${cycle}`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const day = (value: string | Date | null): string | null =>
  value === null ? null
  : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);

/** Every schedule row an org holds, with its cycle days attached. */
export async function loadWorkSchedules(
  tx: Pick<typeof db, "execute">,
  orgId: string,
): Promise<WorkScheduleRow[]> {
  const rows = (await tx.execute<{
      id: string; name: string | null; employee_party_id: string | null; job_title: string | null;
      trade_id: string | null; department_id: string | null; subsidiary_id: string | null;
      pattern: WorkPattern; cycle_days: number | null; cycle_anchor: string | Date | null;
      effective_from: string | Date; effective_to: string | Date | null; is_active: boolean;
      days: { dayIndex: number; hours: string }[] | null;
    }>(sql`
    select s.id, s.name, s.employee_party_id, s.job_title, s.trade_id, s.department_id,
           s.subsidiary_id, s.pattern, s.cycle_days, s.cycle_anchor,
           s.effective_from, s.effective_to, s.is_active,
           coalesce(
             (select json_agg(json_build_object('dayIndex', d.day_index, 'hours', d.hours::text)
                              order by d.day_index)
                from work_schedule_days d
               where d.org_id = s.org_id and d.schedule_id = s.id),
             '[]'::json) as days
      from work_schedules s
     where s.org_id = ${orgId}
     order by s.effective_from, s.id
  `));
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    employeePartyId: row.employee_party_id,
    jobTitle: row.job_title,
    tradeId: row.trade_id,
    departmentId: row.department_id,
    subsidiaryId: row.subsidiary_id,
    pattern: row.pattern,
    cycleDays: row.cycle_days === null ? null : Number(row.cycle_days),
    cycleAnchor: day(row.cycle_anchor),
    days: (row.days ?? []).map((entry) => ({
      dayIndex: Number(entry.dayIndex),
      hours: roundMoney(entry.hours ?? "0", 4),
    })),
    effectiveFrom: day(row.effective_from)!,
    effectiveTo: day(row.effective_to),
    isActive: row.is_active === true,
  }));
}

/**
 * The schedule governing an employee on a date, or null when none is recorded.
 *
 * The thin adapter: loads the org's rows, reads the employee's scope keys off
 * their employment record, and calls `pickWorkSchedule`. Callers that resolve
 * many employees should call `loadWorkSchedules` once and use the kernel
 * directly.
 */
export async function resolveWorkSchedule(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  employeePartyId: string,
  onDate: string,
  scope?: Omit<WorkScheduleScopeKeys, "employeePartyId">,
): Promise<ResolvedWorkSchedule | null> {
  let keys = scope;
  if (!keys) {
    const employee = (await tx.execute<{
        job_title: string | null; trade_id: string | null;
        department_id: string | null; subsidiary_id: string | null;
      }>(sql`
      select er.job_title, er.trade_id, er.department_id, p.subsidiary_id
        from employee_roles er
        join parties p on p.id = er.party_id and p.org_id = er.org_id
       where er.org_id = ${orgId} and er.party_id = ${employeePartyId}
       limit 1
    `));
    const found = employee.rows[0];
    keys = {
      jobTitle: found?.job_title ?? null,
      tradeId: found?.trade_id ?? null,
      departmentId: found?.department_id ?? null,
      subsidiaryId: found?.subsidiary_id ?? null,
    };
  }
  const rows = await loadWorkSchedules(tx, orgId);
  return pickWorkSchedule(rows, { employeePartyId, ...keys }, onDate);
}
