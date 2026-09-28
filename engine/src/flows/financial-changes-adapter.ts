import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db, withOrg, withTransactionSavepoint } from "../platform/db.ts";
import {
  financialChangeInboxLabel,
  loadFinancialChange,
  loadFinancialChangeSubjectLabel,
} from "../platform/financial-changes.ts";
import {
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { runRecordFlows } from "./run.ts";
import type { FlowSubjectAdapter } from "./types.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

export const FINANCIAL_CHANGE_SUBJECT_KIND = "financial_change";
export const financialChangeSubjectProfile: FlowSubjectProfile = {
  subjectKind: FINANCIAL_CHANGE_SUBJECT_KIND,
  label: "Accounting event",
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
      options: ["lease", "revenue", "asset", "consolidation", "manufacturing"].map((value) => ({
        value,
        label: value,
      })),
    },
    { key: "operation", label: "Event", type: "text" },
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
};
export const financialChangesFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: FINANCIAL_CHANGE_SUBJECT_KIND,
  // Authorization is polymorphic per change type (assets.manage / ar.post /
  // close.run); no single domain grant covers the kind, so generic
  // endpoints fail closed on it.
  permissions: null,
  scope: {
    via: "custom",
    // A change is visible only when every legal entity it requires is.
    async subsidiaryOf(orgId, ids, allowed, lock) {
      const changes = (await db.execute<{ id: string; subsidiaryId: string | null; required: Array<string | null> }>(sql`
        select id, subsidiary_id as "subsidiaryId",
               coalesce(payload->'requiredSubsidiaryIds', jsonb_build_array(subsidiary_id)) as required
          from financial_changes
         where org_id = ${orgId}
           and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
         ${lock ? sql`for share` : sql``}
      `)).rows;
      return new Map(changes.map((change) => [
        change.id,
        allowed === null || change.required.every((id) => id !== null && allowed.has(id))
          ? change.subsidiaryId
          : null,
      ]));
    },
    worklistPredicate(ids) {
      return sql`exists (
        select 1 from financial_changes fc where fc.org_id=g.org_id and fc.id=g.subject_id
        and fc.subsidiary_id in (select jsonb_array_elements_text(${ids}::jsonb)::uuid)
        and not exists(select 1 from jsonb_array_elements_text(coalesce(fc.payload->'requiredSubsidiaryIds','[]'::jsonb)) required(id) where required.id not in(select jsonb_array_elements_text(${ids}::jsonb)))
      )`;
    },
  },
  profile: financialChangeSubjectProfile,
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
    const subjectLabel = await loadFinancialChangeSubjectLabel(
      db,
      row.org_id,
      change.domain,
      change.subject_id,
    );
    return {
      values: {
        id,
        domain: change.domain,
        operation: change.operation,
        effectiveOn: change.effective_on,
        subsidiaryId: change.subsidiary_id,
        reason: change.reason,
        status: change.status,
        subjectLabel,
      },
      submitterUserId: change.submitted_by,
    };
  },
  label(id, values) {
    return financialChangeInboxLabel({ ...values, id });
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
      "accounting event decisions are controlled by the approval gate",
    );
  },
  async setField() {
    throw new Error(
      "accounting event proposals are immutable; submit a new proposal",
    );
  },
  async releaseApproval(id, outcome, ctx) {
    const row = await loadFinancialChange(db, ctx.orgId, id);
    if (row.status !== "pending") return;
    if (!ctx.userId || row.submitted_by === ctx.userId)
      throw new Error("an independent signed-in approver is required");
    if (row.domain === "manufacturing") {
      // Defense in depth: the restatement service rechecks actor, feature,
      // and legal-entity scope in the same transaction that applies the
      // change. The approval gate independently refuses here first.
      if (
        !(await actorHasPermission(
          db,
          ctx.orgId,
          ctx.userId,
          "manufacturing.manage",
        ))
      )
        throw new Error(
          "this change requires manufacturing.manage; ask a manufacturing manager to approve it",
        );
      if (!(await orgFeatureEnabled(ctx.orgId, "manufacturing", db)))
        throw new Error(
          "turn on Manufacturing in Company Settings → Features before approving this change",
        );
      const bound = row.payload.requiredSubsidiaryIds;
      if (
        !Array.isArray(bound) ||
        bound.length === 0 ||
        bound.some((entry) => typeof entry !== "string")
      )
        throw new Error(
          "this manufacturing restatement carries no legal-entity binding; submit a new proposal",
        );
    }
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
      throw new Error("accounting event decision could not be recorded");
  },
});

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
        throw new Error("only the proposer can submit this accounting event");
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
            ? "accounting event approval routing failed; review the configured flow and its recipients, then resubmit"
            : "configure an enabled Accounting event approval flow in Flows, then submit this proposal",
        );
      }
      const updated = await tx.execute(sql`
      update financial_changes set status='pending',updated_by=${actorId},updated_at=now()
       where org_id=${orgId} and id=${id} and status='draft' returning id
    `);
      if (updated.rows.length !== 1)
        throw new Error("accounting event could not be submitted");
    }),
  );
}
