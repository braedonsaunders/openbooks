import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { pinnedGateAllowsSelfApproval } from "./gate-policy.ts";

/** Re-resolve native decision evidence; caller-supplied policy flags grant no authority. */
export async function completedGateDecisionPolicy(executor: SqlExecutor, input: {
  orgId: string; subjectKind: string; subjectId: string; approvalRunId?: string;
  actorId: string; outcome: "approved" | "rejected";
  trigger?: "on_submit";
}): Promise<{ allowsSelfApproval: boolean; context: unknown } | null> {
  if (!input.approvalRunId) return null;
  const gates = (await executor.execute<{ context: unknown; node_id: string }>(sql`
    select r.context,g.node_id from flow_runs r join flow_gates g
      on g.org_id=r.org_id and g.run_id=r.id and g.flow_id=r.flow_id
      and g.subject_id=r.subject_id and g.subject_kind=r.subject_kind
    where r.org_id=${input.orgId} and r.id=${input.approvalRunId} and r.subject_id=${input.subjectId}
      and r.subject_kind=${input.subjectKind}
      and (${input.trigger ?? null}::text is null or r.trigger=${input.trigger ?? null})
      and r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
      and g.status=${input.outcome} and g.decided_by=${input.actorId}
      and not exists(select 1 from flow_gates pending where pending.org_id=r.org_id
        and pending.subject_kind=r.subject_kind and pending.subject_id=r.subject_id
        and pending.status in ('pending','escalated'))
    for share of r,g
  `)).rows;
  if (gates.length === 0) return null;
  return { allowsSelfApproval: gates.some(gate => pinnedGateAllowsSelfApproval(gate.context, gate.node_id)), context: gates[0]!.context };
}

export async function completedGateAllowsSelfApproval(
  executor: SqlExecutor, input: Parameters<typeof completedGateDecisionPolicy>[1],
): Promise<boolean> {
  return (await completedGateDecisionPolicy(executor, input))?.allowsSelfApproval === true;
}
