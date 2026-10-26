import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

/**
 * Intercompany netting runs as a flow subject.
 *
 * Approval of a netting run is owned by Flows: submitting a proposed run
 * fires `on_submit`, and an enabled flow that raises a gate parks the run in
 * `pending_approval` until the flow decides. With no gating flow the
 * organization has no netting approval and the run is approved at once.
 *
 * The adapter owns the approval lifecycle only. The run's proposal (its
 * fingerprinted computation) is what is approved, so nothing on a run is
 * flow-writable and status releases inside the intercompany engine through the
 * registered handler. The proposer and submitter cannot decide the gate
 * without an explicit self-approval policy frozen on it.
 */

export const INTERCOMPANY_NETTING_RUN_SUBJECT_KIND = "intercompany_netting_run";

const NETTING_RUN_STATUSES = [
  { value: "proposed", label: "Proposed" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "posted", label: "Posted" },
  { value: "cancelled", label: "Cancelled" },
  { value: "reversed", label: "Reversed" },
] as const;

export const intercompanyNettingRunSubjectProfile: FlowSubjectProfile = {
  subjectKind: INTERCOMPANY_NETTING_RUN_SUBJECT_KIND,
  pinsSubmissionPolicy: true,
  label: "Intercompany netting run",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...NETTING_RUN_STATUSES],
  fields: [
    { key: "runNumber", label: "Run number", type: "text" },
    { key: "asOfDate", label: "Netting date", type: "date" },
    { key: "subsidiaryCount", label: "Subsidiaries", type: "number" },
    { key: "pairCount", label: "Intercompany pairs", type: "number" },
    { key: "settleCash", label: "Settles in cash", type: "bool" },
    { key: "lineCount", label: "Settlement lines", type: "number" },
    { key: "status", label: "Status", type: "enum" },
    { key: "proposedBy", label: "Proposed by", type: "user" },
    { key: "submittedBy", label: "Submitted by", type: "user" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
};

type NettingRunRow = {
  id: string;
  run_number: string;
  as_of_date: string;
  subsidiary_ids: string[];
  settle_cash: boolean;
  status: string;
  proposed_by: string;
  submitted_by: string | null;
  pair_count: number;
  line_count: number;
};

async function loadRun(subjectId: string): Promise<NettingRunRow | null> {
  const result = await db.execute<NettingRunRow>(
    sql`
    select r.id, r.run_number, r.as_of_date::text as as_of_date, r.subsidiary_ids, r.settle_cash, r.status,
           r.proposed_by, r.submitted_by,
           coalesce(jsonb_array_length(r.computation->'pairs'), 0)::int as pair_count,
           (select count(*)::int from intercompany_netting_lines l where l.org_id = r.org_id and l.run_id = r.id) as line_count
      from intercompany_netting_runs r
     where r.id = ${subjectId}`,
    "objects",
  );
  return result[0] ?? null;
}

export const intercompanyNettingRunsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: INTERCOMPANY_NETTING_RUN_SUBJECT_KIND,
  permissions: {
    read: "intercompany.read",
    edit: "intercompany.manage",
    approve: "intercompany.approve",
  },
  scope: {
    via: "custom",
    // A run spans several entities; it is visible only to a caller who sees
    // every one of them, and it reports its first entity as its owner.
    async subsidiaryOf(orgId, ids, allowed, lock) {
      const rows = await db.execute<{ id: string; subsidiary_ids: string[] }>(
        sql`
        select id, subsidiary_ids from intercompany_netting_runs
         where org_id = ${orgId}
           and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
         ${lock ? sql`for share` : sql``}`,
        "objects",
      );
      return new Map(
        rows.map((row) => [
          row.id,
          allowed === null || row.subsidiary_ids.every((id) => allowed.has(id))
            ? ([...row.subsidiary_ids].sort()[0] ?? null)
            : null,
        ]),
      );
    },
    worklistPredicate(allowedIdsJson) {
      return sql`exists (
        select 1 from intercompany_netting_runs wr
         where wr.org_id = g.org_id and wr.id = g.subject_id
           and wr.subsidiary_ids <@ array(select jsonb_array_elements_text(${allowedIdsJson}::jsonb)::uuid)
      )`;
    },
  },
  profile: intercompanyNettingRunSubjectProfile,
  releaseViaHandler: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const run = await loadRun(subjectId);
    if (!run) return null;
    return {
      values: {
        id: run.id,
        runNumber: run.run_number,
        asOfDate: run.as_of_date,
        subsidiaryCount: run.subsidiary_ids.length,
        pairCount: run.pair_count,
        settleCash: run.settle_cash,
        lineCount: run.line_count,
        status: run.status,
        proposedBy: run.proposed_by,
        submittedBy: run.submitted_by,
      },
      submitterUserId: run.submitted_by,
      makerUserId: run.proposed_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    return `Intercompany netting run ${String(values.runNumber ?? subjectId)}`;
  },

  deepLink(subjectId: string): string {
    return `/intercompany/netting?run=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRun(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error("netting run status is released by the approval engine, not a flow action");
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
    run?: { id: string; dispatchValues: Record<string, unknown> | null },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: INTERCOMPANY_NETTING_RUN_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
      approvalRunId: run?.id,
    });
  },

  /** A retried flow run that now gates parks a proposed run, as the first submission would. */
  async markAwaitingApproval(subjectId: string, ctx: FlowExecCtx): Promise<void> {
    const parked = await db.execute<{ id: string }>(
      sql`
      update intercompany_netting_runs
         set status = 'pending_approval', submitted_at = coalesce(submitted_at, now()),
             submitted_by = coalesce(submitted_by, ${ctx.userId ?? null}::uuid), updated_at = now()
       where id = ${subjectId} and org_id = ${ctx.orgId} and status = 'proposed'
      returning id`,
      "objects",
    );
    if (parked[0]) return;
    const current = (await loadRun(subjectId))?.status ?? null;
    if (current !== "pending_approval") {
      throw new Error(
        `netting run is ${current ?? "missing"}; only a proposed run can await approval`,
      );
    }
  },

  async setField(): Promise<void> {
    throw new Error(
      "netting run fields are not writable by flows; cancel the run and propose a new one",
    );
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${INTERCOMPANY_NETTING_RUN_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = await db.execute<{ id: string }>(
      sql`
      select id::text as id from intercompany_netting_runs
       where org_id = ${orgId} and status = 'pending_approval'
       order by submitted_at desc nulls last
       limit ${limit}`,
      "objects",
    );
    return result.map((row) => row.id);
  },
});
