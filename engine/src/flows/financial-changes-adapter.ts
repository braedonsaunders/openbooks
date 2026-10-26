import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { orderResourcesVisible } from "../organization/production-resource-scope.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { orgFeatureEnabled, lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db, withOrg, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import {
  ACCOUNT_MERGE_OPERATION,
  FINANCIAL_CHANGE_AUTHORITY,
  financialChangeFeature,
  ADJUDICATED_HOLIDAY_HOURS_OPERATION,
  HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION,
  MANUFACTURING_SCRAP_RESTATEMENT_OPERATION,
  MANUFACTURING_STANDARD_ROLLUP_OPERATION,
  MANUFACTURING_LOSS_DISPOSITION_OPERATION,
  MANUFACTURING_ROUTING_APPROVAL_OPERATION,
  MANUFACTURING_BOM_APPROVAL_OPERATION,
  FinancialChangeFeatureError,
  financialChangeInboxLabel,
  loadFinancialChange,
  loadFinancialChangeSubjectLabel,
  type FinancialChange,
} from "../platform/financial-changes.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { isUuid } from "../platform/uuid.ts";
import { requireNativeFileReadAuthority } from "../records/file-read-authority.ts";
import { lockCabinetAuthorization } from "../records/file-cabinet-access.ts";
import {
  BomPolicyError,
  applyApprovedBomRevision,
  assertBomRevisionAuthority,
  readBomRecipe,
} from "../inventory/bom-policy.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import { routeSubjectSubmission } from "./submission-policy.ts";
import type { FlowSubjectAdapter } from "./types.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

async function assertAccountingSubjectFeatures(
  orgId: string,
  subjectId: string,
  domain: string,
  operation: string,
) {
  if (domain === "payroll" && !(await lockAndCheckOrgFeature(db, orgId, "payroll")))
    throw new FinancialChangeFeatureError(
      "Turn on Payroll in Company Settings → Features before submitting or approving unpaid holiday pay",
    );
  if (
    domain === "consolidation" &&
    operation === "net_investment_oci" &&
    (!(await lockAndCheckOrgFeature(db, orgId, "multiSubsidiary")) ||
      !(await lockAndCheckOrgFeature(db, orgId, "multiCurrency")))
  )
    throw new FinancialChangeFeatureError(
      "Turn on Multi-Subsidiary and Multi-Currency in Company Settings → Features before submitting or approving a net-investment FX assessment",
    );
  if (
    domain === "consolidation" &&
    operation === HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION &&
    !(await lockAndCheckOrgFeature(db, orgId, "multiCurrency"))
  )
    throw new FinancialChangeFeatureError(
      "Turn on Multi-Currency in Company Settings → Features before submitting or approving historical translation evidence",
    );
  if (domain === "sales" && !(await lockAndCheckOrgFeature(db, orgId, "dropShipping")))
    throw new FinancialChangeFeatureError(
      "Turn on Drop Shipping in Company Settings → Features before submitting or approving a control assessment",
    );
  if (
    domain === "revenue" &&
    operation === "expected_breakage_estimate" &&
    (!(await lockAndCheckOrgFeature(db, orgId, "usageBilling")) ||
      !(await lockAndCheckOrgFeature(db, orgId, "revenueRecognition")))
  )
    throw new FinancialChangeFeatureError(
      "Turn on Usage Billing and Revenue Recognition in Company Settings → Features before submitting or approving a breakage estimate",
    );
  if (domain === "manufacturing" && !(await lockAndCheckOrgFeature(db, orgId, "manufacturing")))
    throw new FinancialChangeFeatureError(
      "Turn on Manufacturing in Company Settings → Features before submitting or approving a manufacturing event.",
    );
  if (domain === "ledger" && !(await lockAndCheckOrgFeature(db, orgId, "accountMerges")))
    throw new FinancialChangeFeatureError(
      "Turn on Account merges in Company Settings → Features before submitting or approving an account merge.",
    );
  if (domain !== "provision") return;
  const project = (
    await db.execute<{ project_id: string | null }>(
      sql`select project_id from provision_obligations where org_id=${orgId} and id=${subjectId}`,
      "objects",
    )
  )[0]?.project_id;
  if (project && !(await lockAndCheckOrgFeature(db, orgId, "projects")))
    throw new FinancialChangeFeatureError(
      "Turn on Projects in Company Settings → Features before submitting or approving this construction forecast",
    );
}

