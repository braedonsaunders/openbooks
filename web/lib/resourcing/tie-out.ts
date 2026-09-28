import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { projects, timeEntries } from "@openbooks/schema";
import { addCalendarDays } from "@openbooks/engine/src/platform/business-date.ts";
import { add, neg, sum } from "@openbooks/engine/src/money/money.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { assertSundayWindow, weekStartOf, weeksBetween } from "@openbooks/engine/src/resourcing/weeks.ts";
import { loadResourcingBoard } from "./queries";
import { subsidiaryVisibleFilter } from "../subsidiaries";

/**
 * Live plan-vs-actual tie-out shared by the resourcing cockpit and the
 * project Staffing tab. Planned hours and net capacity come from the landed
 * board/forecast readers; only approved time is read here, batched for the
 * same visible person-week scope. Hours stay decimal strings and the variance
 * is an exact money-kernel subtraction. Nothing is divided anywhere.
 */

export interface PlanVsActualRow {
  employeePartyId: string;
  employeeName: string;
  weekStart: string;
  /** Set when the caller filters to one project, else null. */
  projectId: string | null;
  /** Active hard assignment hours for the person-week. */
  plannedHours: string;
  assignmentIds: string[];
  /** Approved time-entry hours for the person-week (submitted time excluded). */
  approvedHours: string;
  timeEntryIds: string[];
  /** Approved minus planned, exact decimal subtraction. */
  varianceHours: string;
  /** Net capacity from the forecast fact; null when capacity is unknown. */
  netCapacity: string | null;
  overallocated: boolean | null;
  /** Which capacity tier the forecast cited: schedule, standard, mixed or unknown. */
  capacityTier: string;
  scheduleIds: string[];
  holidayDates: string[];
  holidayJurisdiction: string | null;
  holidaysApplied: boolean;
  /** Recorded absences behind the week's time-off figure, with the leave
   *  request each one was filed under (null for directly recorded days). */
  absences: { absenceId: string; leaveRequestId: string | null }[];
}

export interface PlanVsActualWindow {
  firstSunday: string;
  lastSunday: string;
  projectId?: string;
}

type ApprovedTimeRow = {
  id: string;
  employee_party_id: string;
  worked_on: string;
  hours: string;
};

export async function loadPlanVsActual(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  window: PlanVsActualWindow,
): Promise<PlanVsActualRow[]> {
  assertSundayWindow(window.firstSunday, window.lastSunday);
  const weeks = weeksBetween(window.firstSunday, window.lastSunday);

  const facts = new Map<string, Awaited<ReturnType<typeof loadResourcingBoard>>["forecast"]["personWeeks"][number]>();
  const names = new Map<string, string>();
  let page = 1;
  let pages = 1;
  do {
    const board = await loadResourcingBoard(orgId, allowedSubsidiaryIds, {
      firstSunday: window.firstSunday,
      lastSunday: window.lastSunday,
      projectId: window.projectId,
      page,
    });
    for (const person of board.people) names.set(person.partyId, person.displayName);
    for (const fact of board.forecast.personWeeks) {
      facts.set(`${fact.employeePartyId}\u0000${fact.weekStart}`, fact);
    }
    pages = Math.max(1, Math.ceil(board.total / board.pageSize));
    page += 1;
  } while (page <= pages);

  const personIds = [...names.keys()];
  const approved = new Map<string, ApprovedTimeRow[]>();
  if (personIds.length > 0) {
    const lastSaturday = addCalendarDays(window.lastSunday, 6);
    const projectScope = window.projectId
      ? and(eq(projects.orgId, orgId), eq(projects.id, window.projectId))
      : eq(projects.orgId, orgId);
    const rows = await db.select({
      id: timeEntries.id,
      employeePartyId: timeEntries.employeePartyId,
      workedOn: timeEntries.workedOn,
      hours: timeEntries.hours,
    })
      .from(timeEntries)
      .innerJoin(projects, and(
        eq(projects.orgId, timeEntries.orgId),
        eq(projects.id, timeEntries.projectId),
      ))
      .where(sql`${and(
        eq(timeEntries.orgId, orgId),
        eq(timeEntries.status, "approved"),
        inArray(timeEntries.employeePartyId, personIds),
        sql`${timeEntries.workedOn} >= ${window.firstSunday} and ${timeEntries.workedOn} <= ${lastSaturday}`,
        projectScope,
      )}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, allowedSubsidiaryIds)}`);
    for (const row of rows) {
      const weekStart = weekStartOf(row.workedOn);
      if (!weeks.includes(weekStart)) continue;
      const group = approved.get(`${row.employeePartyId}\u0000${weekStart}`) ?? [];
      group.push({ id: row.id, employee_party_id: row.employeePartyId, worked_on: row.workedOn, hours: row.hours });
      approved.set(`${row.employeePartyId}\u0000${weekStart}`, group);
    }
  }

  const keys = new Set<string>([...facts.keys(), ...approved.keys()]);
  const absenceIds = [...new Set([...facts.values()].flatMap((fact) => fact.timeOff.absenceRowIds))];
  const leaveRequests = new Map<string, string | null>();
  if (absenceIds.length > 0) {
    const absenceRows = await db.execute<{ id: string; leave_request_id: string | null }>(sql`
      select id::text as id, leave_request_id::text as leave_request_id
        from hrm_absences where org_id = ${orgId} and id in (${sql.join(absenceIds.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const row of absenceRows.rows) leaveRequests.set(row.id, row.leave_request_id);
  }
  const output: PlanVsActualRow[] = [];
  for (const key of keys) {
    const [employeePartyId, weekStart] = key.split("\u0000");
    const fact = facts.get(key);
    const entries = [...(approved.get(key) ?? [])].sort((a, b) => a.id < b.id ? -1 : 1);
    const plannedHours = fact ? add(fact.hardBillableHours, fact.hardNonBillableHours) : "0.0000";
    const approvedHours = sum(entries.map((entry) => entry.hours));
    const assignmentIds = fact
      ? [...fact.hardBillableAssignmentIds, ...fact.hardNonBillableAssignmentIds].sort()
      : [];
    // A week with neither a plan nor approved time carries no tie-out.
    if (assignmentIds.length === 0 && entries.length === 0) continue;
    const scheduleIds = [...new Set((fact?.capacity?.scheduleSources ?? []).map((source) => source.scheduleId))].sort();
    output.push({
      employeePartyId: employeePartyId!,
      employeeName: names.get(employeePartyId!) ?? "",
      weekStart: weekStart!,
      projectId: window.projectId ?? null,
      plannedHours,
      assignmentIds,
      approvedHours,
      timeEntryIds: entries.map((entry) => entry.id),
      varianceHours: add(approvedHours, neg(plannedHours)),
      netCapacity: fact?.netCapacity ?? null,
      overallocated: fact?.overallocated ?? null,
      capacityTier: fact?.capacity?.tier.tier ?? "unknown",
      scheduleIds,
      holidayDates: (fact?.holidays.dates ?? []).map((holiday) => holiday.date).sort(),
      holidayJurisdiction: fact?.holidays.jurisdiction ?? null,
      holidaysApplied: fact?.holidays.applied ?? false,
      absences: [...(fact?.timeOff.absenceRowIds ?? [])].sort().map((absenceId) => ({
        absenceId,
        leaveRequestId: leaveRequests.get(absenceId) ?? null,
      })),
    });
  }
  output.sort((a, b) => a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1
    : a.employeeName.localeCompare(b.employeeName));
  return output;
}
