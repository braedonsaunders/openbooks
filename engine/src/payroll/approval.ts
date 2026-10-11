import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { PAY_RUN_SUBJECT_KIND } from "../flows/pay-runs-adapter.ts";

type Executor = Pick<typeof db, "execute">;

/**
 * Pay-run approval — payroll's segregation-of-duties control.
 *
 * The tenant's authored Flow determines whether approval is required and
 * which decisions release the run. A tenant without an approval policy can
 * operate payroll directly; configured gates protect commit and payment.
 *
 * There is NO payroll approval engine. Approval is the Flows engine's
 * on_submit gates over the `pay_run` document subject, exactly as for a vendor
 * bill; this module only answers "is an approval outstanding?" for the payroll
 * actions that must fail closed while one is:
 *
 * - commit (materializes the GL projection and claims the period's time),
 * - post (already refused by posting.ts for any status but `approved`),
 * - the bank file (the actual instruction to move money).
 *
 * A tenant with no pay_run flow has no gate, and every action behaves exactly
 * as it did before.
 *
 * "No gate yet" and "no policy exists" are NOT the same state, and the whole
 * control turns on telling them apart. Gates only exist after the run has been
 * SUBMITTED (flows/submit.ts fires on_submit and parks the document); a run in
 * a policy org that has simply never been submitted therefore has zero gates.
 * Reading that as released would let every pay run in a gated tenant skip the
 * approval entirely by going straight to commit.
 *
 * So this module resolves release exactly the way every other document kind
 * does — through the submission lifecycle, not through a gate count:
 *
 * - no on_submit approval policy → unchanged: released unless a gate is open;
 * - policy exists → the run must have been through submission
 *   (`documents.submitted_at`, which flows/submit.ts sets and the reject path
 *   clears) AND have no outstanding gate. A policy flow that matched but
 *   produced no gate for THIS run still releases it, because submission is
 *   what evaluated the policy.
 *
 * `policyExists` counts only flows that can actually gate a submission: an
 * enabled `pay_run` flow whose graph carries an `on_submit` trigger and at
 * least one gate node. A pay-run flow that only does before_void routing or
 * pure automation is not an approval policy and must not block a commit.
 */

export interface PayRunApprovalState {
  /** documents.status of the run. */
  documentStatus: string;
  /** The run is parked awaiting a decision. */
  pending: boolean;
  /** Undecided gates on the run (pending or escalated). */
  outstandingGates: number;
  /** An enabled on_submit gating flow covers pay runs in this org. */
  policyExists: boolean;
  /** The run has been through submission (documents.submitted_at is set). */
  submitted: boolean;
  /** Approval has been granted (or no policy applies) — money may move. */
  released: boolean;
}

/**
 * An enabled `pay_run` flow that can actually park a submission: an on_submit
 * trigger node plus at least one gate node in the same graph.
 * (packages/forms-core automation.ts — node.data.kind is the discriminator.)
 */
const GATING_ON_SUBMIT_FLOW = sql`
  jsonb_path_exists(f.graph,
    '$.nodes[*].data ? (@.kind == "trigger" && @.trigger.trigger == "on_submit")')
  and jsonb_path_exists(f.graph, '$.nodes[*].data ? (@.kind == "gate")')
`;

export async function payRunApprovalState(
  orgId: string,
  documentId: string,
  executor: Executor = db,
): Promise<PayRunApprovalState> {
  const rows = (await executor.execute<{ status: string; submitted: boolean; open_gates: number; policies: number }>(sql`
    select d.status,
           d.submitted_at is not null as submitted,
           (select count(*)::int from flow_gates g
             where g.org_id = ${orgId} and g.subject_kind = ${PAY_RUN_SUBJECT_KIND}
               and g.subject_id = d.id and g.status in ('pending', 'escalated')) as open_gates,
           (select count(*)::int from flows f
             where f.org_id = ${orgId} and f.subject_kind = ${PAY_RUN_SUBJECT_KIND}
               and f.enabled and ${GATING_ON_SUBMIT_FLOW}) as policies
      from documents d
     where d.org_id = ${orgId} and d.id = ${documentId} and d.kind = 'pay_run'
  `));
  const row = rows.rows[0];
  if (!row) throw new PayrollError("pay run not found");
  const outstandingGates = Number(row.open_gates ?? 0);
  const pending = row.status === "pending_approval" || outstandingGates > 0;
  const policyExists = Number(row.policies ?? 0) > 0;
  // `approved` / `posted` are release states in their own right: the document
  // adapter only reaches them through the approval lifecycle.
  const submitted =
    row.submitted === true || row.status === "approved" || row.status === "posted";
  return {
    documentStatus: row.status,
    pending,
    outstandingGates,
    policyExists,
    submitted,
    released: !pending && (!policyExists || submitted),
  };
}

