import { sql } from "drizzle-orm";
import { CHECKLIST_STEP_SUBJECT_KIND, type FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import type { FlowSubjectAdapter } from "./types.ts";
export const checklistStepSubjectProfile: FlowSubjectProfile = {
  subjectKind: CHECKLIST_STEP_SUBJECT_KIND,
  label: "HRM checklist step",
  triggers: ["on_submit"],
  actions: ["notify", "send_email"],
  statuses: ["none", "pending", "approved", "rejected"].map((value) => ({ value, label: value })),
  fields: [
    { key: "title", label: "Step", type: "text" },
    {
      key: "kind",
      label: "Process type",
      type: "enum",
      options: ["onboarding", "offboarding", "transfer"].map((value) => ({ value, label: value })),
    },
    { key: "employmentId", label: "Employment", type: "text" },
    { key: "legalEntityId", label: "Legal employer", type: "text" },
    { key: "dueOn", label: "Due date", type: "date" },
    { key: "section", label: "Section", type: "text" },
    { key: "status", label: "Approval status", type: "enum" },
  ],
};
async function load(id: string) {
  return (
    (
      await db.execute<{
        org_id: string;
        title: string;
        kind: string;
        employment_id: string;
        employer_subsidiary_id: string;
        due_on: string;
        design: { section?: string };
        approval_status: string;
        submitted_by: string | null;
        created_by: string | null;
      }>(sql`
    select s.org_id,s.title,p.kind,p.employment_id,e.employer_subsidiary_id,s.due_on::text,s.design,s.approval_status,s.submitted_by,s.created_by
    from hrm_process_steps s join hrm_processes p on p.org_id=s.org_id and p.id=s.process_id
    join worker_employments e on e.org_id=p.org_id and e.id=p.employment_id where s.id=${id}`)
    ).rows[0] ?? null
  );
}
export const checklistStepsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: CHECKLIST_STEP_SUBJECT_KIND,
  profile: checklistStepSubjectProfile,
  permissions: {
    read: "hrm.process.read",
    edit: "hrm.process.manage",
    approve: "hrm.process.manage",
  },
  scope: {
    via: "custom",
    async subsidiaryOf(orgId, ids, allowed, lock) {
      if (lock)
        await db.execute(
          sql`select p.id from hrm_processes p where p.org_id=${orgId} and p.id in(select process_id from hrm_process_steps where org_id=${orgId} and id in(select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as ids(value))) order by p.id for share`,
        );
      const rows = (
        await db.execute<{ id: string; employer_subsidiary_id: string }>(
          sql`select s.id,e.employer_subsidiary_id from hrm_process_steps s join hrm_processes p on p.org_id=s.org_id and p.id=s.process_id join worker_employments e on e.org_id=p.org_id and e.id=p.employment_id where s.org_id=${orgId} and s.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as ids(value)) ${lock ? sql`for share of s,e` : sql``}`,
        )
      ).rows;
      return new Map(
        rows
          .filter((r) => allowed === null || allowed.has(r.employer_subsidiary_id))
          .map((r) => [r.id, r.employer_subsidiary_id]),
      );
    },
    worklistPredicate(allowedIdsJson) {
      return sql`exists(select 1 from hrm_process_steps cs join hrm_processes cp on cp.org_id=cs.org_id and cp.id=cs.process_id join worker_employments ce on ce.org_id=cp.org_id and ce.id=cp.employment_id where cs.org_id=g.org_id and cs.id=g.subject_id and ce.employer_subsidiary_id in(select value::uuid from jsonb_array_elements_text(${allowedIdsJson}::jsonb) as ids(value)))`;
    },
  },
  selfApprovalPolicy: "forbidden",
  releaseViaHandler: true,
  async loadContext(id) {
    const s = await load(id);
    return s
      ? {
          values: {
            title: s.title,
            kind: s.kind,
            employmentId: s.employment_id,
            legalEntityId: s.employer_subsidiary_id,
            dueOn: s.due_on,
            section: s.design.section ?? "",
            status: s.approval_status,
          },
          submitterUserId: s.submitted_by,
          makerUserId: s.submitted_by,
        }
      : null;
  },
  async getStatus(id) {
    return (await load(id))?.approval_status ?? null;
  },
  label(_id, values) {
    return `Checklist step ${String(values.title ?? "")}`;
  },
  deepLink(id) {
    return `/hrm/processes?step=${id}`;
  },
  async changeStatus() {
    throw new Error(
      "Checklist approvals resolve through their native gate decision; do not change status through a workflow action.",
    );
  },
  async setField() {
    throw new Error("Checklist execution snapshots cannot be edited through workflow actions.");
  },
  async releaseApproval(subjectId, outcome, ctx, detail) {
    await releaseFlowApproval({
      subjectKind: CHECKLIST_STEP_SUBJECT_KIND,
      subjectId,
      outcome,
      ctx,
      comment: detail?.comment,
    });
  },
});
