import { CloseError } from "../periods/period-policy.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import {
  db,
  withOrg,
  withOrgTransaction,
  inDbTransaction,
  type SqlExecutor,
} from "../platform/db.ts";
import { resolveTaskDependenciesTx } from "./task-dependencies.ts";
import { runCloseAutomations } from "./run-automation.ts";
import {
  lockApprovalSubject,
  requestNativeCommandApproval,
  readNativeApprovalDecision,
} from "../platform/approval-routing.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { isUuid } from "../platform/uuid.ts";
export type CloseTaskAction = "start" | "submit" | "complete" | "waive";

async function authorizeTask(
  orgId: string,
  actorId: string | null,
  permission: "close.run" | "close.approve",
) {
  if (!actorId || !isUuid(orgId) || !isUuid(actorId))
    throw new CloseError("A signed-in acting user is required for close task commands.");
  if (!(await lockAndCheckOrgFeature(db, orgId, "continuousClose")))
    throw new CloseError(
      "Enable Continuous Close in Company Settings → Features before changing close tasks.",
    );
  const scope = await lockActorCommandAuthority(db, orgId, actorId, null, permission);
  if (scope !== null)
    throw new CloseError("Close task commands require access to the whole close run.");
}

/** Prepare and release close work through the tenant's frozen Flow command. */
export async function transitionCloseTaskTx(
  tx: SqlExecutor,
  args: {
    orgId: string;
    runId: string;
    taskId: string;
    actorId: string | null;
    action: CloseTaskAction;
    notes?: string;
    fingerprint: string;
    approvalRunId?: string;
    outcome?: "approved" | "rejected";
  },
): Promise<void> {
  await lockApprovalSubject(args.orgId, "close_task", args.taskId);
  await authorizeTask(args.orgId, args.actorId, args.approvalRunId ? "close.approve" : "close.run");
  const run = (
    await tx.execute<{ status: string; data_fingerprint: string | null }>(
      sql`
    select status,data_fingerprint from close_runs where org_id=${args.orgId} and id=${args.runId} for share
  `,
      "objects",
    )
  )[0];
  if (!run || !["in_progress", "review"].includes(run.status))
    throw new CloseError(
      "The close run is not editable; reopen its native workflow before changing tasks.",
    );
  if (!run.data_fingerprint || run.data_fingerprint !== args.fingerprint)
    throw new CloseError("Validate the current close run before submitting this task.");
  const task = (
    await tx.execute<{
      status: string;
      owner_id: string | null;
      task_type: string;
      completion_mode: string;
      evidence_required: boolean;
      evidence_count: number;
      notes: string | null;
    }>(
      sql`
    select t.*,(select count(*)::int from close_task_evidence e where e.org_id=t.org_id and e.task_id=t.id) as evidence_count
      from close_run_tasks t where t.id=${args.taskId} and t.run_id=${args.runId} and t.org_id=${args.orgId} for update
  `,
      "objects",
    )
  )[0];
  if (!task) throw new CloseError("close task not found");
  if (task.task_type === "approval")
    throw new CloseError(
      "Submit the close run through its native Flow approval controls; approval tasks reflect that run's recorded decision.",
    );
  if (task.completion_mode !== "manual")
    throw new CloseError("Computed close tasks complete through native run validation.");
  if (task.status === "blocked") throw new CloseError("task dependencies are not complete");
  if (["complete", "waived"].includes(task.status))
    throw new CloseError(
      "This task already completed; validate the run to review its retained evidence.",
    );
  if (!args.approvalRunId && task.owner_id && task.owner_id !== args.actorId)
    throw new CloseError("only the assigned owner can prepare this task");
  if (
    args.action !== "start" &&
    args.action !== "waive" &&
    task.evidence_required &&
    task.evidence_count === 0
  )
    throw new CloseError("required evidence must be attached before this task can be completed");
  const action = args.action === "waive" ? "waive" : "complete";
  const notes = args.notes ?? task.notes;
  const command = { action, runId: args.runId, fingerprint: args.fingerprint, notes };
  if (args.action === "start") {
    if (!["ready", "invalidated", "changes_requested"].includes(task.status))
      throw new CloseError("Only ready or returned tasks can be started.");
  } else if (args.outcome === "rejected") {
    const proof = await readNativeApprovalDecision({
      orgId: args.orgId,
      actorId: args.actorId!,
      subjectKind: "close_task",
      subjectId: args.taskId,
      outcome: "rejected",
      approvalRunId: args.approvalRunId,
    });
    const retained = (
      await tx.execute<{ command: unknown }>(
        sql`select context->'command' as command from flow_runs where org_id=${args.orgId} and id=${args.approvalRunId}`,
        "objects",
      )
    )[0];
    if (!proof || canonicalJson(retained?.command) !== canonicalJson(command))
      throw new CloseError("Decide the current close task's assigned native Flow gate.");
  } else {
    if (!args.approvalRunId) {
      const prepared = await tx.execute(
        sql`update close_run_tasks set status='submitted',notes=${notes},data_fingerprint=${args.fingerprint},
        updated_by=${args.actorId},updated_at=now() where org_id=${args.orgId} and id=${args.taskId} and run_id=${args.runId} returning id`,
        "objects",
      );
      if (prepared.length !== 1) throw new CloseError("The close task submission was not saved.");
    }
    if (
      await requestNativeCommandApproval({
        orgId: args.orgId,
        actorId: args.actorId!,
        subjectKind: "close_task",
        subjectId: args.taskId,
        command,
        approvalRunId: args.approvalRunId,
      })
    ) {
      if (task.status !== "submitted")
        await tx.execute(sql`insert into close_events(org_id,run_id,task_id,event_type,actor_id,payload)
        values(${args.orgId},${args.runId},${args.taskId},'task.submit',${args.actorId},${JSON.stringify({ status: "submitted", notes })}::jsonb)`);
      return;
    }
  }
  const rejected = args.outcome === "rejected";
  const status =
    args.action === "start"
      ? "in_progress"
      : rejected
        ? "changes_requested"
        : action === "waive"
          ? "waived"
          : "complete";
  const preparer = args.approvalRunId
    ? (
        await tx.execute<{ actor_id: string }>(
          sql`
    select actor_id from flow_submissions where org_id=${args.orgId} and subject_kind='close_task' and subject_id=${args.taskId}
      and policy->'runIds' ? ${args.approvalRunId}::text order by created_at desc,id desc limit 1
  `,
          "objects",
        )
      )[0]?.actor_id
    : args.actorId;
  if (status !== "in_progress" && !preparer)
    throw new CloseError(
      "The task's original submission actor is missing; recall and resubmit it.",
    );
  const saved = await tx.execute(
    sql`update close_run_tasks set status=${status},notes=${notes},
    completed_at=case when ${status} in('complete','waived') then now() else null end,
    completed_by=case when ${status} in('complete','waived') then ${preparer}::uuid else null end,
    reviewed_at=case when ${!!args.approvalRunId} then now() else null end,
    reviewed_by=case when ${!!args.approvalRunId} then ${args.actorId}::uuid else null end,
    data_fingerprint=case when ${status}<>'in_progress' then ${args.fingerprint} else data_fingerprint end,
    updated_at=now(),updated_by=${args.actorId}
    where id=${args.taskId} and org_id=${args.orgId} and run_id=${args.runId} returning id`,
    "objects",
  );
  if (saved.length !== 1) throw new CloseError("The close task transition was not saved.");
  if (!rejected && args.action !== "start" && (args.approvalRunId || action === "waive"))
    await tx.execute(sql`insert into close_signoffs(org_id,run_id,task_id,signoff_type,decision,comment,data_fingerprint,signed_by)
      values(${args.orgId},${args.runId},${args.taskId},${action === "waive" ? "waive" : "review"},${action === "waive" ? "waived" : "approved"},${notes},${args.fingerprint},${args.actorId})`);
  await tx.execute(sql`insert into close_events(org_id,run_id,task_id,event_type,actor_id,payload)
    values(${args.orgId},${args.runId},${args.taskId},${`task.${rejected ? "request_changes" : args.approvalRunId ? "approve" : args.action}`},${args.actorId},${JSON.stringify({ status, notes })}::jsonb)`);
  await resolveTaskDependenciesTx(tx, args.orgId, args.runId);
}

