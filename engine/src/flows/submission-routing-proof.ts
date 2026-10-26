import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { automationGraphSchema, type AutomationGraph } from "@openbooks/forms-core";
import { db, pinnedTransactionExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import type { FlowSubmissionPolicy } from "../platform/flow-submission-policy.ts";
import { lockApprovalSubject } from "../platform/approval-routing.ts";

export interface CompletedSubmissionRouting {
  context: Record<string, unknown>;
  graph: AutomationGraph;
  flowId: string;
  createdBy: string | null;
  submissionId: string;
  policy: FlowSubmissionPolicy;
}

/** Resolve successful automatic routing from native locked evidence. Subject
 * writers independently recheck live authority and their frozen proposal. */
export async function requireCompletedSubmissionRouting(input: {
  orgId: string;
  subjectKind: string;
  subjectId: string;
  runId: string;
  actorId: string;
}): Promise<CompletedSubmissionRouting> {
  if (
    ![input.orgId, input.subjectId, input.runId, input.actorId].every(isUuid) ||
    !input.subjectKind ||
    !pinnedTransactionExecutor()
  ) {
    throw new Error(
      "Automatic submission requires its native actor, record and active transaction.",
    );
  }
  await lockApprovalSubject(input.orgId, input.subjectKind, input.subjectId);
  const row = (
    await db.execute<{
      flow_id: string;
      created_by: string | null;
      context: Record<string, unknown>;
      graph: unknown;
      submission_id: string;
      policy: FlowSubmissionPolicy;
    }>(
      sql`
    select r.flow_id, r.created_by, r.context, r.context->'submissionPolicy'->'graph' as graph,
      receipt.id as submission_id, receipt.policy
      from flow_runs r join flow_submissions receipt on receipt.org_id=r.org_id
       and receipt.subject_kind=r.subject_kind and receipt.subject_id=r.subject_id
       and receipt.actor_id=${input.actorId} and receipt.policy->'runIds' ? r.id::text
       and public.flow_ungated_submission_authorized(receipt.org_id,receipt.subject_kind,receipt.subject_id,receipt.actor_id)
     where r.org_id=${input.orgId} and r.id=${input.runId}
       and r.subject_kind=${input.subjectKind} and r.subject_id=${input.subjectId}
       and r.trigger='on_submit' and r.status='completed' and r.error is null
       and not exists(select 1 from flow_gates g where g.org_id=r.org_id and g.run_id=r.id)
       and not exists(select 1 from flow_gates g where g.org_id=r.org_id
         and g.subject_kind=r.subject_kind and g.subject_id=r.subject_id and g.status in ('pending','escalated'))
       and not exists(select 1 from flow_runs other where other.org_id=r.org_id
         and other.subject_kind=r.subject_kind and other.subject_id=r.subject_id
         and other.trigger='on_submit' and other.id<>r.id and other.status in ('running','waiting','failed'))
     for share of r
  `,
      "objects",
    )
  )[0];
  const graph = automationGraphSchema.safeParse(row?.graph);
  const context = row?.context;
  const proof = context?.submissionRouting;
  const policy = context?.submissionPolicy;
  if (
    !row ||
    !graph.success ||
    !context ||
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy)
  ) {
    throw new Error(
      "Automatic submission has no complete routing evidence; review the record workflow before retrying.",
    );
  }
  const routing = proof as Record<string, unknown>;
  const submission = policy as Record<string, unknown>;
  const digest = createHash("sha256").update(canonicalJson(graph.data)).digest("hex");
  if (
    routing.version !== 1 ||
    routing.runId !== input.runId ||
    routing.flowId !== row.flow_id ||
    routing.subjectKind !== input.subjectKind ||
    routing.subjectId !== input.subjectId ||
    routing.actorId !== input.actorId ||
    routing.outcome !== "apply" ||
    routing.gatesCreated !== 0 ||
    !Array.isArray(routing.failures) ||
    routing.failures.length !== 0 ||
    typeof context.event_source !== "string" ||
    context.event_source.length === 0 ||
    routing.eventSource !== context.event_source ||
    routing.graphDigest !== digest ||
    submission.flowId !== row.flow_id ||
    !submission.graph ||
    typeof submission.graph !== "object" ||
    Array.isArray(submission.graph) ||
    canonicalJson(submission.graph) !== canonicalJson(graph.data)
  ) {
    throw new Error(
      "Automatic submission routing or policy changed; review the current record and workflow before retrying.",
    );
  }
  return {
    context,
    graph: graph.data,
    flowId: row.flow_id,
    createdBy: row.created_by,
    submissionId: row.submission_id,
    policy: row.policy,
  };
}
