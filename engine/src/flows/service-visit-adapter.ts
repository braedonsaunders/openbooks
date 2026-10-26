import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { tableScope } from "./subject-scope.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

/**
 * Service visit completions as Flow subjects.
 *
 * Review is optional: an organization that authors a Service visit
 * completion Flow with an approval gate holds each completed visit for the
 * reviewer before it can be invoiced; without one, completion releases at
 * once and records that no review applied. A rejection returns the visit to
 * on site with the reviewer's reason so the technician can correct it. The
 * decision is applied by the service module through the registered release
 * handler, inside the gate decision's transaction.
 */
export const SERVICE_VISIT_COMPLETION_SUBJECT_KIND = "service_visit_completion";

const STATUSES = [
  { value: "pending", label: "Awaiting review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Returned for correction" },
  { value: "not_required", label: "No review applied" },
] as const;

export const serviceVisitCompletionSubjectProfile: FlowSubjectProfile = {
  subjectKind: SERVICE_VISIT_COMPLETION_SUBJECT_KIND,
  pinsSubmissionPolicy: true,
  label: "Service visit completion",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...STATUSES],
  fields: [
    { key: "status", label: "Review status", type: "enum" },
    { key: "jobNumber", label: "Job", type: "text" },
    { key: "jobTitle", label: "Job title", type: "text" },
    { key: "customerName", label: "Customer", type: "text" },
    {
      key: "visitKind",
      label: "Visit",
      type: "enum",
      options: [
        { value: "assessment", label: "Assessment" },
        { value: "service", label: "Service" },
      ],
    },
    {
      key: "priority",
      label: "Priority",
      type: "enum",
      options: [
        { value: "low", label: "Low" },
        { value: "normal", label: "Normal" },
        { value: "high", label: "High" },
        { value: "urgent", label: "Urgent" },
      ],
    },
    { key: "completedOn", label: "Completed on", type: "date" },
    { key: "workNotes", label: "Work notes", type: "text" },
    { key: "partsCount", label: "Parts used", type: "number" },
    { key: "laborHours", label: "Labor hours", type: "text" },
    { key: "completedBy", label: "Completed by", type: "user" },
  ],
};

type CompletionRow = {
  id: string;
  review_status: string | null;
  job_number: string;
  job_title: string;
  customer_name: string;
  kind: string;
  priority: string;
  completed_on: string | null;
  work_notes: string | null;
  parts: number;
  labor_hours: string;
  completed_by: string | null;
};

async function loadCompletion(subjectId: string): Promise<CompletionRow | null> {
  const orgId = ambientTenantOrgId();
  if (!orgId) throw new Error("Service visit completions require a native tenant context.");
  return (
    (
      await db.execute<CompletionRow>(
        sql`
    select v.id, v.review_status, coalesce(j.job_number, r.request_number) as job_number, coalesce(j.title, r.title) as job_title,
           p.display_name as customer_name, v.kind, v.priority, (v.completed_at at time zone 'UTC')::date::text as completed_on, v.work_notes,
           (select count(*)::int from service_visit_parts sp where sp.org_id = v.org_id and sp.visit_id = v.id) as parts,
           (select coalesce(sum(te.hours), 0)::text from time_entries te where te.org_id = v.org_id and te.service_visit_id = v.id and te.status <> 'rejected') as labor_hours,
           v.completed_by
      from service_visits v
      left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
      left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
      join parties p on p.org_id = v.org_id and p.id = coalesce(j.customer_party_id, r.customer_party_id)
     where v.org_id = ${orgId} and v.id = ${subjectId}`,
        "objects",
      )
    )[0] ?? null
  );
}

export const serviceVisitCompletionsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: SERVICE_VISIT_COMPLETION_SUBJECT_KIND,
  permissions: {
    read: "service.read",
    edit: "service.manage",
    approve: "service.manage",
  },
  scope: tableScope("column", "service_visits", "subsidiary_id"),
  profile: serviceVisitCompletionSubjectProfile,
  releaseViaHandler: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const row = await loadCompletion(subjectId);
    if (!row) return null;
    return {
      values: {
        id: row.id,
        status: row.review_status,
        jobNumber: row.job_number,
        jobTitle: row.job_title,
        customerName: row.customer_name,
        visitKind: row.kind,
        priority: row.priority,
        completedOn: row.completed_on,
        workNotes: row.work_notes,
        partsCount: row.parts,
        laborHours: row.labor_hours,
        completedBy: row.completed_by,
      },
      // The person who completed the visit submits it and may not review it.
      submitterUserId: row.completed_by,
      makerUserId: row.completed_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const customer = values.customerName ? ` — ${String(values.customerName)}` : "";
    return `Visit completion ${String(values.jobNumber ?? subjectId)}${customer}`;
  },

  deepLink(subjectId: string): string {
    return `/service?tab=visits&visit=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadCompletion(subjectId))?.review_status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "visit completion review is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
    run?: { id: string },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: SERVICE_VISIT_COMPLETION_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      approvalRunId: run?.id,
      ctx,
    });
  },

  /** A retried run that now gates leaves the completion awaiting review; anything else fails closed. */
  async markAwaitingApproval(subjectId: string): Promise<void> {
    const status = (await loadCompletion(subjectId))?.review_status ?? null;
    if (status !== "pending")
      throw new Error(
        `visit completion review is ${status ?? "missing"}; only a completion awaiting review can await approval`,
      );
  },

  async setField(): Promise<void> {
    throw new Error("visit completion fields are not writable by flows");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId)
      throw new Error(
        `findCandidateIds for "${SERVICE_VISIT_COMPLETION_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    return (
      await db.execute<{
        id: string;
      }>(
        sql`select id::text as id from service_visits
      where org_id = ${orgId} and review_status = 'pending' order by completed_at desc limit ${limit}`,
        "objects",
      )
    ).map((row) => row.id);
  },
});
