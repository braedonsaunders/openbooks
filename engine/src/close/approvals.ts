import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { routeSubjectSubmission, type SubmissionPolicy } from "../flows/submission-policy.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { CloseError } from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { periodFingerprint } from "./period-fingerprint.ts";
import { refreshCloseRun } from "./run-automation.ts";
import { completedGateDecisionPolicy } from "../flows/approval-decision-policy.ts";
async function assertCloseReadyForApproval(
  executor: SqlExecutor,
  orgId: string,
  runId: string,
): Promise<void> {
  const blockers = await executor.execute<{
    tasks: string;
    exceptions: string;
  }>(
    sql`
    select
      (select count(*) from close_run_tasks where run_id = ${runId} and org_id = ${orgId} and gate_type = 'hard'
        and task_type <> 'approval'
        and key not in ('lock-subledgers','lock-gl','publish-package')
        and (status not in ('complete','waived') or (completion_mode='manual' and data_fingerprint is distinct from
          (select data_fingerprint from close_runs r where r.org_id=${orgId} and r.id=${runId})))) as tasks,
      (select count(*) from close_exceptions where run_id = ${runId} and org_id = ${orgId} and status = 'open'
        and severity in ('error','critical')) as exceptions
  `,
    "objects",
  );
  if (Number(blockers[0]?.tasks ?? 0) > 0 || Number(blockers[0]?.exceptions ?? 0) > 0) {
    throw new CloseError(
      "hard-gated tasks and critical exceptions must be resolved before approval",
    );
  }
}

