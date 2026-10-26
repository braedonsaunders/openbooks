import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";

export const SALES_QUOTA_SUBJECT_KIND = "sales_quota";
export const salesQuotaSubjectProfile: FlowSubjectProfile = {
  subjectKind: SALES_QUOTA_SUBJECT_KIND,
  label: "Sales quota",
  pinsSubmissionPolicy: true,
  triggers: ["on_submit"],
  actions: ["notify", "send_email"],
  statuses: ["draft", "pending_approval", "approved", "superseded", "closed"].map((value) => ({
    value,
    label: value,
  })),
  fields: [
    { key: "name", label: "Quota", type: "text" },
    { key: "amount", label: "Target", type: "number" },
    { key: "currency", label: "Currency", type: "text" },
    { key: "metric", label: "Metric", type: "text" },
    { key: "employeeId", label: "Representative", type: "text" },
    { key: "salesTeamId", label: "Team", type: "text" },
    { key: "periodStart", label: "Starts", type: "date" },
    { key: "periodEnd", label: "Ends", type: "date" },
    { key: "subsidiaryId", label: "Legal entity", type: "text" },
    { key: "status", label: "Status", type: "enum" },
  ],
};
async function load(id: string) {
  return (
    (
      await db.execute<{
        createdBy: string | null;
        submittedBy: string | null;
        status: string;
        [key: string]: unknown;
      }>(
        sql`
    select id,name,amount::text,currency,metric,lifecycle as status,revision,
      employee_id as "employeeId",sales_team_id as "salesTeamId",subsidiary_id as "subsidiaryId",
      period_start::text as "periodStart",period_end::text as "periodEnd",reason,
      created_by as "createdBy",submitted_by as "submittedBy"
    from crm_sales_quotas where id=${id}`,
        "objects",
      )
    )[0] ?? null
  );
}
export const salesQuotasFlowAdapter = defineTableSubjectAdapter({
  subjectKind: SALES_QUOTA_SUBJECT_KIND,
  profile: salesQuotaSubjectProfile,
  permissions: {
    read: "crm.read",
    edit: "crm.setup.manage",
    approve: "crm.forecasts.override",
  },
  scope: tableScope("column", "crm_sales_quotas", "subsidiary_id"),
  releaseViaHandler: true,
  async loadContext(id) {
    const row = await load(id);
    return row
      ? {
          values: row,
          submitterUserId: row.submittedBy ?? row.createdBy,
          makerUserId: row.createdBy,
        }
      : null;
  },
  async getStatus(id) {
    return (await load(id))?.status ?? null;
  },
  label(id, values) {
    return String(values.name ?? id);
  },
  deepLink(id) {
    return `/crm/sales/quotas?row=${id}`;
  },
  async changeStatus() {
    throw new Error("Use native quota submission and Flow gates.");
  },
  async setField() {
    throw new Error("Return the quota to draft before editing it.");
  },
  async releaseApproval(subjectId, outcome, ctx, detail, run) {
    await releaseFlowApproval({
      subjectKind: SALES_QUOTA_SUBJECT_KIND,
      subjectId,
      outcome,
      ctx,
      comment: detail?.comment,
      approvalRunId: run?.id,
    });
  },
});