async function assertHistoricalTranslationDecisionSubject(
  orgId: string,
  actorId: string,
  change: FinancialChange,
): Promise<void> {
  const required = change.payload.requiredSubsidiaryIds;
  if (!Array.isArray(required) || required.length !== 1 || required[0] !== change.subsidiary_id)
    throw new Error(
      "Historical translation evidence must bind exactly its source legal entity; reject the malformed proposal and submit a new one.",
    );
  const evidence = change.payload.evidence;
  const instruction =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>).instruction
      : null;
  const layers =
    instruction && typeof instruction === "object" && !Array.isArray(instruction)
      ? (instruction as Record<string, unknown>).layers
      : null;
  if (!Array.isArray(layers) || layers.length === 0 || layers.length > 200)
    throw new Error(
      "Historical translation evidence has no complete source layers; reject the malformed proposal and submit a new one.",
    );
  for (const layer of layers) {
    const source =
      layer && typeof layer === "object" && !Array.isArray(layer)
        ? (layer as Record<string, unknown>).source
        : null;
    const fileId =
      source && typeof source === "object" && !Array.isArray(source)
        ? (source as Record<string, unknown>).fileId
        : null;
    if (!isUuid(fileId))
      throw new Error(
        "Historical translation evidence must identify each retained source file; reject the malformed proposal and submit a new one.",
      );
    await requireNativeFileReadAuthority({ orgId, actorId, fileId }, db);
  }
  await lockActorCommandAuthority(db, orgId, actorId, change.subsidiary_id, "close.run");
  const source = await db.execute(
    sql`
    select line.id
      from journal_lines line
      join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
      join accounts account on account.org_id=line.org_id and account.id=line.account_id
     where line.org_id=${orgId} and line.id=${change.subject_id}
       and line.subsidiary_id=${change.subsidiary_id}
       and entry.status in ('posted','reversed') and account.type='equity'
     for share of line,entry,account
  `,
    "objects",
  );
  if (source.length !== 1)
    throw new Error(
      "The historical translation source is not a retained equity posting in this legal entity; reject the proposal and review its source journal.",
    );
}

export const FINANCIAL_CHANGE_SUBJECT_KIND = "financial_change";

/** A submit refused by the approval-flow policy itself: named with a 4xx
 * status so route boundaries answer the operator's message, never a 500. */
