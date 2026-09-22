import { CloseError } from "./period-policy.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db, withOrg, inDbTransaction, type SqlExecutor } from "../platform/db.ts";
import { resolveTaskDependenciesTx } from "./task-dependencies.ts";
import { runCloseAutomations } from "./run-automation.ts";
export type CloseTaskAction =
  "start" | "submit" | "complete" | "approve" | "request_changes" | "waive";

/** Canonical close-task transition shared by the manual path and close
 * automation. Every guard (blocked, owner, reviewer, evidence, segregation of
 * duties) and every write (status, signoff, task audit event, dependency
 * resolution) lives here, so automation cannot complete work the manual path
 * refuses. This deliberately performs no automation fan-out: callers that
 * already run inside automation (or that fan out themselves) must not
 * re-enter runCloseAutomations. */
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
  },
): Promise<void> {
    const taskRes = (await tx.execute(sql`
      select t.*, (select count(*) from close_task_evidence e where e.task_id = t.id) as evidence_count
        from close_run_tasks t where t.id = ${args.taskId} and t.run_id = ${args.runId} and t.org_id = ${args.orgId}
        for update`));
    const task = taskRes.rows[0];
    if (!task) throw new CloseError("close task not found");
    if (task.status === "blocked")
      throw new CloseError("task dependencies are not complete");
    if (
      ["start", "submit", "complete"].includes(args.action) &&
      task.owner_id &&
      task.owner_id !== args.actorId
    ) {
      throw new CloseError("only the assigned owner can prepare this task");
    }
    if (
      ["approve", "request_changes"].includes(args.action) &&
      task.reviewer_id &&
      task.reviewer_id !== args.actorId
    ) {
      throw new CloseError("only the assigned reviewer can decide this task");
    }
    if (
      ["complete", "submit"].includes(args.action) &&
      task.evidence_required &&
      Number(task.evidence_count) === 0
    ) {
      throw new CloseError(
        "required evidence must be attached before this task can be completed",
      );
    }
    // A reviewer-gated task can only leave preparation through submit, which
    // routes to independent review. Completing it directly would silently
    // absorb the review step, so refuse by name instead: the owner submits
    // the task for review, and the assigned reviewer approves it.
    if (args.action === "complete" && task.reviewer_id) {
      throw new CloseError(
        "this task requires independent review and cannot be completed directly; submit it for review instead",
      );
    }

    let status: string;
    if (args.action === "start") status = "in_progress";
    else if (args.action === "submit")
      status = task.reviewer_id ? "submitted" : "complete";
    else if (args.action === "complete") status = "complete";
    else if (args.action === "approve") {
      if (
        task.completed_by === args.actorId ||
        (!task.completed_by && task.owner_id === args.actorId)
      ) {
        throw new CloseError("preparer and reviewer must be different people");
      }
      status = "complete";
    } else if (args.action === "request_changes") status = "changes_requested";
    else status = "waived";

    await tx.execute(sql`
      update close_run_tasks set
        status = ${status}, notes = coalesce(${args.notes ?? null}, notes),
        completed_at = case when ${status} in ('complete','waived') then now() else completed_at end,
        completed_by = case when ${status} in ('complete','waived') then coalesce(completed_by, ${args.actorId}) else completed_by end,
        reviewed_at = case when ${args.action} = 'approve' then now() else reviewed_at end,
        reviewed_by = case when ${args.action} = 'approve' then ${args.actorId} else reviewed_by end,
        data_fingerprint = case when ${status} in ('complete','submitted','waived') then ${args.fingerprint} else data_fingerprint end,
        updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.taskId} and org_id = ${args.orgId}`);
    if (["approve", "waive"].includes(args.action)) {
      await tx.execute(sql`
        insert into close_signoffs
          (org_id, run_id, task_id, signoff_type, decision, comment, data_fingerprint, signed_by)
        values (${args.orgId}, ${args.runId}, ${args.taskId},
                ${args.action === "approve" ? "review" : "waive"},
                ${args.action === "approve" ? "approved" : "waived"},
                ${args.notes ?? null}, ${args.fingerprint}, ${args.actorId})`);
    }
    await tx.execute(sql`
      insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, ${args.taskId}, ${`task.${args.action}`}, ${args.actorId},
              ${JSON.stringify({ status, notes: args.notes ?? null })}::jsonb)`);
    await resolveTaskDependenciesTx(tx, args.orgId, args.runId);
}

export async function updateCloseTask(args: {
  orgId: string;
  runId: string;
  taskId: string;
  actorId: string;
  action: CloseTaskAction;
  notes?: string;
}): Promise<void> {
  const fingerprintRes = (await db.execute<{ data_fingerprint: string | null }>(sql`
    select data_fingerprint from close_runs where id = ${args.runId} and org_id = ${args.orgId}`));
  const fingerprint = fingerprintRes.rows[0]?.data_fingerprint;
  if (!fingerprint)
    throw new CloseError("validate the close run before updating tasks");

  await db.transaction(async (tx) => {
    await transitionCloseTaskTx(tx, { ...args, fingerprint });
  });
  const ready = (await db.execute<{ id: string; key: string }>(sql`select id, key from close_run_tasks
    where run_id = ${args.runId} and org_id = ${args.orgId} and status = 'ready'`));
  for (const task of ready.rows) {
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
  evidenceType:
    "file" | "report" | "journal" | "reconciliation" | "link" | "note";
  label: string;
  fileId?: string;
  referenceId?: string;
  referenceUrl?: string;
  snapshot?: Record<string, unknown>;
}): Promise<string> {
  if (!args.label.trim()) throw new CloseError("evidence label is required");
  const snapshot = args.snapshot ?? {};
  const contentHash = createHash("sha256")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex");
  return withOrg(args.orgId, async () =>
    inDbTransaction(async (tx) => {
      // Evidence and its append-only audit event are one atomic unit. A
      // committed evidence row without its event cannot be reconciled during
      // close, so any event failure must roll back the evidence insert too.
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into close_task_evidence
          (org_id, run_id, task_id, file_id, evidence_type, reference_id, reference_url,
           label, snapshot, content_hash, created_by, updated_by)
        select ${args.orgId}, ${args.runId}, t.id, ${args.fileId ?? null}, ${args.evidenceType},
               ${args.referenceId ?? null}, ${args.referenceUrl ?? null}, ${args.label.trim()},
               ${JSON.stringify(snapshot)}::jsonb, ${contentHash}, ${args.actorId}, ${args.actorId}
          from close_run_tasks t
         where t.id = ${args.taskId} and t.run_id = ${args.runId} and t.org_id = ${args.orgId}
        returning id`));
      if (!inserted.rows[0]) throw new CloseError("close task not found");
      await tx.execute(sql`
        insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
        values (${args.orgId}, ${args.runId}, ${args.taskId}, 'task.evidence_added', ${args.actorId},
                ${JSON.stringify({ evidenceId: inserted.rows[0].id, type: args.evidenceType, label: args.label.trim() })}::jsonb)`);
      return inserted.rows[0].id;
    }),
  );
}
