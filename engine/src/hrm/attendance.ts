import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  loadOwnEmploymentIds,
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

const { requireOrgId, requireActorId, requireId } = inputGuards(
  (message, kind) => new LeaveError(kind === "scope" ? "REFUSED" : "INVALID_INPUT", message),
);

export interface RecordAbsenceQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly onDate: unknown;
  readonly hours: unknown;
  readonly leaveTypeId: string;
  /** Basis for the filing (for example the verbal approval of a back-dated day). */
  readonly reason?: unknown;
}

export interface AbsenceDay {
  readonly id: string;
  readonly employmentId: string;
  readonly onDate: string;
  /** Net hours for the day: reversals net out. */
  readonly hours: string;
  readonly leaveTypeCode: string;
  readonly source: "request" | "recorded";
  /** Basis recorded at filing; null for approval-written and legacy rows. */
  readonly reason: string | null;
}

function requireCivilDate(value: unknown, field = "on_date"): string {
  if (typeof value !== "string") {
    throw new LeaveError(
      "INVALID_INPUT",
      `${field} must be a real YYYY-MM-DD calendar date in years 0001 through 9999`,
    );
  }
  try {
    parseCivilDate(value);
    return value;
  } catch {
    throw new LeaveError(
      "INVALID_INPUT",
      `${field} must be a real YYYY-MM-DD calendar date in years 0001 through 9999`,
    );
  }
}

function requirePositiveHours(value: unknown): string {
  if (typeof value !== "string") {
    throw new LeaveError(
      "INVALID_INPUT",
      "hours must be an exact decimal with at most 2 fraction digits",
    );
  }
  try {
    const cents = parseHoursToCents(value);
    if (cents <= 0n) throw new LeaveError("INVALID_INPUT", "hours must be greater than zero");
    return formatCents(cents);
  } catch (error) {
    if (error instanceof LeaveError) throw error;
    throw new LeaveError(
      "INVALID_INPUT",
      "hours must be an exact decimal with at most 2 fraction digits",
    );
  }
}

function requireRecordReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new LeaveError(
      "INVALID_INPUT",
      "a recorded absence carries its basis — record why (for example the verbal approval)",
    );
  }
  return reason.trim();
}

/**
 * Record an absence after the fact (manager-held). The basis rides on the
 * row and in the audit entry: a back-dated day or a day recorded for
 * another worker is refused without a non-blank reason. The requirement is
 * decided here from the date and the actor's own employments — never only
 * in the UI.
 */
