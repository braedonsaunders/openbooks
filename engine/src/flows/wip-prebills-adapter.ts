import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { tableScope } from "./subject-scope.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

/**
 * Pre-billing worksheets as flow subjects.
 *
 * Approval of a worksheet is owned by Flows, like every other approval:
 * submitting a draft fires `on_submit`, and an enabled flow that raises a gate
 * parks the worksheet in `review` until the flow decides. An organization with
 * no gating flow has no worksheet approval at all — the submit releases the
 * worksheet straight to `approved`.
 *
 * The adapter owns the approval lifecycle only. Status is released inside the
 * pre-billing service through the registered handler (releaseViaHandler): the
 * worksheet's lines and amounts are the thing being approved, and a flow must
 * not rewrite them. Neither the preparer nor the submitter may decide its gate.
 */

export const WIP_PREBILL_SUBJECT_KIND = "wip_prebill";

const WIP_PREBILL_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "customer_review", label: "With customer" },
  { value: "converted", label: "Invoiced" },
  { value: "void", label: "Void" },
] as const;

export const wipPrebillSubjectProfile: FlowSubjectProfile = {
  subjectKind: WIP_PREBILL_SUBJECT_KIND,
  label: "Pre-billing worksheet",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...WIP_PREBILL_STATUSES],
  fields: [
    { key: "worksheetNumber", label: "Worksheet number", type: "text" },
    { key: "status", label: "Status", type: "enum" },
    { key: "projectId", label: "Project", type: "text" },
    { key: "projectCode", label: "Project code", type: "text" },
    { key: "projectName", label: "Project name", type: "text" },
    { key: "projectTypeName", label: "Project type", type: "text" },
    { key: "customerId", label: "Customer", type: "text" },
    { key: "customerName", label: "Customer name", type: "text" },
    { key: "periodStart", label: "Period start", type: "date" },
    { key: "periodEnd", label: "Period end", type: "date" },
    { key: "proposedBillAmount", label: "Amount to bill", type: "number" },
    { key: "originalBillAmount", label: "Standard value", type: "number" },
    { key: "adjustmentAmount", label: "Net adjustment", type: "number" },
    { key: "writeDownAmount", label: "Write-downs", type: "number" },
    { key: "costAmount", label: "Cost", type: "number" },
    { key: "lineCount", label: "Lines to bill", type: "number" },
    { key: "heldLineCount", label: "Held lines", type: "number" },
    { key: "createdBy", label: "Prepared by", type: "user" },
    { key: "submittedBy", label: "Submitted by", type: "user" },
    { key: "event_source", label: "Event source", type: "enum", options: [...EVENT_SOURCE_OPTIONS] },
  ],
};

type WipPrebillRow = {
  id: string;
  worksheet_number: string;
  status: string;
  project_id: string;
  project_code: string | null;
  project_name: string | null;
  project_type_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  period_start: string | null;
  period_end: string;
  proposed_bill_amount: string;
  original_bill_amount: string;
  adjustment_amount: string;
  write_down_amount: string;
  cost_amount: string;
  line_count: number;
  held_line_count: number;
  created_by: string | null;
  submitted_by: string | null;
};

async function loadPrebill(subjectId: string): Promise<WipPrebillRow | null> {
  const result = await db.execute<WipPrebillRow>(sql`
    select w.id, w.worksheet_number, w.status, w.project_id,
           p.code as project_code, p.name as project_name, t.name as project_type_name,
           p.customer_id, customer.display_name as customer_name,
           w.period_start::text as period_start, w.period_end::text as period_end,
           w.proposed_bill_amount::text as proposed_bill_amount,
           w.original_bill_amount::text as original_bill_amount,
           w.adjustment_amount::text as adjustment_amount,
           coalesce((select sum(-l.adjustment_amount) from wip_prebill_lines l
                      where l.org_id = w.org_id and l.prebill_id = w.id
                        and l.disposition = 'bill' and l.adjustment_amount < 0), 0)::text as write_down_amount,
           w.cost_amount::text as cost_amount,
           (select count(*)::int from wip_prebill_lines l
             where l.org_id = w.org_id and l.prebill_id = w.id and l.disposition = 'bill') as line_count,
           (select count(*)::int from wip_prebill_lines l
             where l.org_id = w.org_id and l.prebill_id = w.id and l.disposition = 'hold') as held_line_count,
           w.created_by, w.submitted_by
      from wip_prebills w
      join projects p on p.id = w.project_id and p.org_id = w.org_id
      left join project_types t on t.id = p.project_type_id and t.org_id = p.org_id
      left join parties customer on customer.id = p.customer_id and customer.org_id = p.org_id
     where w.id = ${subjectId}
  `);
  return result.rows[0] ?? null;
}

