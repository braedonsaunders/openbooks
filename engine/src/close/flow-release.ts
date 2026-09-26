/**
 * Engine-owned close-run approval release.
 * Moved verbatim from flows/close-runs-adapter.ts releaseApproval; the
 * adapter now delegates through the registered releaseFlowApproval seam.
 * Runs inside decideGate's serialized org transaction.
 */
import { finalizeCloseFlowApproval } from "./approvals.ts";

/**
 * Release a close run approval. Structural args (no flows import: the
 * owner module must not depend on the flows orchestrator); assignable to
 * the registered release handler type, checked at registration.
 */
export async function releaseCloseRunApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  await finalizeCloseFlowApproval({
    orgId: args.ctx.orgId,
    runId: args.subjectId,
    actorId: args.ctx.userId ?? null,
    outcome: args.outcome,
  });
}