export async function requestCloseApproval(
  orgId: string,
  runId: string,
  actorId: string,
): Promise<{ approvals: number }> {
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "close_run", runId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "continuousClose")))
      throw new CloseError(
        "Enable Continuous Close in Company Settings → Features before submitting close work.",
      );
    await refreshCloseRun(orgId, runId, actorId);
    const outcome = await withOrg(orgId, async () => {
      if ((await lockActorCommandAuthority(db, orgId, actorId, null, "close.run")) !== null)
        throw new CloseError("Close run commands require access to the whole organization.");
      // Serialize the status check, gate creation, and transition to review so a
      // double-click or concurrent request can never create duplicate approvals.
      const run = await db.execute<{
        status: string;
        data_fingerprint: string | null;
      }>(
        sql`
      select status, data_fingerprint from close_runs
       where id = ${runId} and org_id = ${orgId} for update
    `,
        "objects",
      );
      if (!run[0]) throw new CloseError("close run not found");
      if (run[0].status === "review") {
        const pending = await db.execute<{ count: number }>(
          sql`
        select count(*)::int as count from flow_gates
         where org_id = ${orgId} and subject_kind = 'close_run' and subject_id = ${runId}
           and status in ('pending','escalated')
      `,
          "objects",
        );
        if (Number(pending[0]?.count ?? 0) > 0)
          throw new CloseError("close approval is already in progress");
      } else if (run[0].status !== "in_progress") {
        throw new CloseError("only an in-progress close run can be submitted for approval");
      }
      await assertCloseReadyForApproval(db, orgId, runId);

      const { dispatch: result, policy } = await routeSubjectSubmission({
        orgId,
        subjectKind: "close_run",
        subjectId: runId,
        actorId,
        command: { action: "approve" },
      });
      const submitted = await db.execute(
        sql`
      update close_runs set status = 'review', current_stage = 'review',
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId} and status in ('in_progress','review') returning id
    `,
        "objects",
      );
      if (submitted.length !== 1)
        throw new CloseError("The close changed during submission; reload it.");
      await db.execute(sql`
      update close_run_tasks set status = 'submitted', data_fingerprint = ${run[0].data_fingerprint},
             completed_at = null, completed_by = null, reviewed_at = null, reviewed_by = null,
             updated_at = now(), updated_by = ${actorId}
       where run_id = ${runId} and org_id = ${orgId} and task_type = 'approval'
         and status not in ('waived')
    `);
      await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.approval_requested', ${actorId},
              ${JSON.stringify({ approvals: result.gatesCreated, flowRuns: result.runs.map((item) => item.runId) })}::jsonb)
    `);
      if (policy.kind === "ungated")
        await finalizeCloseRun({ orgId, runId, actorId, outcome: "approved" }, policy);
      return { approvals: result.gatesCreated, error: null };
    });
    return { approvals: outcome.approvals };
  });
}

export async function finalizeCloseFlowApproval(args: {
  orgId: string;
  runId: string;
  actorId: string | null;
  outcome: "approved" | "rejected";
  approvalRunId?: string;
}): Promise<void> {
  if (!args.actorId) throw new CloseError("A signed-in reviewer is required.");
  if (!(await lockAndCheckOrgFeature(db, args.orgId, "continuousClose")))
    throw new CloseError(
      "Enable Continuous Close in Company Settings → Features before releasing close work.",
    );
  const proof = await completedGateDecisionPolicy(db, {
    orgId: args.orgId,
    subjectKind: "close_run",
    subjectId: args.runId,
    approvalRunId: args.approvalRunId,
    actorId: args.actorId,
    outcome: args.outcome,
  });
  if (!proof)
    throw new CloseError("Complete the configured close Flow gates before releasing the run.");
  if (
    (await lockActorCommandAuthority(db, args.orgId, args.actorId, null, "close.approve")) !== null
  )
    throw new CloseError("Close run decisions require access to the whole organization.");
  return finalizeCloseRun(args);
}

async function finalizeCloseRun(
  args: {
    orgId: string;
    runId: string;
    actorId: string | null;
    outcome: "approved" | "rejected";
    approvalRunId?: string;
  },
  ungatedPolicy?: SubmissionPolicy,
): Promise<void> {
  if (!args.actorId) throw new CloseError("a signed-in approver is required");
  // decideGate calls this inside its serialized, org-scoped transaction. Keep
  // every statement on that transaction instead of opening a nested one.
  const run = await db.execute<{
    status: string;
    started_by: string | null;
    data_fingerprint: string | null;
    period_id: string;
    book_id: string;
    scope: { subsidiaryIds?: string[] };
    system_blueprint: boolean;
  }>(
    sql`
    select r.status,r.started_by,r.data_fingerprint,r.period_id,r.book_id,r.scope,
           b.name='close.defaultData.blueprint.name' as system_blueprint
      from close_runs r join close_blueprints b on b.id=r.blueprint_id and b.org_id=r.org_id
     where r.id = ${args.runId} and r.org_id = ${args.orgId} for update of r
  `,
    "objects",
  );
  const row = run[0];
  if (!row) throw new CloseError("close run not found");
  if (row.status !== "review")
    throw new CloseError("the close review changed and must be submitted again");
  if (!ungatedPolicy && row.started_by === args.actorId) {
    const proof = await completedGateDecisionPolicy(db, {
      orgId: args.orgId,
      subjectKind: "close_run",
      subjectId: args.runId,
      approvalRunId: args.approvalRunId,
      actorId: args.actorId,
      outcome: args.outcome,
    });
    if (!proof?.allowsSelfApproval)
      throw new CloseError(
        "The submitted Flow gate does not permit the initiator's self decision.",
      );
  }

  const currentFingerprint = await periodFingerprint(
    args.orgId,
    row.period_id,
    row.book_id,
    row.scope?.subsidiaryIds ?? [],
    !row.system_blueprint || !row.scope?.subsidiaryIds?.length,
  );
  if (!row.data_fingerprint || row.data_fingerprint !== currentFingerprint)
    throw new CloseError(
      "The ledger changed during approval; revalidate and submit the close again.",
    );
  const proof = (
    await db.execute<{ allowed: boolean }>(
      sql`select public.flow_subject_decision_authorized(
    ${args.orgId},'close_run',${args.runId},${args.actorId},
    public.close_run_approval_fingerprint(${args.orgId},${args.runId}),${args.outcome}) as allowed`,
      "objects",
    )
  )[0]?.allowed;
  if (!proof)
    throw new CloseError(
      "The close evidence changed after submission. Recall the pending approval, review the current evidence and submit the run again.",
    );

  if (args.outcome === "rejected") {
    await db.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review',
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.runId} and org_id = ${args.orgId}
    `);
    await db.execute(sql`
      update close_run_tasks set status = 'changes_requested', completed_at = null, completed_by = null,
             reviewed_at = now(), reviewed_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
       where run_id = ${args.runId} and org_id = ${args.orgId} and task_type = 'approval' and status <> 'waived'
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, 'run.approval_rejected', ${args.actorId}, '{}'::jsonb)
    `);
    return;
  }

  await assertCloseReadyForApproval(db, args.orgId, args.runId);
  const released = await db.execute(
    sql`
    update close_runs set status = 'approved', current_stage = 'lock', approved_at = now(),
           approved_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
     where id = ${args.runId} and org_id = ${args.orgId} and status='review' returning id
  `,
    "objects",
  );
  if (released.length !== 1) throw new CloseError("The close changed before release; reload it.");
  await db.execute(sql`
    update close_run_tasks set status = 'complete', completed_at = now(), completed_by = ${args.actorId},
           reviewed_at = case when ${!!ungatedPolicy} then null else now() end,
           reviewed_by = case when ${!!ungatedPolicy} then null else ${args.actorId}::uuid end, data_fingerprint = ${row.data_fingerprint},
           updated_at = now(), updated_by = ${args.actorId}
     where run_id = ${args.runId} and org_id = ${args.orgId} and task_type = 'approval' and status <> 'waived'
  `);
  if (!ungatedPolicy)
    await db.execute(sql`
    insert into close_signoffs (org_id, run_id, signoff_type, decision, data_fingerprint, signed_by)
    values (${args.orgId}, ${args.runId}, 'approve', 'approved', ${row.data_fingerprint}, ${args.actorId})
  `);
  await db.execute(sql`
    insert into close_events (org_id, run_id, event_type, actor_id, payload)
    values (${args.orgId}, ${args.runId}, 'run.approved', ${args.actorId},
            ${JSON.stringify(ungatedPolicy ? { source: "flow", approval: "ungated", policy: ungatedPolicy } : { source: "flow", approval: "gated" })}::jsonb)
  `);
}