export class FinancialChangeSubmitError extends Error {
  readonly status = 422;
  readonly code: string;
  readonly remedy?: string;
  constructor(message: string, code: string, remedy?: string) {
    super(message);
    this.name = "FinancialChangeSubmitError";
    this.code = code;
    if (remedy !== undefined) this.remedy = remedy;
  }
}
export const financialChangeSubjectProfile: FlowSubjectProfile = {
  subjectKind: FINANCIAL_CHANGE_SUBJECT_KIND,
  label: "Accounting event",
  pinsSubmissionPolicy: true,
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: ["draft", "pending", "approved", "rejected", "applied"].map((value) => ({
    value,
    label: value,
  })),
  fields: [
    {
      key: "domain",
      label: "Accounting domain",
      type: "enum",
      options: [
        "lease",
        "revenue",
        "asset",
        "consolidation",
        "manufacturing",
        "provision",
        "sales",
        "payroll",
        "ledger",
      ].map((value) => ({
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
  async decisionPermission(id) {
    const row = (
      await db.execute<{ domain: keyof typeof FINANCIAL_CHANGE_AUTHORITY }>(
        sql`select domain from financial_changes where id=${id}`,
        "objects",
      )
    )[0];
    return row ? (FINANCIAL_CHANGE_AUTHORITY[row.domain]?.permission ?? null) : null;
  },
  scope: {
    via: "custom",
    // A change is visible only when every legal entity it requires is.
    async subsidiaryOf(orgId, ids, allowed, lock) {
      const changes = await db.execute<{
        id: string;
        subsidiaryId: string | null;
        required: Array<string | null>;
      }>(
        sql`
        select id, subsidiary_id as "subsidiaryId",
               coalesce(payload->'requiredSubsidiaryIds', jsonb_build_array(subsidiary_id)) as required
          from financial_changes
         where org_id = ${orgId}
           and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
         and (domain<>'manufacturing' or operation<>'work_order_loss_disposition' or exists (
           select 1 from mfg_work_orders work where work.org_id=financial_changes.org_id and work.id=financial_changes.subject_id
             ${subsidiaryVisibleFilter(sql`work.subsidiary_id`, allowed)} ${orderResourcesVisible(allowed, "work")}
         ))
         ${lock ? sql`for share` : sql``}
      `,
        "objects",
      );
      return new Map(
        changes.map((change) => [
          change.id,
          allowed === null || change.required.every((id) => id !== null && allowed.has(id))
            ? change.subsidiaryId
            : null,
        ]),
      );
    },
    worklistPredicate(ids) {
      return sql`exists (
        select 1 from financial_changes fc where fc.org_id=g.org_id and fc.id=g.subject_id
        and fc.subsidiary_id in (select jsonb_array_elements_text(${ids}::jsonb)::uuid)
        and (fc.domain<>'manufacturing' or fc.operation<>'work_order_loss_disposition' or exists (
          select 1 from mfg_work_orders work where work.org_id=fc.org_id and work.id=fc.subject_id
            ${orderResourcesVisible(new Set(JSON.parse(ids) as string[]), "work")}
        ))
        and not exists(select 1 from jsonb_array_elements_text(coalesce(fc.payload->'requiredSubsidiaryIds','[]'::jsonb)) required(id) where required.id not in(select jsonb_array_elements_text(${ids}::jsonb)))
      )`;
    },
  },
  profile: financialChangeSubjectProfile,
  async lockDecisionResources(orgId, id) {
    const row = (
      await db.execute<{ domain: string; operation: string }>(
        sql`
      select domain,operation from financial_changes where org_id=${orgId} and id=${id}`,
        "objects",
      )
    )[0];
    if (
      row?.domain === "consolidation" &&
      row.operation === HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION
    )
      await lockCabinetAuthorization(db, orgId);
  },
  async loadContext(id) {
    // RLS supplies the org; this adapter never widens the active tenant scope.
    const row = (
      await db.execute<{ org_id: string }>(
        sql`select org_id from financial_changes where id=${id}`,
        "objects",
      )
    )[0];
    if (!row) return null;
    const change = await loadFinancialChange(db, row.org_id, id, { lock: false });
    const subjectLabel = await loadFinancialChangeSubjectLabel(
      db,
      row.org_id,
      change.domain,
      change.subject_id,
      change.operation,
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
        "objects",
      )
    )[0];
    return row?.status ?? null;
  },
  async changeStatus() {
    throw new Error("accounting event decisions are controlled by the approval gate");
  },
  async setField() {
    throw new Error("accounting event proposals are immutable; submit a new proposal");
  },
  async releaseApproval(id, outcome, ctx) {
    const row = await loadFinancialChange(db, ctx.orgId, id);
    if (row.status !== "pending") return;
    if (!ctx.userId) throw new Error("A signed-in decision maker is required.");
    if (row.submitted_by === ctx.userId && !row.self_approval_authorized)
      throw new Error(
        "The retained approval policy does not permit deciding your own submission. Review the gate's self-approval setting in Flows.",
      );
    if (outcome === "approved")
      await assertAccountingSubjectFeatures(ctx.orgId, row.subject_id, row.domain, row.operation);
    if (
      outcome === "approved" &&
      row.domain === "consolidation" &&
      row.operation === HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION
    )
      await assertHistoricalTranslationDecisionSubject(ctx.orgId, ctx.userId, row);
    if (row.domain === "ledger" && outcome === "approved") {
      if (row.operation !== ACCOUNT_MERGE_OPERATION)
        throw new Error(
          "This ledger event is unsupported; reject it and submit a supported proposal.",
        );
      if (!(await actorHasPermission(db, ctx.orgId, ctx.userId, "gl.manage")))
        throw new Error(
          "An account merge requires authority to manage the chart of accounts (gl.manage); ask a controller to approve it.",
        );
    }
    if (row.domain === "payroll" && outcome === "approved") {
      if (
        row.operation !== ADJUDICATED_HOLIDAY_HOURS_OPERATION ||
        !(await actorHasPermission(db, ctx.orgId, ctx.userId, "payroll.run"))
      ) {
        throw new Error("An unpaid holiday entitlement requires payroll.run authority.");
      }
      const required = row.payload.requiredSubsidiaryIds;
      if (!Array.isArray(required) || required.length !== 1 || required[0] !== row.subsidiary_id) {
        throw new Error(
          "The holiday entitlement must bind exactly its legal employer; reject the malformed proposal and submit a corrected proposal.",
        );
      }
    }
    // Manufacturing authority applies only when recording an approval. A
    // rejection must stay reachable for malformed or obsolete proposals, or
    // the live-proposal guard would strand the correction it exists to allow.
    if (row.domain === "manufacturing" && outcome === "approved") {
      // Defense in depth: the restatement service rechecks actor, feature,
      // and legal-entity scope in the same transaction that applies the
      // change. The approval gate independently refuses here first.
      if (
        ![
          MANUFACTURING_SCRAP_RESTATEMENT_OPERATION,
          MANUFACTURING_LOSS_DISPOSITION_OPERATION,
          MANUFACTURING_STANDARD_ROLLUP_OPERATION,
          MANUFACTURING_ROUTING_APPROVAL_OPERATION,
          MANUFACTURING_BOM_APPROVAL_OPERATION,
        ].includes(row.operation)
      )
        throw new Error(
          "This manufacturing event is unsupported; reject it and submit a supported proposal.",
        );
      if (!(await actorHasPermission(db, ctx.orgId, ctx.userId, "manufacturing.manage")))
        throw new Error(
          "this change requires manufacturing.manage; ask a manufacturing manager to approve it",
        );
      if (!(await orgFeatureEnabled(ctx.orgId, "manufacturing", db)))
        throw new Error(
          "turn on Manufacturing in Company Settings → Features before approving this change",
        );
      if (row.operation === MANUFACTURING_LOSS_DISPOSITION_OPERATION) {
        const scope = await lockActorCommandAuthority(
          db,
          ctx.orgId,
          ctx.userId,
          row.subsidiary_id,
          "manufacturing.manage",
        );
        if (
          !(
            await db.execute(
              sql`select work.id from mfg_work_orders work where work.org_id=${ctx.orgId} and work.id=${row.subject_id} ${subsidiaryVisibleFilter(sql`work.subsidiary_id`, scope)} ${orderResourcesVisible(scope, "work")} for share of work`,
              "objects",
            )
          ).length
        )
          throw new Error("Production work was not found in the approver’s current scope.");
      }
      if (row.operation === MANUFACTURING_STANDARD_ROLLUP_OPERATION) {
        const scope = await lockActorCommandAuthority(
          db,
          ctx.orgId,
          ctx.userId,
          row.subsidiary_id,
          "manufacturing.manage",
        );
        const inventoryScope = await lockActorCommandAuthority(
          db,
          ctx.orgId,
          ctx.userId,
          row.subsidiary_id,
          "items.manage",
        );
        if (
          inventoryScope !== null ||
          scope !== null ||
          !(await actorHasPermission(db, ctx.orgId, ctx.userId, "items.manage"))
        )
          throw new Error(
            "A shared item standard requires unrestricted manufacturing and inventory management authority.",
          );
      }
      if (
        row.operation === MANUFACTURING_ROUTING_APPROVAL_OPERATION &&
        (await lockActorCommandAuthority(
          db,
          ctx.orgId,
          ctx.userId,
          row.subsidiary_id,
          "manufacturing.manage",
        )) !== null
      )
        throw new Error("Shared routing revisions require unrestricted manufacturing authority.");
      if (row.operation === MANUFACTURING_BOM_APPROVAL_OPERATION) {
        if (
          (await lockActorCommandAuthority(
            db,
            ctx.orgId,
            ctx.userId,
            row.subsidiary_id,
            "manufacturing.manage",
          )) !== null ||
          (await lockActorCommandAuthority(
            db,
            ctx.orgId,
            ctx.userId,
            row.subsidiary_id,
            "admin.setup.manage",
          )) !== null
        )
          throw new Error(
            "Shared BOM revisions require unrestricted manufacturing and setup authority.",
          );
      }
      const bound: unknown = row.payload.requiredSubsidiaryIds;
      if (
        !Array.isArray(bound) ||
        bound.length !== 1 ||
        typeof bound[0] !== "string" ||
        bound[0].trim().length === 0 ||
        bound[0] !== row.subsidiary_id
      )
        throw new Error(
          "this manufacturing restatement must bind exactly the booking subsidiary; reject the malformed proposal, then submit a corrected proposal",
        );
    }
    const allowed = await actorAllowedSubsidiaryIds(db, ctx.orgId, ctx.userId);
    const required = Array.isArray(row.payload.requiredSubsidiaryIds)
      ? row.payload.requiredSubsidiaryIds
      : [row.subsidiary_id];
    if (allowed && required.some((id) => typeof id !== "string" || !allowed.has(id)))
      throw new Error("this approval includes a legal entity outside your authorization");
    const updated = await db.execute(
      sql`
      update financial_changes set status=${outcome},approved_by=${ctx.userId},approved_at=now(),
        updated_by=${ctx.userId},updated_at=now()
       where org_id=${ctx.orgId} and id=${id} and status='pending' returning id
    `,
      "objects",
    );
    if (updated.length !== 1) throw new Error("accounting event decision could not be recorded");
  },
});

/** Route a measured proposal through every applicable tenant Flow. With no
 * approval gates, submission releases it using retained routing evidence. */
export async function submitFinancialChange(
  orgId: string,
  id: string,
  actorId: string,
): Promise<void> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const tx = db;
      await lockApprovalSubject(orgId, "financial_change", id);
      await financialChangesFlowAdapter.lockDecisionResources?.(orgId, id);
      const row = await loadFinancialChange(tx, orgId, id);
      if (row.submitted_by !== actorId)
        throw new Error("only the proposer can submit this accounting event");
      const authority = FINANCIAL_CHANGE_AUTHORITY[row.domain];
      await lockActorCommandAuthority(tx, orgId, actorId, row.subsidiary_id, authority.permission);
      const feature = financialChangeFeature(row.domain, row.operation);
      if (feature && !(await lockAndCheckOrgFeature(tx, orgId, feature)))
        throw new ScopeNotFoundError();

      if (
        row.domain === "payroll" &&
        !(await actorHasPermission(tx, orgId, actorId, "payroll.run"))
      )
        throw new Error(
          "Payroll run permission is required to submit an unpaid holiday entitlement.",
        );
      await assertAccountingSubjectFeatures(orgId, row.subject_id, row.domain, row.operation);
      if (
        row.domain === "consolidation" &&
        row.operation === HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION
      )
        await assertHistoricalTranslationDecisionSubject(orgId, actorId, row);
      if (row.domain === "manufacturing") {
        const manufacturingScope = await lockActorCommandAuthority(
          tx,
          orgId,
          actorId,
          row.subsidiary_id,
          "manufacturing.manage",
        );
        if (
          row.operation === MANUFACTURING_LOSS_DISPOSITION_OPERATION &&
          !(
            await tx.execute(
              sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${row.subject_id} ${subsidiaryVisibleFilter(sql`work.subsidiary_id`, manufacturingScope)} ${orderResourcesVisible(manufacturingScope, "work")} for share of work`,
              "objects",
            )
          ).length
        )
          throw new Error("Production work was not found in the proposer’s current scope.");
        if (
          [
            MANUFACTURING_STANDARD_ROLLUP_OPERATION,
            MANUFACTURING_ROUTING_APPROVAL_OPERATION,
            MANUFACTURING_BOM_APPROVAL_OPERATION,
          ].includes(row.operation) &&
          manufacturingScope !== null
        )
          throw new Error("Shared manufacturing policies require unrestricted authority.");
        if (
          row.operation === MANUFACTURING_STANDARD_ROLLUP_OPERATION &&
          (await lockActorCommandAuthority(
            tx,
            orgId,
            actorId,
            row.subsidiary_id,
            "items.manage",
          )) !== null
        )
          throw new Error(
            "A shared item standard requires unrestricted inventory management authority.",
          );
      }
      if (
        row.domain === "manufacturing" &&
        row.operation === MANUFACTURING_BOM_APPROVAL_OPERATION &&
        (await lockActorCommandAuthority(
          tx,
          orgId,
          actorId,
          row.subsidiary_id,
          "admin.setup.manage",
        )) !== null
      )
        throw new Error("Shared BOM revisions require unrestricted setup authority.");
      if (row.status !== "draft") return; // A retry reuses its existing routing/decision.
      const { policy } = await routeSubjectSubmission({
        orgId,
        subjectKind: FINANCIAL_CHANGE_SUBJECT_KIND,
        subjectId: id,
        actorId,
      });
      const updated = await tx.execute(
        sql`
      update financial_changes set status='pending',submission_policy=${JSON.stringify(policy)}::jsonb,updated_by=${actorId},updated_at=now()
       where org_id=${orgId} and id=${id} and status='draft' returning id
    `,
        "objects",
      );
      if (updated.length !== 1) throw new Error("accounting event could not be submitted");
      if (policy.kind === "ungated") {
        await financialChangesFlowAdapter.releaseApproval!(id, "approved", {
          orgId,
          userId: actorId,
        });
        await tx.execute(sql`
          insert into audit_log(org_id,actor_id,action,table_name,row_id,changes)
          values(${orgId},${actorId},'submit','financial_changes',${id},
            ${JSON.stringify({ approval: { mode: "ungated", policy } })}::jsonb)
        `);
      }
    }),
  );
}

/** Submit the immutable recipe proposal; successful ungated routing applies
 * it through the same writer used after human Flow decisions. */
export async function submitBomRevision(
  orgId: string,
  actorId: string,
  changeId: string,
): Promise<void> {
  return withOrgTransaction(orgId, async () => {
    const tx = db;
    await tx.execute(sql`lock table bom_components in row exclusive mode`);
    if (!(await lockAndCheckOrgFeature(tx, orgId, "manufacturing"))) throw new ScopeNotFoundError();
    await assertBomRevisionAuthority(tx, orgId, actorId, true);
    const change = await loadFinancialChange(tx, orgId, changeId);
    if (
      change.domain !== "manufacturing" ||
      change.operation !== MANUFACTURING_BOM_APPROVAL_OPERATION
    )
      throw new ScopeNotFoundError();
    if (change.submitted_by !== actorId)
      throw new BomPolicyError("Only the proposer can submit this recipe revision.");
    if (change.status !== "draft") return;
    await submitFinancialChange(orgId, changeId, actorId);
    const routed = await loadFinancialChange(tx, orgId, changeId);
    if (routed.status === "pending") return;
    const direct = await loadFinancialChange(tx, orgId, changeId);
    if (
      direct.status !== "approved" ||
      direct.approved_by !== direct.submitted_by ||
      direct.approved_by !== actorId
    )
      throw new BomPolicyError(
        "This recipe revision has no permitted approval decision; submit it for approval.",
        409,
      );
    const before = await readBomRecipe(tx, orgId, change.subject_id);
    if (canonicalJson(change.before_state) !== canonicalJson(before))
      throw new BomPolicyError(
        "This recipe changed after you opened it; reopen it and use its current revision.",
        409,
        "bom_revision_changed",
      );
    await applyApprovedBomRevision(tx, orgId, actorId, direct, before);
  });
}
