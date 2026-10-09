/**
 * Engine-owned HRM approval releases.
 * Moved verbatim from the flows adapters' releaseApproval bodies
 * (comp-cycles, hrm-change-requests, leave-requests); the adapters now
 * delegate through the registered releaseFlowApproval seam. Each release
 * runs inside decideGate's serialized org transaction.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { releaseCompCycleDecision } from "./compensation/cycles.ts";
import { releaseHrmChangeRequest } from "./change-requests.ts";
import { releaseBenefitEnrollmentApproval } from "./benefits/enrollments.ts";
import { releaseBenefitAwardApproval } from "./benefits/awards.ts";
import { releaseLeaveRequest } from "./leave.ts";

/** Minimal release guard: the owning org of a compensation cycle. */
async function loadCycleOrg(subjectId: string, orgId: string): Promise<{ org_id: string } | null> {
  if (!isUuid(subjectId)) return null;
  const result = await db.execute<{ org_id: string }>(sql`
    select org_id from hrm_comp_cycles where id = ${subjectId} and org_id = ${orgId}`);
  return result.rows[0] ?? null;
}

type ReleaseArgs = {
  approvalRunId?: string;
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: { orgId: string; userId?: string | null };
};

/**
 * Release a compensation-cycle approval. Structural args (no flows
 * import: the owner module must not depend on the flows orchestrator);
 * assignable to the registered release handler type, checked at
 * registration.
 */
export async function releaseCompCycleApproval(args: ReleaseArgs): Promise<void> {
  const { subjectId, outcome, ctx } = args;
  if (!isUuid(subjectId)) {
    throw new Error(`unknown compensation cycle ${subjectId}`);
  }
  if (outcome !== "approved" && outcome !== "rejected") {
    throw new Error(`unknown compensation decision ${outcome}`);
  }
  const cycle = await loadCycleOrg(subjectId, ctx.orgId);
  if (!cycle) throw new Error("compensation cycle is not visible");
  // The release stamps the cycle inside decideGate's savepoint; the
  // service refuses a non-review cycle so the gate stays pending.
  await releaseCompCycleDecision(cycle.org_id, subjectId, outcome, ctx.userId ?? "", args.approvalRunId);
}

/** Release an employment change-request approval (same seam contract). */
export async function releaseHrmChangeRequestApproval(args: ReleaseArgs): Promise<void> {
  const { subjectId, outcome, ctx } = args;
  if (!isUuid(subjectId)) {
    throw new Error(`unknown employment change request ${subjectId}`);
  }
  await releaseHrmChangeRequest({
    orgId: ctx.orgId,
    actorId: ctx.userId ?? "",
    requestId: subjectId,
    outcome,
    comment: args.comment ?? null,
    approvalRunId: args.approvalRunId,
  });
}

/** Release a leave-request approval (same seam contract). */
export async function releaseLeaveRequestApproval(args: ReleaseArgs): Promise<void> {
  const { subjectId, outcome, ctx } = args;
  if (!isUuid(subjectId)) {
    throw new Error(`unknown leave request ${subjectId}`);
  }
  if (outcome !== "approved" && outcome !== "rejected") {
    throw new Error(`unknown leave decision ${outcome}`);
  }
  await releaseLeaveRequest({
    orgId: ctx.orgId,
    actorId: ctx.userId ?? "",
    requestId: subjectId,
    outcome,
    comment: args.comment ?? null,
    approvalRunId: args.approvalRunId,
  });
}

/** Release a Benefits reward only after the native gate aggregate resolves. */
export async function releaseBenefitAwardFlowApproval(args: ReleaseArgs): Promise<void> {
  await releaseBenefitAwardApproval({ orgId: args.ctx.orgId, actorId: args.ctx.userId ?? "", awardId: args.subjectId, outcome: args.outcome, comment: args.comment });
}

/** Release recurring contribution coverage through the same native decision seam. */
export async function releaseBenefitEnrollmentFlowApproval(args: ReleaseArgs): Promise<void> {
  await releaseBenefitEnrollmentApproval({orgId:args.ctx.orgId,actorId:args.ctx.userId ?? '',enrollmentId:args.subjectId,outcome:args.outcome,comment:args.comment});
}
