import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { canonicalPeriodLabelSql } from "../periods/period-policy.ts";
import { periodScopeAdvisoryLock } from "../periods/period-locks.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";

export const CLOSE_REOPEN_SUBJECT_KIND = "close_reopen_request";
export const closeReopenSubjectProfile: FlowSubjectProfile = {
  subjectKind: CLOSE_REOPEN_SUBJECT_KIND,
  label: "Period reopen request",
  pinsSubmissionPolicy: true,
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: ["requested", "approved", "rejected", "withdrawn", "reclosed", "superseded"].map(
    (value) => ({ value, label: value }),
  ),
  fields: [
    { key: "periodLabel", label: "Accounting period", type: "text" },
    { key: "bookId", label: "Accounting book", type: "text" },
    { key: "subsidiaryId", label: "Legal entity", type: "text" },
    { key: "modules", label: "Modules", type: "text" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "requestedBy", label: "Requester", type: "user" },
    { key: "status", label: "Status", type: "enum" },
  ],
};

export const closeReopenRequestsFlowAdapter = defineTableSubjectAdapter({
  subjectKind: CLOSE_REOPEN_SUBJECT_KIND,
  profile: closeReopenSubjectProfile,
  permissions: {
    read: "close.read",
    edit: "close.reopen",
    approve: "close.reopen",
  },
  scope: tableScope("column", "close_reopen_requests", "subsidiary_id"),
  releaseViaHandler: true,
  async lockDecisionResources(orgId, id) {
    const row = (
      await db.execute<{ period_id: string; book_id: string }>(
        sql`
      select period_id,book_id from close_reopen_requests where org_id=${orgId} and id=${id}
    `,
        "objects",
      )
    )[0];
    if (!row) throw new Error("Period reopen request not found.");
    await periodScopeAdvisoryLock(db, orgId, row.period_id, row.book_id);
  },
  async loadContext(id) {
    const row = (
      await db.execute<{
        id: string;
        periodLabel: string;
        bookId: string;
        subsidiaryId: string | null;
        modules: string[];
        reason: string;
        requestedBy: string;
        status: string;
      }>(
        sql`
      select r.id,${canonicalPeriodLabelSql()} as "periodLabel",r.book_id as "bookId",
        r.subsidiary_id as "subsidiaryId",r.modules,r.reason,r.requested_by as "requestedBy",r.status
      from close_reopen_requests r join accounting_periods p on p.org_id=r.org_id and p.id=r.period_id
      where r.id=${id}
    `,
        "objects",
      )
    )[0];
    return row
      ? {
          values: { ...row, modules: row.modules.join(", ") },
          submitterUserId: row.requestedBy,
        }
      : null;
  },
  label(id, values) {
    return `Period reopen · ${String(values.periodLabel ?? id)}`;
  },
  deepLink(id) {
    return `/accounting/reopen-requests?request=${id}`;
  },
  async getStatus(id) {
    return (
      (
        await db.execute<{ status: string }>(
          sql`select status from close_reopen_requests where id=${id}`,
          "objects",
        )
      )[0]?.status ?? null
    );
  },
  async changeStatus() {
    throw new Error("Use the native period reopen command.");
  },
  async setField() {
    throw new Error("Reopen scope and reason are immutable; withdraw and submit a new request.");
  },
  async releaseApproval(subjectId, outcome, ctx, detail, run) {
    await releaseFlowApproval({
      subjectKind: CLOSE_REOPEN_SUBJECT_KIND,
      subjectId,
      outcome,
      ctx,
      comment: detail?.comment,
      approvalRunId: run?.id,
    });
  },
});
