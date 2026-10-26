import { withdrawFlowCommandSubject } from "./approval-release-hook.ts";
import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { sql } from "drizzle-orm";
import { db, pinnedTransactionExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import type { NativeApprovalCommand } from "../platform/approval-routing.ts";
import { completedGateDecisionPolicy } from "./approval-decision-policy.ts";
import { routeSubjectSubmission } from "./submission-policy.ts";
import { getFlowAdapter } from "./registry.ts";
import { FlowDispatchError } from "./dispatch-result.ts";

/** Verify the exact command and record snapshot before a native service spends a Flow decision. */
export async function routeApprovalCommand(input: NativeApprovalCommand): Promise<boolean> {
  if (!pinnedTransactionExecutor())
    throw new FlowDispatchError("Approval commands require the subject's native transaction.");
  await lockApprovalSubject(input.orgId, input.subjectKind, input.subjectId);
  const adapter = getFlowAdapter(input.subjectKind);
  if (!adapter?.nativeCommandApproval)
    throw new FlowDispatchError("This record does not expose a native approval command.");
  const subject = await adapter.loadContext(input.subjectId);
  const fingerprint = subject?.values.approvalFingerprint;
  if (typeof fingerprint !== "string")
    throw new FlowDispatchError("The native approval subject has no complete record fingerprint.");
  if (input.approvalRunId) {
    const evidence = await completedGateDecisionPolicy(db, {
      ...input,
      outcome: "approved",
    });
    const context = evidence?.context as Record<string, unknown> | undefined;
    if (
      !context ||
      context.approvalFingerprint !== fingerprint ||
      canonicalJson(context.command) !== canonicalJson(input.command)
    )
      throw new FlowDispatchError(
        "These terms differ from the submitted command. Withdraw the pending submission and submit the current record through Flows.",
      );
    return false;
  }
  const pending = await db.execute<{ context: Record<string, unknown> }>(
    sql`
    select r.context from flow_gates g join flow_runs r on r.org_id=g.org_id and r.id=g.run_id
    where g.org_id=${input.orgId} and g.subject_kind=${input.subjectKind} and g.subject_id=${input.subjectId}
      and g.status in ('pending','escalated') order by g.created_at,g.id for share of g,r`,
    "objects",
  );
  if (pending.length) {
    if (
      pending.some(
        (row) =>
          row.context.approvalFingerprint !== fingerprint ||
          canonicalJson(row.context.command) !== canonicalJson(input.command),
      )
    )
      throw new FlowDispatchError(
        "A different revision or command is awaiting approval. Withdraw that submission before submitting changed terms.",
      );
    return true;
  }
  const routing = await routeSubjectSubmission({ ...input, source: "api" });
  return routing.policy.kind === "gated";
}

/** Recall an unexecuted native command; decided evidence stays immutable. */
export async function withdrawApprovalCommand(input: {
  orgId: string;
  actorId: string;
  subjectKind: string;
  subjectId: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 2000)
    throw new FlowDispatchError("Record a withdrawal reason between 3 and 2000 characters.");
  const { withOrgTransaction } = await import("../platform/db.ts");
  const { lockApprovalSubject } = await import("../platform/approval-routing.ts");
  const { lockActorIdentity, actorHasPermission } =
    await import("../organization/actor-permissions.ts");
  const { actorAllowedSubsidiaryIds } = await import("../organization/actor-subsidiaries.ts");
  const { lockSubjectScope } = await import("./subject-scope.ts");
  const { cancelDispatchRuns } = await import("./dispatch-result.ts");
  const { ScopeNotFoundError } = await import("../organization/subsidiary-scope.ts");
  await withOrgTransaction(input.orgId, async () => {
    await lockApprovalSubject(input.orgId, input.subjectKind, input.subjectId);
    if (!(await lockActorIdentity(db, input.orgId, input.actorId))) throw new ScopeNotFoundError();
    const adapter = getFlowAdapter(input.subjectKind);
    if (!adapter?.nativeCommandApproval) throw new ScopeNotFoundError();
    const scope = await actorAllowedSubsidiaryIds(db, input.orgId, input.actorId);
    await lockSubjectScope(input.orgId, input.subjectKind, adapter.scope, input.subjectId, scope);
    const receipt = (
      await db.execute<{
        id: string;
        actor_id: string;
        policy: { kind: string; runIds: string[] };
        context: Record<string, unknown>;
      }>(
        sql`
   select id,actor_id,policy,context from flow_submissions where org_id=${input.orgId} and subject_kind=${input.subjectKind}
    and subject_id=${input.subjectId} order by created_at desc,id desc limit 1`,
        "objects",
      )
    )[0];
    if (!receipt?.context.command || receipt.policy.kind !== "gated")
      throw new FlowDispatchError("This record has no pending native command to recall.");
    if (
      receipt.actor_id !== input.actorId &&
      !(await actorHasPermission(db, input.orgId, input.actorId, "flows.manage"))
    )
      throw new ScopeNotFoundError();
    const open = await db.execute<{
      run_id: string;
    }>(
      sql`select distinct run_id from flow_gates where org_id=${input.orgId}
    and subject_kind=${input.subjectKind} and subject_id=${input.subjectId} and status in ('pending','escalated')`,
      "objects",
    );
    if (!open.length)
      throw new FlowDispatchError(
        "This command has already been decided. Reload its recorded outcome.",
      );
    await cancelDispatchRuns(
      input.orgId,
      open.map((row) => row.run_id),
      { actorId: input.actorId },
    );
    await withdrawFlowCommandSubject({ ...input, reason });
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values
   (${input.orgId},'flow_submissions',${receipt.id},'withdraw',${JSON.stringify({ event: "command_withdrawn", subjectKind: input.subjectKind, reason, runIds: open.map((row) => row.run_id) })}::jsonb,${input.actorId})`);
  });
}
