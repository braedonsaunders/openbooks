import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";

export const STOCK_COUNT_SUBJECT_KIND = "stock_count";
export const stockCountSubjectProfile: FlowSubjectProfile = {
  subjectKind: STOCK_COUNT_SUBJECT_KIND,
  label: "Stock count",
  pinsSubmissionPolicy: true,
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: ["draft", "counting", "review", "posted", "cancelled"].map((value) => ({
    value,
    label: value,
  })),
  fields: [
    { key: "status", label: "Status", type: "enum" },
    { key: "countedOn", label: "Count date", type: "date" },
    { key: "subsidiaryId", label: "Legal entity", type: "text" },
    { key: "locationId", label: "Warehouse", type: "text" },
    { key: "memo", label: "Memo", type: "text" },
    { key: "variance", label: "Quantity variance", type: "number" },
  ],
};
export const stockCountsFlowAdapter = defineTableSubjectAdapter({
  subjectKind: STOCK_COUNT_SUBJECT_KIND,
  profile: stockCountSubjectProfile,
  permissions: {
    read: "items.read",
    edit: "items.post",
    approve: "items.post",
  },
  scope: tableScope("column", "stock_counts", "subsidiary_id"),
  releaseViaHandler: true,
  async loadContext(id) {
    const row = (
      await db.execute<{
        id: string;
        org_id: string;
        status: string;
        subsidiaryId: string;
        locationId: string;
        countedOn: string;
        memo: string | null;
        created_by: string | null;
        submitted_by: string | null;
        variance: string;
      }>(
        sql`
      select c.id,c.org_id,c.status,c.subsidiary_id as "subsidiaryId",c.location_id as "locationId",
        c.counted_on::text as "countedOn",c.memo,c.created_by,c.submitted_by,
        (select coalesce(sum(l.counted_quantity-l.expected_quantity),0)::text from stock_count_lines l where l.org_id=c.org_id and l.stock_count_id=c.id) as variance
      from stock_counts c where c.id=${id}`,
        "objects",
      )
    )[0];
    if (!row) return null;
    const authors = await db.execute<{ id: string }>(
      sql`
      select distinct actor as id from (
        select created_by as actor from stock_counts where org_id=${row.org_id} and id=${id}
        union select first_counted_by from stock_count_lines where org_id=${row.org_id} and stock_count_id=${id}
        union select second_counted_by from stock_count_lines where org_id=${row.org_id} and stock_count_id=${id}
        union select actor_id from audit_log where org_id=${row.org_id} and table_name='stock_count_lines' and changes->>'countId'=${id}
      ) authors where actor is not null`,
      "objects",
    );
    return {
      values: { ...row },
      submitterUserId: row.submitted_by,
      makerUserId: row.created_by,
      makerUserIds: authors.map((author) => author.id),
    };
  },
  label(id, values) {
    return `Stock count · ${String(values.countedOn ?? id)}`;
  },
  deepLink(id) {
    return `/inventory?view=counts&count=${id}`;
  },
  async getStatus(id) {
    return (
      (
        await db.execute<{ status: string }>(
          sql`select status from stock_counts where id=${id}`,
          "objects",
        )
      )[0]?.status ?? null
    );
  },
  async changeStatus() {
    throw new Error("Use the native stock count lifecycle.");
  },
  async setField() {
    throw new Error("Return the count to counting before editing it.");
  },
  async releaseApproval(subjectId, outcome, ctx, detail, run) {
    await releaseFlowApproval({
      subjectKind: STOCK_COUNT_SUBJECT_KIND,
      subjectId,
      outcome,
      ctx,
      comment: detail?.comment,
      approvalRunId: run?.id,
    });
  },
});