export async function recordAbsence(query: RecordAbsenceQuery): Promise<AbsenceDay> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  requireId(query.employmentId, "employmentId");
  requireId(query.leaveTypeId, "leaveTypeId");
  const onDate = requireCivilDate(query.onDate);
  const hours = requirePositiveHours(query.hours);
  return withOrgTransaction(orgId, async () => {
    await requireHrmLeaveManageOnEmployment(db, orgId, actorId, query.employmentId);
    // The basis requirement is engine-decided: back-dated against the
    // org's business day, on-behalf against the employments behind the
    // login (created_by never decides — it is the audit trail, not the
    // path). A supplied reason is always validated; a missing one refuses
    // only when the recording needs its basis recorded.
    const today = await businessToday(orgId);
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    const reason =
      query.reason === undefined || query.reason === null
        ? null
        : requireRecordReason(query.reason);
    if (reason === null && onDate < today) {
      throw new LeaveError(
        "INVALID_INPUT",
        `absence ${onDate} is back-dated before today ${today} — record the basis (for example the verbal approval) in the reason`,
      );
    }
    if (reason === null && !own.includes(query.employmentId)) {
      throw new LeaveError(
        "INVALID_INPUT",
        "recording for another worker carries the basis — record why (for example the verbal approval) in the reason",
      );
    }
    const type = (
      await db.execute<{ id: string; code: string; is_active: boolean; value_crossing: string }>(
        sql`
      select id, code, is_active, value_crossing from hrm_leave_types
       where org_id = ${orgId} and id = ${query.leaveTypeId}
    `,
        "objects",
      )
    )[0];
    if (!type)
      throw new LeaveError(
        "NOT_FOUND",
        "leave type not found in this organization — check the type id",
      );
    if (!type.is_active)
      throw new LeaveError(
        "REFUSED",
        `leave type ${type.code} is inactive — reactivate it before recording`,
      );
    const existing =
      (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from hrm_absences
       where org_id = ${orgId} and employment_id = ${query.employmentId} and on_date = ${onDate}
         and reversal_of is null
    `,
          "objects",
        )
      )[0]?.n ?? 0;
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
      inserted = (
        await db.execute<{ id: string }>(
          sql`
        insert into hrm_absences (org_id, leave_request_id, employment_id, on_date, hours,
          leave_type_id, source, reason, created_by, updated_by)
        values (${orgId}, null, ${query.employmentId}, ${onDate}, ${hours},
          ${query.leaveTypeId}, 'recorded', ${reason}, ${actorId}, ${actorId})
        returning id
      `,
          "objects",
        )
      )[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new LeaveError(
          "REFUSED",
          `an absence is already recorded for ${onDate} — reload the day before recording`,
        );
      }
      throw error;
    }
    if (!inserted)
      throw new LeaveError(
        "REFUSED",
        "the absence was not stored — no row was written; retry the request",
      );
    // The recording's audit entry carries the same basis the row does, in
    // the same transaction — the row without its event rolls back together.
    const audited = (
      await db.execute<{ id: string }>(
        sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'hrm_absences', ${inserted.id}, 'absence_recorded',
        ${JSON.stringify({ event: "absence_recorded", before: null, after: { employmentId: query.employmentId, onDate, hours, leaveTypeCode: type.code, source: "recorded", reason } })}::jsonb,
        ${actorId})
      returning id
    `,
        "objects",
      )
    )[0];
    if (!audited)
      throw new LeaveError(
        "REFUSED",
        "the absence was stored without its audit event — no event was written; retry the request",
      );
    return {
      id: inserted.id,
      employmentId: query.employmentId,
      onDate,
      hours,
      leaveTypeCode: type.code,
      source: "recorded" as const,
      reason,
    };
  });
}

export interface DepartmentAbsenceDay extends AbsenceDay {
  readonly workerName: string;
  /** The approved request behind a request-sourced day; null for recorded days. */
  readonly leaveRequestId: string | null;
}

export interface AbsenceDetail extends AbsenceDay {
  readonly leaveTypeId: string;
  readonly leaveTypeName: string;
  readonly workerName: string;
  /** The approved request behind a request-sourced day; null for recorded days. */
  readonly leaveRequestId: string | null;
  readonly recordedBy: string | null;
  readonly recordedAt: string | null;
}