/** Flow release verifies the original command and current native authority. */
export async function releaseCloseTaskApproval(args: {
  orgId: string;
  actorId: string;
  taskId: string;
  approvalRunId: string;
  outcome: "approved" | "rejected";
  command: Record<string, unknown>;
}): Promise<void> {
  const command = args.command;
  if (
    (command.action !== "complete" && command.action !== "waive") ||
    !isUuid(command.runId) ||
    typeof command.fingerprint !== "string" ||
    (command.notes !== null && typeof command.notes !== "string")
  )
    throw new CloseError(
      "The close task command is incomplete; recall and resubmit its current evidence.",
    );
  await withOrgTransaction(args.orgId, () =>
    transitionCloseTaskTx(db, {
      ...args,
      runId: command.runId as string,
      action: command.action as "complete" | "waive",
      notes: typeof command.notes === "string" ? command.notes : undefined,
      fingerprint: command.fingerprint as string,
    }),
  );
}

/**
 * Canonical close-task assignment shared by close automation (its only
 * writer today) and any future manual path. Ownership changes are audit
 * evidence like every other task transition: the assignment writes a
 * `task.assign` event with the before/after owner, in the same
 * transaction as the update. A task that is gone (deleted or moved to
 * another run) refuses by name instead of reporting success on zero rows.
 */
