import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../db.ts";
import { BUILT_IN_ROLE_NAMES, EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";

export const ALLOCATION_RUN_SUBJECT_KIND = "allocation_run";

/**
 * Allocation runs as a flow subject (fleet A14).
 *
 * The subject is an `allocation_runs` row for a period-mode rule whose
 * version names an `approval_flow_id`: posting waits in `pending_approval`
 * until the flow approves. The adapter owns the approval lifecycle only —
 * posting itself stays in `engine/src/allocations/period-run.ts`
 * (journal + lineage in one transaction), reached through the
 * engine-enforced `releaseApproval`, never through an authored
 * `change_status` or `set_field` (both throw: a bare status write would
 * fake an approval without its journal).
 *
 * Status path: previewed → pending_approval → posted, or
 * pending_approval → failed with `error = 'rejected: <reason>'` on
 * rejection. Nothing on a run is flow-writable: the computation is the
 * thing being approved.
 */

const ALLOCATION_RUN_STATUSES = [
  { value: "previewed", label: "Previewed" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "posted", label: "Posted" },
  { value: "reversed", label: "Reversed" },
  { value: "failed", label: "Failed" },
  { value: "superseded", label: "Superseded" },
] as const;

export const allocationRunSubjectProfile: FlowSubjectProfile = {
  subjectKind: ALLOCATION_RUN_SUBJECT_KIND,
  label: "Allocation run",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...ALLOCATION_RUN_STATUSES],
  fields: [
    { key: "ruleKey", label: "Rule key", type: "text" },
    { key: "ruleName", label: "Rule name", type: "text" },
    { key: "periodName", label: "Accounting period", type: "text" },
    { key: "fiscalYear", label: "Fiscal year", type: "number" },
    { key: "bookCode", label: "Accounting book", type: "text" },
    { key: "status", label: "Status", type: "enum", options: [...ALLOCATION_RUN_STATUSES] },
    { key: "sourceTotal", label: "Source total", type: "number" },
    { key: "allocatedTotal", label: "Allocated total", type: "number" },
    { key: "targetCount", label: "Targets", type: "number" },
    {
      key: "triggerKind", label: "Trigger", type: "enum", options: [
        { value: "manual", label: "Manual" },
        { value: "scheduled", label: "Scheduled" },
        { value: "close_automation", label: "Close automation" },
        { value: "rerun", label: "Re-run" },
      ],
    },
    { key: "requestedBy", label: "Requested by", type: "user" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

type AllocationRunRow = {
  org_id: string;
  status: string;
  source_total: string;
  allocated_total: string;
  target_count: number;
  trigger_kind: string;
  requested_by: string | null;
  rule_id: string;
  rule_key: string | null;
  rule_name: string | null;
  version_id: string;
  definition_hash: string | null;
  period_id: string;
  period_name: string | null;
  fiscal_year: number | null;
  book_id: string;
  book_code: string | null;
};

/** The run with its rule + version + period + book for flow conditions. */
async function loadRun(subjectId: string): Promise<AllocationRunRow | null> {
  const result = (await db.execute<AllocationRunRow>(sql`
    select r.org_id, r.status,
           r.source_total::text, r.allocated_total::text,
           (select count(*)::int
              from jsonb_array_elements(coalesce(r.computation->'targets', '[]'::jsonb))) as target_count,
           r.trigger_kind, r.requested_by::text,
           r.rule_id, rule.key as rule_key, rule.name as rule_name,
           r.version_id, r.definition_hash,
           r.period_id, p.name as period_name, p.fiscal_year,
           r.book_id, b.code as book_code
      from allocation_runs r
      left join allocation_rules rule
        on rule.id = r.rule_id and rule.org_id = r.org_id
      left join accounting_periods p
        on p.id = r.period_id and p.org_id = r.org_id
      left join accounting_books b
        on b.id = r.book_id and b.org_id = r.org_id
     where r.id = ${subjectId}
  `));
  return result.rows[0] ?? null;
}

export const allocationRunsFlowAdapter: FlowSubjectAdapter = {
  subjectKind: ALLOCATION_RUN_SUBJECT_KIND,
  profile: allocationRunSubjectProfile,
  // Nothing on a run is a flow-writable header field: the stored computation
  // is the thing being approved, and a flow must not rewrite it.
  writableFields: new Set<string>(),

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const run = await loadRun(subjectId);
    if (!run) return null;
    return {
      values: {
        id: subjectId,
        ruleId: run.rule_id,
        ruleKey: run.rule_key,
        ruleName: run.rule_name,
        versionId: run.version_id,
        definitionHash: run.definition_hash,
        periodId: run.period_id,
        periodName: run.period_name,
        fiscalYear: run.fiscal_year,
        bookId: run.book_id,
        bookCode: run.book_code,
        status: run.status,
        sourceTotal: run.source_total,
        allocatedTotal: run.allocated_total,
        targetCount: run.target_count,
        triggerKind: run.trigger_kind,
        requestedBy: run.requested_by,
      },
      submitterUserId: run.requested_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const rule = values.ruleName ?? values.ruleKey ?? "Allocation";
    const period = values.periodName ? ` — ${String(values.periodName)}` : "";
    return `${String(rule)}${period}` || subjectId;
  },

  deepLink(): string {
    return "/admin/setup/allocations?tab=runs";
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRun(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "allocation run status is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
  ): Promise<void> {
    // Deterministic, engine-owned release — independent of any authored
    // change_status node. Only acts while the run awaits approval, so it is
    // idempotent and never fights a status a later action set. Runs inside
    // decideGate's serialized org transaction; every statement below joins
    // that unit (inDbTransaction participates rather than nesting).
    const run = await loadRun(subjectId);
    if (!run || run.org_id !== ctx.orgId) {
      throw new Error(`allocation run ${subjectId} does not belong to this organization`);
    }
    if (run.status !== "pending_approval") return;
    // Break the static import cycle (period-run dispatches flows on open).
    const { postAllocationRun } = await import("../allocations/period-run.ts");
    if (outcome === "approved") {
      if (!ctx.userId) throw new Error("a signed-in approver is required");
      const comment = detail?.comment?.trim() || null;
      const reason = (comment ?? "Approved through approval flow").slice(0, 500);
      try {
        await postAllocationRun(subjectId, ctx.userId, reason, { viaApproval: true });
      } catch (error) {
        // Approval granted but posting impossible (e.g. the period closed
        // while the approval was pending): return the run to previewed with
        // the refusal recorded, so it can be re-posted — and re-approved —
        // instead of stranding in pending_approval with a failed flow.
        // Rethrown so the flow run marks failed (fail-closed evidence).
        const message = error instanceof Error ? error.message : String(error);
        await db.execute(sql`
          update allocation_runs
             set status = 'previewed', error = ${message},
                 flow_run_id = null, updated_at = now(), updated_by = ${ctx.userId}
           where id = ${subjectId} and org_id = ${ctx.orgId}`);
        await db.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${ctx.orgId}, 'allocation_runs', ${subjectId}, 'update',
                  ${JSON.stringify({ mode: "allocation_run_approval_refused", reason: message })}::jsonb,
                  ${ctx.userId})`);
        throw error;
      }
      return;
    }
    const comment = detail?.comment?.trim() || null;
    await db.execute(sql`
      update allocation_runs
         set status = 'failed', error = ${comment ? `rejected: ${comment}` : "rejected"},
             updated_at = now(), updated_by = ${ctx.userId ?? null}
       where id = ${subjectId} and org_id = ${ctx.orgId} and status = 'pending_approval'`);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${ctx.orgId}, 'allocation_runs', ${subjectId}, 'update',
              ${JSON.stringify({ mode: "allocation_run_rejected", reason: comment })}::jsonb,
              ${ctx.userId ?? null})`);
  },

  async setField(): Promise<void> {
    throw new Error("allocation run fields are not writable by flows; edit the rule version");
  },

  /** Recent runs awaiting a decision, for scheduled fan-out (reminders). */
  async findCandidateIds(limit: number): Promise<string[]> {
    // The explicit org_id predicate is the tenant boundary — NOT the RLS
    // GUCs withOrg pins on its own client: pooled sibling connections (and
    // any bypass-ambient resolver, e.g. the test harness's) can otherwise
    // see every tenant. Fails closed when no ambient tenant is active.
    // (Parity with the documents and timesheet adapters.)
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${ALLOCATION_RUN_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = (await db.execute<{ id: string }>(sql`
      select id::text as id from allocation_runs
       where org_id = ${orgId}
         and status = 'pending_approval'
       order by created_at desc
       limit ${limit}
    `));
    return result.rows.map((row) => row.id);
  },
};
