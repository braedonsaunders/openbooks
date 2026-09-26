/**
 * Engine-owned allocation-run approval release.
 * Moved verbatim from flows/allocation-runs-adapter.ts releaseApproval;
 * the adapter now delegates through the registered releaseFlowApproval
 * seam. Runs inside decideGate's serialized org transaction (inDbTransaction
 * participates rather than nesting). postAllocationRun is a static
 * intra-module import — the flows -> allocations dynamic edge (E9b) is gone.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postAllocationRun } from "./period-run.ts";

/** Minimal release guard: the owning org and lifecycle status of a run. */
async function loadReleaseGuard(subjectId: string): Promise<{ org_id: string; status: string } | null> {
  const result = await db.execute<{ org_id: string; status: string }>(sql`
    select org_id, status from allocation_runs where id = ${subjectId}`);
  return result.rows[0] ?? null;
}

/**
 * Release an allocation run approval. Structural args (no flows import:
 * the owner module must not depend on the flows orchestrator); assignable
 * to the registered release handler type, checked at registration.
 */
export async function releaseAllocationRunApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  const { subjectId, outcome, ctx } = args;
  const detailComment = args.comment;
// Deterministic, engine-owned release — independent of any authored
// change_status node. Only acts while the run awaits approval, so it is
// idempotent and never fights a status a later action set. Runs inside
// decideGate's serialized org transaction; every statement below joins
// that unit (inDbTransaction participates rather than nesting).
const run = await loadReleaseGuard(subjectId);
if (!run || run.org_id !== ctx.orgId) {
  throw new Error(`allocation run ${subjectId} does not belong to this organization`);
}
if (run.status !== "pending_approval") return;
if (outcome === "approved") {
  if (!ctx.userId) throw new Error("a signed-in approver is required");
  const comment = detailComment?.trim() || null;
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
const comment = detailComment?.trim() || null;
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
}
