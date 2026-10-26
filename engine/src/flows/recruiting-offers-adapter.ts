import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
export const RECRUITING_OFFER_SUBJECT_KIND = "recruiting_offer";
export const recruitingOfferSubjectProfile: FlowSubjectProfile = {
  subjectKind: RECRUITING_OFFER_SUBJECT_KIND,
  label: "Employment offer",
  pinsSubmissionPolicy: true,
  triggers: ["on_submit"],
  actions: ["notify", "send_email"],
  statuses: ["none", "pending", "approved", "rejected"].map((value) => ({
    value,
    label: value,
  })),
  fields: [
    { key: "jobTitle", label: "Job title", type: "text" },
    { key: "compensationAmount", label: "Compensation", type: "number" },
    { key: "compensationCurrency", label: "Currency", type: "text" },
    { key: "compensationBasis", label: "Pay basis", type: "text" },
    { key: "proposedStartOn", label: "Start date", type: "date" },
    { key: "subsidiaryId", label: "Legal employer", type: "text" },
    { key: "status", label: "Approval status", type: "enum" },
  ],
};
async function load(id: string) {
  return (
    (
      await db.execute<{
        status: string;
        createdBy: string | null;
        submittedBy: string | null;
        [key: string]: unknown;
      }>(
        sql`
 select id,public.offer_approval_fingerprint(hrm_offers) as "approvalFingerprint",job_title as "jobTitle",compensation_amount::text as "compensationAmount",compensation_currency as "compensationCurrency",
 compensation_basis as "compensationBasis",proposed_start_on::text as "proposedStartOn",employer_subsidiary_id as "subsidiaryId",
 version,approval_status as status,created_by as "createdBy",submitted_by as "submittedBy"
 from hrm_offers where id=${id}`,
        "objects",
      )
    )[0] ?? null
  );
}
export const recruitingOffersFlowAdapter = defineTableSubjectAdapter({
  subjectKind: RECRUITING_OFFER_SUBJECT_KIND,
  profile: recruitingOfferSubjectProfile,
  permissions: {
    read: "hrm.recruiting.read",
    edit: "hrm.recruiting.manage",
    approve: "hrm.recruiting.manage",
  },
  scope: tableScope("column", "hrm_offers", "employer_subsidiary_id"),
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
    return String(values.jobTitle ?? id);
  },
  deepLink(id) {
    return `/hrm/recruiting?offer=${id}`;
  },
  async changeStatus() {
    throw new Error("Use native offer submission and Flow gates.");
  },
  async setField() {
    throw new Error("Render revised offer terms before submitting a new version.");
  },
  async releaseApproval(subjectId, outcome, ctx, detail, run) {
    await releaseFlowApproval({
      subjectKind: RECRUITING_OFFER_SUBJECT_KIND,
      subjectId,
      outcome,
      ctx,
      approvalRunId: run?.id,
      comment: detail?.comment,
    });
  },
});
