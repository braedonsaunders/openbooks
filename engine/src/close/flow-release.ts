/**
 * Engine-owned close-run approval release.
 * Runs inside decideGate's serialized org transaction.
 */
import { finalizeCloseFlowApproval } from "./approvals.ts";

/**
 * Structural args match the registered release handler and retain the
 * submitting flow run identity for native policy verification.
 */
export async function releaseCloseRunApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  ctx: { orgId: string; userId?: string | null };
  approvalRunId?: string;
}): Promise<void> {
  await finalizeCloseFlowApproval({
    orgId: args.ctx.orgId,
    runId: args.subjectId,
    actorId: args.ctx.userId ?? null,
    outcome: args.outcome,
    approvalRunId: args.approvalRunId,
  });
}
