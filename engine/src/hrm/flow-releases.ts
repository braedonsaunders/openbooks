/**
 * Engine-owned HRM approval releases (ARCH-MODULE-CYCLE C13).
 * Moved verbatim from the flows adapters' releaseApproval bodies
 * (comp-cycles, hrm-change-requests, leave-requests); the adapters now
 * delegate through the registered releaseFlowApproval seam. Each release
 * runs inside decideGate's serialized org transaction.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { releaseCompCycleDecision } from "./compensation/cycles.ts";
import { releaseHrmChangeRequest } from "./change-requests.ts";
import { releaseLeaveRequest } from "./leave.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal release guard: the owning org of a compensation cycle. */
async function loadCycleOrg(subjectId: string): Promise<{ org_id: string } | null> {
  if (!UUID_RE.test(subjectId)) return null;
  const result = await db.execute<{ org_id: string }>(sql`
    select org_id from hrm_comp_cycles where id = ${subjectId}`);
  return result.rows[0] ?? null;
}

type ReleaseArgs = {
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
  if (!UUID_RE.test(subjectId)) {
    throw new Error(`unknown compensation cycle ${subjectId}`);
  }
  if (outcome !== "approved" && outcome !== "rejected") {
    throw new Error(`unknown compensation decision ${outcome}`);
  }
  const cycle = await loadCycleOrg(subjectId);
  if (!cycle) throw new Error("compensation cycle is not visible");
  // The release stamps the cycle inside decideGate's savepoint; the
  // service refuses a non-review cycle so the gate stays pending.
  await releaseCompCycleDecision(cycle.org_id, subjectId, outcome, ctx.userId ?? "");
}

/** Release an employment change-request approval (same seam contract). */
export async function releaseHrmChangeRequestApproval(args: ReleaseArgs): Promise<void> {
  const { subjectId, outcome, ctx } = args;
  if (!UUID_RE.test(subjectId)) {
    throw new Error(`unknown employment change request ${subjectId}`);
  }
  await releaseHrmChangeRequest({
    orgId: ctx.orgId,
    actorId: ctx.userId ?? "",
    requestId: subjectId,
    outcome,
    comment: args.comment ?? null,
  });
}

/** Release a leave-request approval (same seam contract). */
export async function releaseLeaveRequestApproval(args: ReleaseArgs): Promise<void> {
  const { subjectId, outcome, ctx } = args;
  if (!UUID_RE.test(subjectId)) {
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
  });
}
