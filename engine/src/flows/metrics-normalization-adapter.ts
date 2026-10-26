import { approvalRequestHref } from "./review-links.ts";
import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
export const METRICS_NORMALIZATION_SUBJECT_KIND = "metrics_normalization";
export const metricsNormalizationSubjectProfile: FlowSubjectProfile = {
  subjectKind: METRICS_NORMALIZATION_SUBJECT_KIND,
  label: "SaaS metrics correction",
  pinsSubmissionPolicy: true,
  triggers: ["on_submit"],
  actions: ["notify", "send_email"],
  statuses: ["pending", "running", "succeeded", "failed", "cancelled"].map((value) => ({
    value,
    label: value,
  })),
  fields: [
    { key: "month", label: "Reporting month", type: "date" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "requestedBy", label: "Requester", type: "user" },
    { key: "status", label: "Status", type: "enum" },
  ],
};
async function load(id: string) {
  return (
    (
      await db.execute<{
        requestedBy: string;
        status: string;
        [key: string]: unknown;
      }>(
        sql`
 select id,month::text,reason,status,requested_by as "requestedBy",request_hash as "requestHash"
 from saas_metrics_normalization_requests where id=${id}`,
        "objects",
      )
    )[0] ?? null
  );
}
export const metricsNormalizationFlowAdapter = defineTableSubjectAdapter({
  subjectKind: METRICS_NORMALIZATION_SUBJECT_KIND,
  profile: metricsNormalizationSubjectProfile,
  permissions: {
    read: "usage.read",
    edit: "usage.manage",
    approve: "usage.manage",
  },
  scope: { via: "none" },
  releaseViaHandler: true,
  async loadContext(id) {
    const row = await load(id);
    return row
      ? {
          values: row,
          submitterUserId: row.requestedBy,
          makerUserId: row.requestedBy,
        }
      : null;
  },
  async getStatus(id) {
    return (await load(id))?.status ?? null;
  },
  label(id, values) {
    return `SaaS metrics · ${String(values.month ?? id)}`;
  },
  deepLink(id) {
    return approvalRequestHref(METRICS_NORMALIZATION_SUBJECT_KIND, id);
  },
  async changeStatus() {
    throw new Error("Use the native correction lifecycle and Flow gates.");
  },
  async setField() {
    throw new Error("Correction requests are immutable; cancel and file a new request.");
  },
  async releaseApproval(subjectId, outcome, ctx, detail, run) {
    await releaseFlowApproval({
      subjectKind: METRICS_NORMALIZATION_SUBJECT_KIND,
      subjectId,
      outcome,
      ctx,
      approvalRunId: run?.id,
      comment: detail?.comment,
    });
  },
});
