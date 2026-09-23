/**
 * HR-20 crew_time_batch flow subject.
 *
 * The subject is a crew_time_batches row: the foreman's batch per
 * project per day. Stages from time_approval_stages are Flows gates;
 * the crew service advances batch status as gates release. Hours stay
 * in the lines — a flow must not rewrite the thing it is approving.
 */

import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type { FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { BUILT_IN_ROLE_NAMES, EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";

export const CREW_TIME_BATCH_SUBJECT_KIND = "crew_time_batch" as const;

const CREW_BATCH_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "approved_stage_1", label: "Stage 1 approved" },
  { value: "approved_stage_2", label: "Stage 2 approved" },
  { value: "rejected", label: "Rejected" },
  { value: "posted", label: "Posted" },
] as const;

export const crewBatchSubjectProfile: FlowSubjectProfile = {
  subjectKind: CREW_TIME_BATCH_SUBJECT_KIND,
  label: "Crew time batch",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...CREW_BATCH_STATUSES],
  fields: [
    { key: "foremanId", label: "Foreman", type: "text" },
    { key: "foremanName", label: "Foreman name", type: "text" },
    { key: "projectId", label: "Project", type: "text" },
    { key: "projectName", label: "Project name", type: "text" },
    { key: "workedOn", label: "Worked on", type: "date" },
    { key: "status", label: "Status", type: "enum", options: [...CREW_BATCH_STATUSES] },
    { key: "totalHours", label: "Total hours", type: "number" },
    { key: "lineCount", label: "Crew lines", type: "number" },
    { key: "workerCount", label: "Workers", type: "number" },
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

type BatchRow = {
  org_id: string;
  foreman_name: string | null;
  foreman_party_id: string;
  project_id: string;
  project_name: string | null;
  worked_on: string;
  status: string;
  total_hours: string;
  line_count: number;
  worker_count: number;
  submitted_by: string | null;
};

async function loadBatchSummary(subjectId: string): Promise<BatchRow | null> {
  if (!UUID_RE.test(subjectId)) return null;
  const result = (await db.execute<BatchRow>(sql`
    select b.org_id,
           foreman.display_name as foreman_name,
           b.foreman_party_id::text as foreman_party_id,
           b.project_id::text as project_id,
           project.name as project_name,
           b.worked_on::text as worked_on,
           b.status,
           coalesce(sum(l.hours), 0)::text as total_hours,
           count(l.id)::int as line_count,
           count(distinct l.employee_party_id)::int as worker_count,
           coalesce(b.updated_by, b.created_by)::text as submitted_by
      from crew_time_batches b
      left join parties foreman
        on foreman.id = b.foreman_party_id and foreman.org_id = b.org_id
      left join projects project
        on project.id = b.project_id and project.org_id = b.org_id
      left join crew_time_batch_lines l on l.batch_id = b.id
     where b.id = ${subjectId}
     group by b.org_id, foreman.display_name, b.foreman_party_id, b.project_id,
              project.name, b.worked_on, b.status, b.updated_by, b.created_by
  `));
  return result.rows[0] ?? null;
}

export const crewBatchFlowAdapter: FlowSubjectAdapter = {
  subjectKind: CREW_TIME_BATCH_SUBJECT_KIND,
  profile: crewBatchSubjectProfile,
  writableFields: new Set<string>(),
  // releaseApproval below delegates to the web hook: this kind needs a
  // handler registered at web boot (see webHookReleasedSubjectKinds).
  releaseViaWebHook: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const batch = await loadBatchSummary(subjectId);
    if (!batch) return null;
    const lines = (await db.execute<Record<string, unknown>>(sql`
      select l.employee_party_id as "employeeId", worker.display_name as "employeeName",
             l.hours::text as "hours", l.time_type_id as "timeTypeId",
             l.project_task_id as "projectTaskId", l.cost_code_ref as "costCodeRef",
             l.equipment_id as "equipmentId", l.equipment_hours::text as "equipmentHours",
             l.memo as "memo"
        from crew_time_batch_lines l
        left join parties worker
          on worker.id = l.employee_party_id
       where l.batch_id = ${subjectId}
       order by worker.display_name, l.id
    `));
    return {
      values: {
        id: subjectId,
        foremanId: batch.foreman_party_id,
        foremanName: batch.foreman_name,
        projectId: batch.project_id,
        projectName: batch.project_name,
        workedOn: batch.worked_on,
        status: batch.status,
        totalHours: batch.total_hours,
        lineCount: batch.line_count,
        workerCount: batch.worker_count,
        submittedBy: batch.submitted_by,
      },
      rows: { crewLines: lines.rows },
      submitterUserId: batch.submitted_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const who = values.foremanName ? String(values.foremanName) : "Crew batch";
    return `${who} — ${String(values.workedOn ?? subjectId)}`;
  },

  deepLink(subjectId: string): string {
    return `/time/crew?batch=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadBatchSummary(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "crew batch status is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(subjectId, outcome, ctx, detail): Promise<void> {
    await releaseFlowApproval({
      subjectKind: CREW_TIME_BATCH_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
    });
  },

  async setField(): Promise<void> {
    throw new Error("crew hours are not writable by flows; edit the batch");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    // Same tenant-boundary rule as the timesheet adapter: the explicit
    // org predicate, never ambient RLS alone.
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${CREW_TIME_BATCH_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = (await db.execute<{ id: string }>(sql`
      select id::text as id from crew_time_batches
       where org_id = ${orgId}
         and status in ('submitted', 'approved_stage_1')
       order by worked_on desc
       limit ${limit}
    `));
    return result.rows.map((row) => row.id);
  },
};