/** One absence day, gated on its employment — never by a caller-supplied party. */
export async function getAbsence(query: {
  orgId: string;
  actorId: string;
  absenceId: string;
}): Promise<AbsenceDetail> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  requireId(query.absenceId, "absenceId");
  return withOrgTransaction(orgId, async () => {
    const row = (
      await db.execute<{
        id: string;
        employment_id: string;
        on_date: string;
        hours: string;
        source: "request" | "recorded";
        reason: string | null;
        leave_request_id: string | null;
        leave_type_id: string;
        created_by: string | null;
        created_at: string;
        code: string;
        type_name: string;
        worker_name: string;
      }>(
        sql`
      select a.id, a.employment_id, a.on_date::text as on_date, a.hours::text as hours,
             a.source, a.reason, a.leave_request_id, a.leave_type_id,
             a.created_by::text as created_by, a.created_at::text as created_at,
             t.code, t.name as type_name, p.display_name as worker_name
        from hrm_absences a
        join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
        join worker_employments e on e.id = a.employment_id and e.org_id = a.org_id
        join parties p on p.id = e.worker_party_id and p.org_id = a.org_id
       where a.org_id = ${orgId} and a.id = ${query.absenceId}
    `,
        "objects",
      )
    )[0];
    // Zero rows is a failure: unknown id, or an id from another
    // organization — never report which, so existence cannot be probed
    // across tenants.
    if (!row)
      throw new LeaveError(
        "NOT_FOUND",
        "absence not found in this organization — check the absence id",
      );
    await requireHrmLeaveRead(db, orgId, actorId, row.employment_id);
    return {
      id: row.id,
      employmentId: row.employment_id,
      onDate: String(row.on_date).slice(0, 10),
      hours: String(row.hours),
      leaveTypeCode: row.code,
      source: row.source,
      reason: row.reason != null ? String(row.reason) : null,
      leaveTypeId: row.leave_type_id,
      leaveTypeName: row.type_name,
      workerName: row.worker_name,
      leaveRequestId: row.leave_request_id != null ? String(row.leave_request_id) : null,
      recordedBy: row.created_by != null ? String(row.created_by) : null,
      recordedAt: String(row.created_at),
    };
  });
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
  if (to < from)
    throw new LeaveError(
      "INVALID_INPUT",
      `calendar end ${to} must not precede start ${from} — choose an end on or after the start`,
    );
  if (inclusiveCalendarDays(from, to) > 366) {
    throw new LeaveError(
      "INVALID_INPUT",
      "the calendar window must not exceed 366 days — choose a shorter date range",
    );
  }
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed !== null && allowed.size === 0) return [];
  const scope =
    allowed === null
      ? sql``
      : sql`and e.employer_subsidiary_id in (${sql.join(
          [...allowed].map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const members = await exec.execute<{
    employment_id: string;
    employer_subsidiary_id: string;
    worker_name: string;
  }>(
    sql`
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
  `,
    "objects",
  );
  const visible = members.filter(
    (member) => allowed === null || allowed.has(member.employer_subsidiary_id),
  );
  const days: DepartmentAbsenceDay[] = [];
  for (const member of visible) {
    await requireHrmLeaveRead(exec, orgId, actorId, member.employment_id);
    const department =
      departmentId === null
        ? sql``
        : sql`and exists (
      select 1 from employment_assignment_versions v
       where v.org_id = a.org_id and v.employment_id = a.employment_id
         and v.is_primary and v.recorded_until is null
         and v.department_id = ${departmentId}
         and v.effective_from <= a.on_date
         and (v.effective_to is null or v.effective_to > a.on_date)
    )`;
    const rows = await exec.execute<{
      id: string;
      on_date: string;
      hours: string;
      code: string;
      source: "request" | "recorded";
      leave_request_id: string | null;
      reason: string | null;
    }>(
      sql`
      select a.id, a.on_date::text as on_date, a.hours::text as hours, t.code, a.source,
             a.leave_request_id, a.reason
        from hrm_absences a join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
       where a.org_id = ${orgId} and a.employment_id = ${member.employment_id}
         and a.on_date >= ${from} and a.on_date <= ${to} ${department}
       order by a.on_date, t.code, a.id
    `,
      "objects",
    );
    // Net each leave type independently: a cancelled vacation and a new
    // sick day on the same date must not inherit each other's type or hours.
    const net = new Map<
      string,
      {
        onDate: string;
        hours: string;
        code: string;
        source: "request" | "recorded";
        id: string;
        leaveRequestId: string | null;
        reason: string | null;
      }
    >();
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
        leaveRequestId: row.leave_request_id != null ? String(row.leave_request_id) : null,
        reason: row.reason != null ? String(row.reason) : null,
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
        reason: entry.reason,
        leaveRequestId: entry.leaveRequestId,
        workerName: member.worker_name,
      });
    }
  }
  days.sort(
    (a, b) =>
      a.onDate.localeCompare(b.onDate) ||
      a.workerName.localeCompare(b.workerName) ||
      a.employmentId.localeCompare(b.employmentId) ||
      a.leaveTypeCode.localeCompare(b.leaveTypeCode),
  );
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
  const rows = await exec.execute<{
    employment_id: string;
    worker_name: string;
    code: string;
    hours: string;
  }>(
    sql`
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
  `,
    "objects",
  );
  return rows.map((row) => ({
    employmentId: row.employment_id,
    workerName: row.worker_name,
    leaveTypeCode: row.code,
    hours: String(row.hours),
  }));
}