export async function assignCloseTaskTx(
  tx: SqlExecutor,
  args: {
    orgId: string;
    runId: string;
    taskId: string;
    ownerId: string | null;
    actorId: string | null;
  },
): Promise<void> {
  await lockApprovalSubject(args.orgId, "close_task", args.taskId);
  await authorizeTask(args.orgId, args.actorId, "close.run");
  const before = (
    await tx.execute<{ owner_id: string | null }>(
      sql`
    select owner_id from close_run_tasks
     where id = ${args.taskId} and run_id = ${args.runId} and org_id = ${args.orgId}
     for update`,
      "objects",
    )
  )[0];
  if (!before) throw new CloseError("automation task not found");
  const updated = await tx.execute<{ id: string }>(
    sql`
    update close_run_tasks
       set owner_id = coalesce(${args.ownerId}, owner_id),
           updated_at = now(), updated_by = ${args.actorId}
     where id = ${args.taskId} and run_id = ${args.runId} and org_id = ${args.orgId}
     returning id`,
    "objects",
  );
  // The row was locked above: zero matched rows is a failure, not success.
  if (updated.length !== 1) throw new CloseError("automation task not found");
  await tx.execute(sql`
    insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
    values (${args.orgId}, ${args.runId}, ${args.taskId}, 'task.assign', ${args.actorId},
            ${JSON.stringify({
              before: { ownerId: before.owner_id },
              after: {
                ownerId: args.ownerId ?? before.owner_id,
              },
            })}::jsonb)`);
}

export async function updateCloseTask(args: {
  orgId: string;
  runId: string;
  taskId: string;
  actorId: string;
  action: CloseTaskAction;
  notes?: string;
}): Promise<void> {
  const fingerprint = await withOrgTransaction(args.orgId, async () => {
    await lockApprovalSubject(args.orgId, "close_task", args.taskId);
    const fingerprint = (
      await db.execute<{ data_fingerprint: string | null }>(
        sql`select data_fingerprint from close_runs
      where id=${args.runId} and org_id=${args.orgId} for share`,
        "objects",
      )
    )[0]?.data_fingerprint;
    if (!fingerprint) throw new CloseError("validate the close run before updating tasks");
    await transitionCloseTaskTx(db, { ...args, fingerprint });
    return fingerprint;
  });
  const ready = await db.execute<{ id: string; key: string }>(
    sql`select id, key from close_run_tasks
    where run_id = ${args.runId} and org_id = ${args.orgId} and status = 'ready'`,
    "objects",
  );
  for (const task of ready) {
    await runCloseAutomations({
      orgId: args.orgId,
      runId: args.runId,
      taskId: task.id,
      trigger: "task_ready",
      eventKey: `task:${task.key}:${fingerprint}`,
      actorId: args.actorId,
    });
  }
}

