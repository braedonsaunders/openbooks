import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  requireHrmLeaveManageOnEmployment,
  requireHrmLeaveRead,
} from "./authorization.ts";
import { LeaveError } from "./leave-errors.ts";
import { inputGuards } from "./input-guards.ts";
import { isUniqueViolation } from "./field-time/errors.ts";
import { addHours, formatCents, parseHoursToCents } from "./leave-math.ts";
import { parseCivilDate } from "./temporal.ts";
import { inclusiveCalendarDays } from "../platform/civil-date.ts";

/**
 * HRM attendance (HR-5): the absence record written after the fact, and the
 * calendar reads. Recording writes hrm_absences with source 'recorded' —
 * never a time entry: approved time flows to job costing and payroll export,
 * and an absence must not cost a job or pay twice. For value-crossing types
 * the recording also raises the pending pay-run input, exactly like an
 * approval; a day a committed run already covers is refused with the retro
 * remedy.
 */

const { requireOrgId, requireActorId, requireId } = inputGuards((message, kind) =>
  new LeaveError(kind === "scope" ? "REFUSED" : "INVALID_INPUT", message),
);

export interface RecordAbsenceQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly onDate: unknown;
  readonly hours: unknown;
  readonly leaveTypeId: string;
}

export interface AbsenceDay {
  readonly id: string;
  readonly employmentId: string;
  readonly onDate: string;
  /** Net hours for the day: reversals net out. */
  readonly hours: string;
  readonly leaveTypeCode: string;
  readonly source: "request" | "recorded";
}

function requireCivilDate(value: unknown, field = "on_date"): string {
  if (typeof value !== "string") {
    throw new LeaveError("INVALID_INPUT", `${field} must be a real YYYY-MM-DD calendar date in years 0001 through 9999`);
  }
  try {
    parseCivilDate(value);
    return value;
  } catch {
    throw new LeaveError("INVALID_INPUT", `${field} must be a real YYYY-MM-DD calendar date in years 0001 through 9999`);
  }
}

function requirePositiveHours(value: unknown): string {
  if (typeof value !== "string") {
    throw new LeaveError("INVALID_INPUT", "hours must be an exact decimal with at most 2 fraction digits");
  }
  try {
    const cents = parseHoursToCents(value);
    if (cents <= 0n) throw new LeaveError("INVALID_INPUT", "hours must be greater than zero");
    return formatCents(cents);
  } catch (error) {
    if (error instanceof LeaveError) throw error;
    throw new LeaveError("INVALID_INPUT", "hours must be an exact decimal with at most 2 fraction digits");
  }
}

/** Record an absence after the fact (manager-held, reasoned elsewhere). */
export async function recordAbsence(query: RecordAbsenceQuery): Promise<AbsenceDay> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  requireId(query.employmentId, "employmentId");
  requireId(query.leaveTypeId, "leaveTypeId");
  const onDate = requireCivilDate(query.onDate);
  const hours = requirePositiveHours(query.hours);
  return withOrgTransaction(orgId, async () => {
    await requireHrmLeaveManageOnEmployment(db, orgId, actorId, query.employmentId);
    const type = (await db.execute<{ id: string; code: string; is_active: boolean; value_crossing: string }>(sql`
      select id, code, is_active, value_crossing from hrm_leave_types
       where org_id = ${orgId} and id = ${query.leaveTypeId}
    `)).rows[0];
    if (!type) throw new LeaveError("NOT_FOUND", "leave type not found in this organization — check the type id");
    if (!type.is_active) throw new LeaveError("REFUSED", `leave type ${type.code} is inactive — reactivate it before recording`);
    const existing = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_absences
       where org_id = ${orgId} and employment_id = ${query.employmentId} and on_date = ${onDate}
         and reversal_of is null
    `)).rows[0]?.n ?? 0;
    if (existing > 0) {
      throw new LeaveError(
        "REFUSED",
        `an absence is already recorded for ${onDate} — cancel the covering request instead of double-recording the day`,
      );
    }
    // Recorded rows never raise pay-run inputs: inputs key on
    // source_leave_request_id, and an after-the-fact recording has no
    // request behind it. Value treatment for a backdated day goes through a
    // leave request (approval raises the inputs) or a retro run — the
    // recording itself rewrites no paid history, so no retro refusal here.
    // The count check above cannot arbitrate two concurrent writers: both
    // pass it under READ COMMITTED and both insert. The partial day guard
    // (0337, one live row per employment and day) settles the race in
    // storage, and the loser lands here — translated to the same named
    // refusal, never a raw 23505.
    let inserted: { id: string } | undefined;
    try {
      inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_absences (org_id, leave_request_id, employment_id, on_date, hours,
          leave_type_id, source, created_by, updated_by)
        values (${orgId}, null, ${query.employmentId}, ${onDate}, ${hours},
          ${query.leaveTypeId}, 'recorded', ${actorId}, ${actorId})
        returning id
      `)).rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new LeaveError(
          "REFUSED",
          `an absence is already recorded for ${onDate} — reload the day before recording`,
        );
      }
      throw error;
    }
    if (!inserted) throw new LeaveError("REFUSED", "the absence was not stored — no row was written; retry the request");
    return { id: inserted.id, employmentId: query.employmentId, onDate, hours, leaveTypeCode: type.code, source: "recorded" as const };
  });
}

export interface DepartmentAbsenceDay extends AbsenceDay {
  readonly workerName: string;
}

/**
 * Calendar read across all departments, or one selected department. A null
 * department includes employments without a department assignment. Every
 * employment is authorized and subsidiary-scoped before its days are read.
 * Department membership is resolved on the absence date, so a transfer does
 * not move historical leave into the employee's new department.
 */
