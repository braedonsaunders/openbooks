/**
 * Engine-owned payment-run approval release. Registered for both payment-run
 * subjects (outbound and inbound); runs inside decideGate's serialized org
 * transaction, so a refusal rolls the gate decision back with it.
 */
import { releasePaymentRunApproval } from "./operations.ts";

/**
 * Structural args, assignable to the registered release handler type and
 * checked at registration.
 */
export async function releasePaymentRunFlowApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  await releasePaymentRunApproval({
    orgId: args.ctx.orgId,
    runId: args.subjectId,
    actorId: args.ctx.userId ?? null,
    outcome: args.outcome,
    comment: args.comment ?? null,
    approvalRunId: args.approvalRunId,
  });
}