export async function addCloseEvidence(args: {
  orgId: string;
  runId: string;
  taskId: string;
  actorId: string;
  evidenceType: "file" | "report" | "journal" | "reconciliation" | "link" | "note";
  label: string;
  fileId?: string;
  referenceId?: string;
  referenceUrl?: string;
  snapshot?: Record<string, unknown>;
}): Promise<string> {
  if (!args.label.trim()) throw new CloseError("evidence label is required");
  const snapshot = args.snapshot ?? {};
  const contentHash = createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
  return withOrg(args.orgId, async () =>
    inDbTransaction(async (tx) => {
      await lockApprovalSubject(args.orgId, "close_task", args.taskId);
      await authorizeTask(args.orgId, args.actorId, "close.run");
      const run = (
        await tx.execute<{ status: string }>(
          sql`select status from close_runs where org_id=${args.orgId} and id=${args.runId} for share`,
          "objects",
        )
      )[0];
      if (!run || !["in_progress", "review"].includes(run.status))
        throw new CloseError("The close run is not editable.");
      // Evidence and its append-only audit event are one atomic unit. A
      // committed evidence row without its event cannot be reconciled during
      // close, so any event failure must roll back the evidence insert too.
      const inserted = await tx.execute<{ id: string }>(
        sql`
        insert into close_task_evidence
          (org_id, run_id, task_id, file_id, evidence_type, reference_id, reference_url,
           label, snapshot, content_hash, created_by, updated_by)
        select ${args.orgId}, ${args.runId}, t.id, ${args.fileId ?? null}, ${args.evidenceType},
               ${args.referenceId ?? null}, ${args.referenceUrl ?? null}, ${args.label.trim()},
               ${JSON.stringify(snapshot)}::jsonb, ${contentHash}, ${args.actorId}, ${args.actorId}
          from close_run_tasks t
         where t.id = ${args.taskId} and t.run_id = ${args.runId} and t.org_id = ${args.orgId}
        returning id`,
        "objects",
      );
      if (!inserted[0]) throw new CloseError("close task not found");
      await tx.execute(sql`
        insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
        values (${args.orgId}, ${args.runId}, ${args.taskId}, 'task.evidence_added', ${args.actorId},
                ${JSON.stringify({ evidenceId: inserted[0].id, type: args.evidenceType, label: args.label.trim() })}::jsonb)`);
      return inserted[0].id;
    }),
  );
}

/** Recall restores preparation while the immutable receipt retains every earlier decision. */
export async function withdrawCloseTaskSubmission(input: {
  orgId: string;
  actorId: string;
  subjectId: string;
  reason: string;
}): Promise<void> {
  await withOrgTransaction(input.orgId, async () => {
    await lockApprovalSubject(input.orgId, "close_task", input.subjectId);
    await authorizeTask(input.orgId, input.actorId, "close.run");
    const proof = (
      await db.execute<{ valid: boolean }>(
        sql`select exists(select 1 from flow_submissions s
      where s.org_id=${input.orgId} and s.subject_kind='close_task' and s.subject_id=${input.subjectId} and s.policy->>'kind'='gated'
      and not exists(select 1 from flow_submissions newer where newer.org_id=s.org_id and newer.subject_kind=s.subject_kind and newer.subject_id=s.subject_id and (newer.created_at,newer.id)>(s.created_at,s.id))
      and exists(select 1 from flow_runs r where r.org_id=s.org_id and s.policy->'runIds' ? r.id::text and r.status='cancelled')
      and not exists(select 1 from flow_gates g where g.org_id=s.org_id and g.subject_kind=s.subject_kind and g.subject_id=s.subject_id and g.status in('pending','escalated'))) as valid`,
        "objects",
      )
    )[0];
    if (!proof?.valid)
      throw new CloseError("Recall the current pending task through its native Flow submission.");
    const saved = await db.execute<{ run_id: string }>(
      sql`update close_run_tasks set status='in_progress',updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.subjectId} and status='submitted' returning run_id`,
      "objects",
    );
    if (saved.length !== 1)
      throw new CloseError("The pending close task was not restored to preparation.");
    await db.execute(sql`insert into close_events(org_id,run_id,task_id,event_type,actor_id,payload)
      values(${input.orgId},${saved[0]!.run_id},${input.subjectId},'task.withdraw',${input.actorId},${JSON.stringify({ reason: input.reason })}::jsonb)`);
  });
}
