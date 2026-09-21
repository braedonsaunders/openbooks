import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db, withOrg, withTransactionSavepoint } from "../platform/db.ts";
import { loadFinancialChange } from "../platform/financial-changes.ts";
import {
  BUILT_IN_ROLE_NAMES,
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { runRecordFlows } from "./run.ts";
import type { FlowSubjectAdapter } from "./types.ts";

export const FINANCIAL_CHANGE_SUBJECT_KIND = "financial_change";
export const financialChangeSubjectProfile: FlowSubjectProfile = {
  subjectKind: FINANCIAL_CHANGE_SUBJECT_KIND,
  label: "Accounting lifecycle change",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: ["draft", "pending", "approved", "rejected", "applied"].map(
    (value) => ({ value, label: value }),
  ),
  fields: [
    {
      key: "domain",
      label: "Accounting domain",
      type: "enum",
      options: ["lease", "revenue", "asset", "consolidation"].map((value) => ({
        value,
        label: value,
      })),
    },
    { key: "operation", label: "Change type", type: "text" },
    { key: "effectiveOn", label: "Effective date", type: "date" },
    { key: "subsidiaryId", label: "Legal entity", type: "text" },
    { key: "reason", label: "Reason", type: "text" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};
export const financialChangesFlowAdapter: FlowSubjectAdapter = {
  subjectKind: FINANCIAL_CHANGE_SUBJECT_KIND,
  profile: financialChangeSubjectProfile,
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",
  async loadContext(id) {
    // RLS supplies the org; this adapter never widens the active tenant scope.
    const row = (
      await db.execute<{ org_id: string }>(
        sql`select org_id from financial_changes where id=${id}`,
      )
    ).rows[0];
    if (!row) return null;
    const change = await loadFinancialChange(db, row.org_id, id);
    return {
      values: {
        id,
        domain: change.domain,
        operation: change.operation,
        effectiveOn: change.effective_on,
        subsidiaryId: change.subsidiary_id,
        reason: change.reason,
        status: change.status,
      },
      submitterUserId: change.submitted_by,
    };
  },
  label(id, values) {
    return `${String(values.domain)} ${String(values.operation)} · ${String(values.effectiveOn ?? id)}`;
  },
  deepLink(id) {
    return `/accounting/changes?change=${id}`;
  },
  async getStatus(id) {
    const row = (
      await db.execute<{ status: string }>(
        sql`select status from financial_changes where id=${id}`,
      )
    ).rows[0];
    return row?.status ?? null;
  },
  async changeStatus() {
    throw new Error(
      "accounting change decisions are controlled by the approval gate",
    );
  },
  async setField() {
    throw new Error(
      "accounting change proposals are immutable; submit a new proposal",
    );
  },
  async releaseApproval(id, outcome, ctx) {
    const row = await loadFinancialChange(db, ctx.orgId, id);
    if (row.status !== "pending") return;
    if (!ctx.userId || row.submitted_by === ctx.userId)
      throw new Error("an independent signed-in approver is required");
    const allowed = await actorAllowedSubsidiaryIds(db, ctx.orgId, ctx.userId);
    const required = Array.isArray(row.payload.requiredSubsidiaryIds)
      ? row.payload.requiredSubsidiaryIds
      : [row.subsidiary_id];
    if (
      allowed &&
      required.some((id) => typeof id !== "string" || !allowed.has(id))
    )
      throw new Error(
        "this approval includes a legal entity outside your authorization",
      );
    const updated = await db.execute(sql`
      update financial_changes set status=${outcome},approved_by=${ctx.userId},approved_at=now(),
        updated_by=${ctx.userId},updated_at=now()
       where org_id=${ctx.orgId} and id=${id} and status='pending' returning id
    `);
    if (updated.rows.length !== 1)
      throw new Error("accounting change decision could not be recorded");
  },
};

/** Called in the domain request transaction after authorization/measurement.
 * Zero gates is a refusal, never implied approval. Flows remains the sole
 * policy engine and owns all independent decisions and their audit evidence. */
export async function submitFinancialChange(
  orgId: string,
  id: string,
  actorId: string,
): Promise<void> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const tx = db;
      const row = await loadFinancialChange(tx, orgId, id);
      if (row.submitted_by !== actorId)
        throw new Error("only the proposer can submit this accounting change");
      if (row.status !== "draft") return; // A retry reuses its existing routing/decision.
      const result = await runRecordFlows(
        { kind: "on_submit", source: "ui" },
        FINANCIAL_CHANGE_SUBJECT_KIND,
        id,
        { orgId, userId: actorId },
      );
      if (result.failed || result.gatesCreated === 0) {
        throw new Error(
          result.failed
            ? "accounting change approval routing failed; review the configured flow and its recipients, then resubmit"
            : "configure an enabled Accounting lifecycle change approval flow in Flows, then submit this proposal",
        );
      }
      const updated = await tx.execute(sql`
      update financial_changes set status='pending',updated_by=${actorId},updated_at=now()
       where org_id=${orgId} and id=${id} and status='draft' returning id
    `);
      if (updated.rows.length !== 1)
        throw new Error("accounting change could not be submitted");
    }),
  );
}
