import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../db.ts";
import type {
  FlowExecCtx,
  FlowSubjectAdapter,
  FlowSubjectContext,
} from "./types.ts";
import {
  BUILT_IN_ROLE_NAMES,
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";

export const TIMESHEET_WEEK_SUBJECT_KIND = "timesheet_week";

/**
 * Timesheet weeks as a flow subject.
 *
 * The subject is a `timesheet_weeks` row — a real header per employee per
 * Sunday→Saturday week — so the subject id is an ordinary uuid, the same as
 * every other flow subject. The hours stay in `time_entries`; the header owns
 * the week's lifecycle and its approval stamps.
 *
 * The point of the adapter is that WHO approves a timesheet stops being
 * hard-coded. Routing, quorum, delegation, reminders and escalation all come
 * from the flows the tenant authors, exactly as they do for documents; the
 * timesheet endpoints keep owning what approval MEANS (stamping the week and
 * its entries, clearing rejections) and nothing else.
 */

const TIMESHEET_WEEK_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

export const timesheetWeekSubjectProfile: FlowSubjectProfile = {
  subjectKind: TIMESHEET_WEEK_SUBJECT_KIND,
  label: "Timesheet week",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...TIMESHEET_WEEK_STATUSES],
  fields: [
    { key: "employeeId", label: "Employee", type: "text" },
    { key: "employeeName", label: "Employee name", type: "text" },
    { key: "weekStart", label: "Week starting", type: "date" },
    { key: "weekEnd", label: "Week ending", type: "date" },
    { key: "status", label: "Status", type: "enum", options: [...TIMESHEET_WEEK_STATUSES] },
    { key: "totalHours", label: "Total hours", type: "number" },
    { key: "billableHours", label: "Billable hours", type: "number" },
    { key: "overtimeHours", label: "Hours beyond 40", type: "number" },
    { key: "projectCount", label: "Projects worked", type: "number" },
    { key: "entryCount", label: "Time entries", type: "number" },
    { key: "departmentId", label: "Department", type: "text" },
    { key: "submittedBy", label: "Submitted by", type: "user" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The employee + week a header row identifies, or null when it is gone. */
export async function resolveTimesheetWeek(
  subjectId: string,
  orgId?: string,
): Promise<{ employeePartyId: string; weekStart: string; orgId: string } | null> {
  if (!UUID_RE.test(subjectId)) return null;
  const result = (await db.execute<{ org_id: string; employee_party_id: string; week_start: string }>(sql`
    select org_id, employee_party_id, week_start::text as week_start
      from timesheet_weeks
     where id = ${subjectId}
       ${orgId ? sql`and org_id = ${orgId}` : sql``}
  `));
  const row = result.rows[0];
  if (!row) return null;
  return {
    orgId: row.org_id,
    employeePartyId: row.employee_party_id,
    weekStart: row.week_start,
  };
}

type WeekRow = {
  org_id: string;
  employee_name: string | null;
  employee_party_id: string;
  week_start: string;
  week_end: string;
  status: string;
  total_hours: string;
  billable_hours: string;
  project_count: number;
  entry_count: number;
  department_id: string | null;
  submitted_by: string | null;
};

async function loadWeekSummary(subjectId: string): Promise<WeekRow | null> {
  if (!UUID_RE.test(subjectId)) return null;
  // Status comes from the header — the record's own lifecycle — while the
  // measures aggregate the hours the header covers.
  const result = (await db.execute<WeekRow>(sql`
    select tw.org_id,
           employee.display_name as employee_name,
           tw.employee_party_id as employee_party_id,
           tw.week_start::text as week_start,
           (tw.week_start + 6)::text as week_end,
           tw.status,
           coalesce(sum(te.hours), 0)::text as total_hours,
           coalesce(sum(te.hours) filter (where te.is_billable), 0)::text as billable_hours,
           count(distinct te.project_id)::int as project_count,
           count(te.id)::int as entry_count,
           min(te.department_id::text) as department_id,
           coalesce(tw.submitted_by, tw.created_by)::text as submitted_by
      from timesheet_weeks tw
      left join parties employee
        on employee.id = tw.employee_party_id and employee.org_id = tw.org_id
      left join time_entries te
        on te.org_id = tw.org_id
       and te.employee_party_id = tw.employee_party_id
       and te.worked_on >= tw.week_start
       and te.worked_on <= tw.week_start + 6
     where tw.id = ${subjectId}
     group by tw.org_id, employee.display_name, tw.employee_party_id, tw.week_start,
              tw.status, tw.submitted_by, tw.created_by
  `));
  return result.rows[0] ?? null;
}

export const timesheetWeeksFlowAdapter: FlowSubjectAdapter = {
  subjectKind: TIMESHEET_WEEK_SUBJECT_KIND,
  profile: timesheetWeekSubjectProfile,
  // Nothing on a week is a flow-writable header field: the hours are the
  // record, and a flow must not rewrite the thing it is approving.
  writableFields: new Set<string>(),

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const week = await loadWeekSummary(subjectId);
    if (!week) return null;

    const entries = (await db.execute<Record<string, unknown>>(sql`
      select te.worked_on::text as "workedOn", te.hours::text as "hours",
             te.project_id as "projectId", project.code as "projectCode",
             project.name as "projectName", te.item_id as "itemId",
             te.time_type_id as "timeTypeId", te.department_id as "departmentId",
             te.is_billable as "isBillable", te.status as "status",
             te.memo as "memo"
        from time_entries te
        left join projects project
          on project.id = te.project_id and project.org_id = te.org_id
       where te.org_id = ${week.org_id}
         and te.employee_party_id = ${week.employee_party_id}
         and te.worked_on >= ${week.week_start}::date
         and te.worked_on <= ${week.week_start}::date + 6
       order by te.worked_on, te.id
    `));

    const total = Number(week.total_hours);
    return {
      values: {
        id: subjectId,
        employeeId: week.employee_party_id,
        employeeName: week.employee_name,
        weekStart: week.week_start,
        weekEnd: week.week_end,
        status: week.status,
        totalHours: week.total_hours,
        billableHours: week.billable_hours,
        // Surfaced so a tenant can route long weeks to a second approver
        // without writing SQL in a condition.
        overtimeHours: total > 40 ? Number((total - 40).toFixed(4)) : 0,
        projectCount: week.project_count,
        entryCount: week.entry_count,
        departmentId: week.department_id,
        submittedBy: week.submitted_by,
      },
      rows: { timeEntries: entries.rows },
      submitterUserId: week.submitted_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const who = values.employeeName ? String(values.employeeName) : "Timesheet";
    return `${who} — week of ${String(values.weekStart ?? subjectId)}`;
  },

  deepLink(subjectId: string): string {
    return `/timesheets?timesheet=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadWeekSummary(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "timesheet status is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(subjectId, outcome, ctx, detail): Promise<void> {
    await releaseFlowApproval({
      subjectKind: TIMESHEET_WEEK_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
    });
  },

  async setField(): Promise<void> {
    throw new Error("timesheet hours are not writable by flows; edit the week");
  },

  /** Recent weeks awaiting a decision, for scheduled fan-out (reminders). */
  async findCandidateIds(limit: number): Promise<string[]> {
    const result = (await db.execute<{ id: string }>(sql`
      select id::text as id from timesheet_weeks
       where status in ('draft', 'submitted', 'rejected')
       order by week_start desc
       limit ${limit}
    `));
    return result.rows.map((row) => row.id);
  },
};