export async function absenceCalendarForDepartment(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  departmentId: string | null,
  from: string,
  to: string,
): Promise<DepartmentAbsenceDay[]> {
  requireOrgId(orgId);
  requireActorId(actorId);
  if (departmentId !== null) requireId(departmentId, "departmentId");
  requireCivilDate(from, "calendar start");
  requireCivilDate(to, "calendar end");
  if (to < from) throw new LeaveError("INVALID_INPUT", `calendar end ${to} must not precede start ${from} — choose an end on or after the start`);
  if (inclusiveCalendarDays(from, to) > 366) {
    throw new LeaveError("INVALID_INPUT", "the calendar window must not exceed 366 days — choose a shorter date range");
  }
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed !== null && allowed.size === 0) return [];
  const scope = allowed === null ? sql`` : sql`and e.employer_subsidiary_id in (${sql.join(
    [...allowed].map((id) => sql`${id}::uuid`), sql`, `,
  )})`;
  const members = (await exec.execute<{ employment_id: string; employer_subsidiary_id: string; worker_name: string }>(sql`
    select e.id as employment_id, e.employer_subsidiary_id, p.display_name as worker_name
      from worker_employments e
      join parties p on p.id = e.worker_party_id and p.org_id = e.org_id
     where e.org_id = ${orgId} ${scope}
       and exists (
         select 1 from hrm_absences a
          where a.org_id = e.org_id and a.employment_id = e.id
            and a.on_date >= ${from} and a.on_date <= ${to}
       )
     order by p.display_name, e.id
  `)).rows;
  const visible = members.filter((member) => allowed === null || allowed.has(member.employer_subsidiary_id));
  const days: DepartmentAbsenceDay[] = [];
  for (const member of visible) {
    await requireHrmLeaveRead(exec, orgId, actorId, member.employment_id);
    const department = departmentId === null ? sql`` : sql`and exists (
      select 1 from employment_assignment_versions v
       where v.org_id = a.org_id and v.employment_id = a.employment_id
         and v.is_primary and v.recorded_until is null
         and v.department_id = ${departmentId}
         and v.effective_from <= a.on_date
         and (v.effective_to is null or v.effective_to > a.on_date)
    )`;
    const rows = (await exec.execute<{
      id: string; on_date: string; hours: string; code: string; source: "request" | "recorded";
    }>(sql`
      select a.id, a.on_date::text as on_date, a.hours::text as hours, t.code, a.source
        from hrm_absences a join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
       where a.org_id = ${orgId} and a.employment_id = ${member.employment_id}
         and a.on_date >= ${from} and a.on_date <= ${to} ${department}
       order by a.on_date, t.code, a.id
    `)).rows;
    // Net each leave type independently: a cancelled vacation and a new
    // sick day on the same date must not inherit each other's type or hours.
    const net = new Map<string, { onDate: string; hours: string; code: string; source: "request" | "recorded"; id: string }>();
    for (const row of rows) {
      const onDate = String(row.on_date).slice(0, 10);
      const key = `${onDate}:${row.code}`;
      const current = net.get(key);
      net.set(key, {
        id: row.id,
        onDate,
        hours: current ? addHours(current.hours, String(row.hours)) : String(row.hours),
        code: row.code,
        source: row.source,
      });
    }
    for (const entry of net.values()) {
      if (parseHoursToCents(entry.hours) === 0n) continue;
      days.push({
        id: entry.id,
        employmentId: member.employment_id,
        onDate: entry.onDate,
        hours: entry.hours,
        leaveTypeCode: entry.code,
        source: entry.source,
        workerName: member.worker_name,
      });
    }
  }
  days.sort((a, b) => a.onDate.localeCompare(b.onDate) || a.workerName.localeCompare(b.workerName) || a.employmentId.localeCompare(b.employmentId) || a.leaveTypeCode.localeCompare(b.leaveTypeCode));
  return days;
}

/** Employments on leave on one date (HR overview panel + tab segment). */
export async function employmentsOnLeave(
  exec: SqlExecutor,
  orgId: string,
  onDate: string,
  allowedEmployerIds: Set<string> | null,
): Promise<{ employmentId: string; workerName: string; leaveTypeCode: string; hours: string }[]> {
  // The scope is required, never optional: callers pass the actor's
  // allowed employer set (null = unrestricted) so an on-leave roster
  // never leaks names or counts across legal entities. An empty set
  // reads empty, never all.
  if (allowedEmployerIds !== null && allowedEmployerIds.size === 0) return [];
  const scopeFilter =
    allowedEmployerIds === null
      ? sql``
      : sql`and e.employer_subsidiary_id in (${sql.join(
          [...allowedEmployerIds].map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const rows = (await exec.execute<{
    employment_id: string; worker_name: string; code: string; hours: string;
  }>(sql`
    select a.employment_id, p.display_name as worker_name, t.code,
           sum(a.hours)::text as hours
      from hrm_absences a
      join worker_employments e on e.id = a.employment_id and e.org_id = a.org_id
      join parties p on p.id = e.worker_party_id and p.org_id = a.org_id
      join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
     where a.org_id = ${orgId} and a.on_date = ${onDate}
     ${scopeFilter}
     group by a.employment_id, p.display_name, t.code
    having sum(a.hours) <> 0
     order by p.display_name
  `)).rows;
  return rows.map((row) => ({
    employmentId: row.employment_id,
    workerName: row.worker_name,
    leaveTypeCode: row.code,
    hours: String(row.hours),
  }));
}
