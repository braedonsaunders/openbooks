import { releaseNettingRunApproval } from "./netting.ts";

/**
 * Registered Flows release for intercompany netting runs. Runs inside the
 * gate decision's transaction, so a refusal rolls the decision back.
 */
export async function releaseNettingRunFlowApproval(args: {
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  await releaseNettingRunApproval({
    orgId: args.ctx.orgId,
    runId: args.subjectId,
    actorId: args.ctx.userId ?? null,
    outcome: args.outcome,
    comment: args.comment ?? null,
    approvalRunId: args.approvalRunId,
  });
}