export const wipPrebillsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: WIP_PREBILL_SUBJECT_KIND,
  permissions: { read: "projects.read", edit: "projects.manage", approve: "ar.approve" },
  scope: tableScope("project", "wip_prebills", "project_id"),
  profile: wipPrebillSubjectProfile,
  releaseViaHandler: true,
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const row = await loadPrebill(subjectId);
    if (!row) return null;
    return {
      values: {
        id: row.id,
        worksheetNumber: row.worksheet_number,
        status: row.status,
        projectId: row.project_id,
        projectCode: row.project_code,
        projectName: row.project_name,
        projectTypeName: row.project_type_name,
        customerId: row.customer_id,
        customerName: row.customer_name,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        proposedBillAmount: row.proposed_bill_amount,
        originalBillAmount: row.original_bill_amount,
        adjustmentAmount: row.adjustment_amount,
        writeDownAmount: row.write_down_amount,
        costAmount: row.cost_amount,
        lineCount: row.line_count,
        heldLineCount: row.held_line_count,
        createdBy: row.created_by,
        submittedBy: row.submitted_by,
      },
      submitterUserId: row.submitted_by,
      makerUserId: row.created_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const number = String(values.worksheetNumber ?? subjectId);
    const project = values.projectName ? ` — ${String(values.projectName)}` : "";
    return `Pre-billing ${number}${project}`;
  },

  deepLink(subjectId: string): string {
    return `/projects/wip-billing?prebill=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadPrebill(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error("pre-billing status is released by the approval engine, not a flow action");
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: WIP_PREBILL_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
    });
  },

  /**
   * A retried flow run that now gates parks the worksheet, exactly as the
   * first submission would have. Only a draft with lines to bill moves; a
   * worksheet already in review is left alone, and anything else refuses so
   * the retried run fails closed instead of gating a worksheet that cannot be
   * released.
   */
  async markAwaitingApproval(subjectId: string, ctx: FlowExecCtx): Promise<void> {
    const parked = await db.execute<{ id: string }>(sql`
      update wip_prebills w
         set status = 'review',
             submitted_at = coalesce(w.submitted_at, now()),
             submitted_by = coalesce(w.submitted_by, ${ctx.userId ?? null}::uuid),
             updated_at = now(), updated_by = ${ctx.userId ?? null}
       where w.id = ${subjectId} and w.org_id = ${ctx.orgId} and w.status = 'draft'
         and exists (select 1 from wip_prebill_lines l
                      where l.org_id = w.org_id and l.prebill_id = w.id and l.disposition = 'bill')
      returning w.id
    `);
    if (parked.rows[0]) {
      // The trail always names an actor: the retrying user, else whoever
      // submitted or prepared the worksheet.
      await db.execute(sql`
        insert into wip_prebill_events (org_id, prebill_id, event_type, actor_id, details)
        select w.org_id, w.id, 'submitted', coalesce(${ctx.userId ?? null}::uuid, w.submitted_by, w.created_by),
               ${JSON.stringify({ source: "flow_retry" })}::jsonb
          from wip_prebills w
         where w.id = ${subjectId} and w.org_id = ${ctx.orgId}
      `);
      return;
    }
    const current = (await loadPrebill(subjectId))?.status ?? null;
    if (current !== "review") {
      throw new Error(`pre-billing worksheet is ${current ?? "missing"}; only a submitted draft can await approval`);
    }
  },

  async setField(): Promise<void> {
    throw new Error("pre-billing fields are not writable by flows; edit the draft worksheet");
  },

  /** Worksheets awaiting a decision, for scheduled fan-out (reminders). */
  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(`findCandidateIds for "${WIP_PREBILL_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`);
    }
    const result = await db.execute<{ id: string }>(sql`
      select id::text as id from wip_prebills
       where org_id = ${orgId} and status = 'review'
       order by submitted_at desc nulls last
       limit ${limit}
    `);
    return result.rows.map((row) => row.id);
  },
});