/**
 * The rejection the run is currently waiting on, recorded by the Flows gate
 * that rejected it. The rejecter and reason are the gate's own decision
 * fields; nothing here is stored separately.
 */
export interface PayRunRejection {
  /** Display name of the approver who rejected the run; null if that user no longer resolves. */
  rejectedBy: string | null;
  /** ISO timestamp the rejection was recorded. */
  rejectedAt: string;
  /** The reason the approver recorded with the rejection, if any. */
  reason: string | null;
}

/**
 * Predicate over `flow_gates g`: a rejected gate of the run's most recent
 * submission. A submission is every on_submit flow run created in one
 * transaction (they share `started_at`); a resubmission or withdrawal starts
 * or cancels the latest submission, so an earlier rejection stops being
 * current the moment the run is sent back into approval. Run identity, not
 * timestamps, relates the gate to the submission: decisions are stamped by
 * the application clock and runs by the database clock.
 */
function currentRejectionPredicate(orgId: SQL, documentId: SQL): SQL {
  return sql`g.org_id = ${orgId}
    and g.subject_kind = ${PAY_RUN_SUBJECT_KIND}
    and g.subject_id = ${documentId}
    and g.status = 'rejected'
    and g.run_id in (
      select r.id from flow_runs r
       where r.org_id = g.org_id and r.subject_kind = g.subject_kind
         and r.subject_id = g.subject_id and r.trigger = 'on_submit'
         and r.started_at = (
           select max(l.started_at) from flow_runs l
            where l.org_id = g.org_id and l.subject_kind = g.subject_kind
              and l.subject_id = g.subject_id and l.trigger = 'on_submit'))`;
}

/**
 * SQL existence test for a current pay-run rejection, for list queries.
 * `orgId` and `documentId` are column references owned by the caller
 * (e.g. `d.org_id`, `d.id`). The caller decides whether the document state
 * shows it: a rejection is only meaningful while the run is back in draft
 * and uncommitted.
 */
export function payRunRejectedSql(orgId: SQL, documentId: SQL): SQL {
  return sql`exists (select 1 from flow_gates g where ${currentRejectionPredicate(orgId, documentId)})`;
}

/**
 * The run's current rejection, or null. Returned only while the run is in
 * draft and uncommitted: the operator can then recalculate and resubmit, and
 * the page names who rejected it and why. A committed run never reports one.
 */
export async function payRunRejection(
  orgId: string,
  documentId: string,
  executor: Executor = db,
): Promise<PayRunRejection | null> {
  const state = await executor.execute<{ status: string; run_status: string }>(sql`
    select d.status, r.run_status
      from documents d
      join pay_runs r on r.document_id = d.id and r.org_id = d.org_id
     where d.org_id = ${orgId} and d.id = ${documentId} and d.kind = 'pay_run'
  `);
  const run = state.rows[0];
  if (!run) throw new PayrollError("pay run not found");
  if (run.status !== "draft" || run.run_status === "committed") return null;
  const rows = await executor.execute<{ decided_by_name: string | null; decided_at: Date | string | null; comment: string | null }>(sql`
    select decider.name as decided_by_name, g.decided_at, g.comment
      from flow_gates g
      left join users decider on decider.id = g.decided_by and decider.org_id = g.org_id
     where ${currentRejectionPredicate(sql`${orgId}`, sql`${documentId}`)}
     order by g.decided_at desc nulls last, g.id desc
     limit 1
  `);
  const row = rows.rows[0];
  if (!row) return null;
  const decidedAt = row.decided_at instanceof Date
    ? row.decided_at.toISOString()
    : row.decided_at == null ? "" : new Date(String(row.decided_at)).toISOString();
  const reason = row.comment?.trim() || null;
  return {
    rejectedBy: row.decided_by_name ?? null,
    rejectedAt: decidedAt,
    reason,
  };
}

/**
 * Fail closed while an approval is outstanding. Called by commit and by the
 * bank-file release; posting is already gated by the document lifecycle
 * (posting.ts refuses anything that is not `approved`).
 */
export async function assertPayRunApprovalReleased(
  orgId: string,
  documentId: string,
  executor: Executor = db,
): Promise<void> {
  const state = await payRunApprovalState(orgId, documentId, executor);
  if (state.released) return;
  if (state.outstandingGates > 0) {
    throw new PayrollError(
      `pay run is awaiting ${state.outstandingGates} approval${state.outstandingGates === 1 ? "" : "s"}`,
    );
  }
  if (state.policyExists && !state.submitted) {
    throw new PayrollError(
      "pay run has not been submitted for approval — this organization requires a pay-run approval",
    );
  }
  throw new PayrollError("pay run is awaiting approval");
}
