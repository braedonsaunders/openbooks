import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { PayrollError } from "./payroll-run.ts";
import { PAY_RUN_SUBJECT_KIND } from "./flows/pay-runs-adapter.ts";

/**
 * Pay-run approval — payroll's segregation-of-duties control.
 *
 * Money must not move before the run is reviewed: the office manager checks
 * the payroll journal, one or two executives approve, and only then is the run
 * committed, posted, and its bank file released.
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
): Promise<PayRunApprovalState> {
  const rows = (await db.execute(sql`
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
  `)) as unknown as {
    rows: { status: string; submitted: boolean; open_gates: number; policies: number }[];
  };
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
 * Fail closed while an approval is outstanding. Called by commit and by the
 * bank-file release; posting is already gated by the document lifecycle
 * (posting.ts refuses anything that is not `approved`).
 */
export async function assertPayRunApprovalReleased(
  orgId: string,
  documentId: string,
): Promise<void> {
  const state = await payRunApprovalState(orgId, documentId);
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