/** Restore preparation after the generic native Flow recall has cancelled its open gates. */
export async function withdrawCloseRunSubmission(input: {
  orgId: string;
  subjectId: string;
  actorId: string;
  reason: string;
}): Promise<void> {
  await withOrgTransaction(input.orgId, async () => {
    const scope = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      null,
      "close.run",
    );
    if (scope !== null)
      throw new CloseError("Close run commands require access to the whole organization.");
    const receipt = (
      await db.execute<{ actor_id: string }>(
        sql`select actor_id from flow_submissions s
    where s.org_id=${input.orgId} and s.subject_kind='close_run' and s.subject_id=${input.subjectId}
      and s.policy->>'kind'='gated' and s.context->'command' @> '{"action":"approve"}'::jsonb
      and exists(select 1 from flow_runs r where r.org_id=s.org_id and s.policy->'runIds' ? r.id::text and r.status='cancelled')
      and not exists(select 1 from flow_submissions newer where newer.org_id=s.org_id and newer.subject_kind=s.subject_kind
        and newer.subject_id=s.subject_id and (newer.created_at,newer.id)>(s.created_at,s.id))`,
        "objects",
      )
    )[0];
    if (
      !receipt ||
      (receipt.actor_id !== input.actorId &&
        !(await actorHasPermission(db, input.orgId, input.actorId, "flows.manage")))
    )
      throw new CloseError(
        "Recall the current close submission as its submitter or an authorized Flow manager.",
      );
    const current = (
      await db.execute<{ status: string }>(
        sql`select status from close_runs where org_id=${input.orgId} and id=${input.subjectId} for update`,
        "objects",
      )
    )[0];
    if (current?.status !== "review")
      throw new CloseError("Only a close run awaiting its Flow decision can be recalled.");
    const open = (
      await db.execute<{ present: boolean }>(
        sql`select exists(select 1 from flow_gates where org_id=${input.orgId}
    and subject_kind='close_run' and subject_id=${input.subjectId} and status in('pending','escalated')) as present`,
        "objects",
      )
    )[0]?.present;
    if (open)
      throw new CloseError("Cancel the run's pending Flow gates before restoring preparation.");
    const saved = await db.execute(
      sql`update close_runs set status='in_progress',current_stage='review',approved_by=null,approved_at=null,
    updated_by=${input.actorId},updated_at=now() where org_id=${input.orgId} and id=${input.subjectId} and status='review' returning id`,
      "objects",
    );
    if (saved.length !== 1) throw new CloseError("The close run recall was not saved.");
    await db.execute(sql`update close_run_tasks set status='ready',completed_by=null,completed_at=null,reviewed_by=null,reviewed_at=null,
    updated_by=${input.actorId},updated_at=now() where org_id=${input.orgId} and run_id=${input.subjectId}
      and task_type='approval' and status='submitted'`);
    await db.execute(sql`insert into close_events(org_id,run_id,event_type,actor_id,payload)
    values(${input.orgId},${input.subjectId},'run.approval_withdrawn',${input.actorId},${JSON.stringify({ reason: input.reason })}::jsonb)`);
  });
}
