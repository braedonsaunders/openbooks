import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  requireHrmLeaveManageOnEmployment,
  requireHrmLeaveRead,
} from "./authorization.ts";
import { LeaveError } from "./leave-errors.ts";
import { addHours, formatCents, parseHoursToCents } from "./leave-math.ts";
import { parseCivilDate } from "./temporal.ts";

/**
 * HRM attendance (HR-5): the absence record written after the fact, and the
 * calendar reads. Recording writes hrm_absences with source 'recorded' —
 * never a time entry: approved time flows to job costing and payroll export,
 * and an absence must not cost a job or pay twice. For value-crossing types
 * the recording also raises the pending pay-run input, exactly like an
 * approval; a day a committed run already covers is refused with the retro
 * remedy.
 */

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

function requireCivilDate(value: unknown): string {
  if (typeof value !== "string") {
    throw new LeaveError("INVALID_INPUT", "on_date must be a real YYYY-MM-DD calendar date in years 0001 through 9999");
  }
  try {
    parseCivilDate(value);
    return value;
  } catch {
    throw new LeaveError("INVALID_INPUT", "on_date must be a real YYYY-MM-DD calendar date in years 0001 through 9999");
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
  const { orgId, actorId } = query;
  if (typeof orgId !== "string" || orgId.length === 0) throw new LeaveError("REFUSED", "orgId must be a non-empty string");
  if (typeof actorId !== "string" || actorId.length === 0) throw new LeaveError("REFUSED", "actorId must be a non-empty string");
  if (typeof query.employmentId !== "string" || query.employmentId.length === 0) {
    throw new LeaveError("INVALID_INPUT", "employmentId must be a uuid");
  }
  if (typeof query.leaveTypeId !== "string" || query.leaveTypeId.length === 0) {
    throw new LeaveError("INVALID_INPUT", "leaveTypeId must be a uuid");
  }
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
      if ((error as { code?: string }).code === "23505") {
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

/**
 * Calendar read per employment for a date range: net hours per day with the
 * type and source. Reversals net out; a fully reversed day reads zero, never
 * vanishes (the evidence stays).
 */
export async function absenceCalendarForEmployment(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  from: string,
  to: string,
): Promise<AbsenceDay[]> {
  await requireHrmLeaveRead(exec, orgId, actorId, employmentId);
  if (to < from) throw new LeaveError("INVALID_INPUT", `calendar end ${to} must not precede start ${from}`);
  const rows = (await exec.execute<{
    id: string; employment_id: string; on_date: string; hours: string;
    code: string; source: "request" | "recorded";
  }>(sql`
    select a.id, a.employment_id, a.on_date::text as on_date, a.hours::text as hours,
           t.code, a.source
      from hrm_absences a join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
     where a.org_id = ${orgId} and a.employment_id = ${employmentId}
       and a.on_date >= ${from} and a.on_date <= ${to}
     order by a.on_date
  `)).rows;
  interface NettedDay { id: string; hours: string; code: string; source: "request" | "recorded" }
  const byDay = new Map<string, NettedDay>();
  for (const row of rows) {
    const day = String(row.on_date).slice(0, 10);
    const current = byDay.get(day);
    byDay.set(day, {
      id: row.id,
      hours: current ? addHours(current.hours, String(row.hours)) : String(row.hours),
      // The latest row names the day; the hours net across all rows.
      code: row.code,
      source: row.source,
    });
  }
  return [...byDay.entries()].map(([onDate, entry]) => ({
    id: entry.id,
    employmentId,
    onDate,
    hours: entry.hours,
    leaveTypeCode: entry.code,
    source: entry.source,
  }));
}

export interface DepartmentAbsenceDay extends AbsenceDay {
  readonly workerName: string;
}

/**
 * Calendar read per department for a date range: every absence day of every
 * employment whose primary assignment sits in the department, net of
 * reversals. Members outside the actor's subsidiary allowlist never list —
 * the department view is a manager lens, not a cross-entity window.
 */
export async function absenceCalendarForDepartment(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  departmentId: string,
  from: string,
  to: string,
): Promise<DepartmentAbsenceDay[]> {
  if (to < from) throw new LeaveError("INVALID_INPUT", `calendar end ${to} must not precede start ${from}`);
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  const members = (await exec.execute<{ employment_id: string; employer_subsidiary_id: string; worker_name: string }>(sql`
    select distinct v.employment_id, e.employer_subsidiary_id, p.display_name as worker_name
      from employment_assignment_versions v
      join worker_employments e on e.id = v.employment_id and e.org_id = v.org_id
      join parties p on p.id = e.worker_party_id and p.org_id = v.org_id
     where v.org_id = ${orgId} and v.is_primary and v.recorded_until is null
       and v.department_id = ${departmentId}
       and v.effective_from <= ${to} and (v.effective_to is null or v.effective_to > ${from})
  `)).rows;
  const visible = members.filter((member) => allowed === null || allowed.has(member.employer_subsidiary_id));
  // One read gate per visible employment: department membership alone never
  // grants sight — the employment gate still decides.
  const days: DepartmentAbsenceDay[] = [];
  for (const member of visible) {
    await requireHrmLeaveRead(exec, orgId, actorId, member.employment_id);
    const rows = (await exec.execute<{
      id: string; on_date: string; hours: string; code: string; source: "request" | "recorded";
    }>(sql`
      select a.id, a.on_date::text as on_date, a.hours::text as hours, t.code, a.source
        from hrm_absences a join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
       where a.org_id = ${orgId} and a.employment_id = ${member.employment_id}
         and a.on_date >= ${from} and a.on_date <= ${to}
       order by a.on_date
    `)).rows;
    const net = new Map<string, { hours: string; code: string; source: "request" | "recorded"; id: string }>();
    for (const row of rows) {
      const day = String(row.on_date).slice(0, 10);
      const current = net.get(day);
      net.set(day, {
        id: row.id,
        hours: current ? addHours(current.hours, String(row.hours)) : String(row.hours),
        code: row.code,
        source: row.source,
      });
    }
    for (const [onDate, entry] of net) {
      days.push({
        id: entry.id,
        employmentId: member.employment_id,
        onDate,
        hours: entry.hours,
        leaveTypeCode: entry.code,
        source: entry.source,
        workerName: member.worker_name,
      });
    }
  }
  days.sort((a, b) => (a.onDate < b.onDate ? -1 : a.onDate > b.onDate ? 1 : a.workerName.localeCompare(b.workerName)));
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
