/** Durable close automation claims and fenced effect execution. */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";

type CloseAutomationTrigger =
  | "run_started"
  | "task_ready"
  | "exception_opened"
  | "deadline_approaching"
  | "run_closed";

export type CloseAutomationContext = {
  orgId: string;
  runId: string;
  trigger: CloseAutomationTrigger;
  eventKey: string;
  actorId?: string;
  taskId?: string;
  exceptionId?: string;
};

/**
 * A silent claim is only safe while its holder lives. Running claims carry a
 * random fencing lease (migration 0056): a crashed or hung worker's running
 * row no longer blocks the event forever, because the next firing reclaims it
 * by compare-and-set over the stored token once the lock outlives this window.
 * The window is generous — long enough for a deep flow dispatch — but bounded,
 * so one crash freezes partial effects for minutes instead of forever.
 */
export const CLOSE_AUTOMATION_STALE_CLAIM_MS = 15 * 60_000;

/** Raised when the claim that backed an attempt lost its lease to a takeover.
 * Aborted effect work rolls back with it; the replacement attempt owns the
 * outcome from there, so a fenced loser records nothing. */
export class CloseAutomationLeaseFencedError extends Error {
  constructor(executionId: string) {
    super(`close automation execution ${executionId} lost its lease and was fenced`);
    this.name = "CloseAutomationLeaseFencedError";
  }
}

type CloseAutomationClaim = {
  executionId: string;
  leaseToken: string;
  stages: Record<string, unknown>;
};

async function readCloseExecutionStages(
  orgId: string,
  executionId: string,
): Promise<Record<string, unknown>> {
  const result = (await db.execute<{ stages: Record<string, unknown> }>(sql`
    select stages from close_automation_executions
     where id = ${executionId} and org_id = ${orgId}
  `));
  return (result.rows[0]?.stages ?? {}) as Record<string, unknown>;
}

/**
 * Claim the (rule, event) execution row. Fresh events insert a running row
 * with their own fencing token; an existing terminal row keeps its audit
 * verdict; a live lease belongs to another scheduler and is respected; a stale
 * (or pre-lease legacy) running claim is reclaimed exactly once via CAS over
 * its stored token. Returns null when this firing must not proceed.
 */
export async function claimCloseAutomationExecution(
  context: CloseAutomationContext,
  ruleId: string,
): Promise<CloseAutomationClaim | null> {
  const inserted = (await db.execute<{ id: string; lease_token: string }>(sql`
    insert into close_automation_executions
      (org_id, rule_id, run_id, task_id, trigger, event_key, status,
       attempt_count, lease_token, locked_at, created_by, updated_by)
    values (${context.orgId}, ${ruleId}, ${context.runId}, ${context.taskId ?? null}, ${context.trigger},
            ${context.eventKey}, 'running', 0, gen_random_uuid(), now(),
            ${context.actorId ?? null}, ${context.actorId ?? null})
    on conflict (rule_id, event_key) do nothing returning id, lease_token
  `));
  let claimed = inserted.rows[0];
  if (!claimed) {
    const existing = (await db.execute<{
      id: string;
      status: "running" | "completed" | "failed";
      lease_token: string | null;
      reclaimable: boolean;
    }>(sql`
      select id, status, lease_token,
             (status = 'running'
              and (locked_at is null
                   or locked_at < now() - (${CLOSE_AUTOMATION_STALE_CLAIM_MS} * interval '1 millisecond'))) as reclaimable
        from close_automation_executions
       where org_id = ${context.orgId} and rule_id = ${ruleId}
         and event_key = ${context.eventKey}
    `)).rows[0];
    // Terminal rows keep their audit verdict; a live claim means another
    // scheduler is mid-run right now. Only a stale lock is reclaimable (the
    // comparison lives in SQL: executor timestamps arrive as raw strings).
    if (!existing || !existing.reclaimable) return null;
    // Compare-and-set over the crashed claim's stored token: concurrent
    // recoverers race, exactly one wins the row, every other loser skips.
    const takeover = (await db.execute<{ id: string; lease_token: string }>(sql`
      update close_automation_executions
         set attempt_count = attempt_count + 1,
             lease_token = gen_random_uuid(),
             locked_at = now(),
             updated_at = now()
       where id = ${existing.id} and org_id = ${context.orgId} and status = 'running'
         and lease_token is not distinct from ${existing.lease_token}
       returning id, lease_token
    `)).rows[0];
    if (!takeover) return null;
    claimed = takeover;
  }
  return {
    executionId: claimed.id,
    leaseToken: claimed.lease_token,
    // A recovered claim inherits whatever stage checkpoints earlier attempts
    // already committed, so its effects finish instead of restarting.
    stages: await readCloseExecutionStages(context.orgId, claimed.id),
  };
}

/**
 * Commit one non-idempotent unit effect together with its stage checkpoint in
 * a single transaction, fenced on the active lease token. If the fence fails,
 * the whole transaction (effect included) rolls back so a takeover cannot be
 * double-applied; resuming callers see the checkpoint and skip what committed.
 */
export async function commitCloseEffectStage(args: {
  orgId: string;
  executionId: string;
  leaseToken: string;
  stageKey: string;
  effect: (tx: SqlExecutor) => Promise<void>;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gate = (await tx.execute<{ done: boolean }>(sql`
      select (stages ->> ${args.stageKey}) is not null as done
        from close_automation_executions
       where id = ${args.executionId} and org_id = ${args.orgId} and status = 'running'
         and lease_token = ${args.leaseToken}
    `)).rows[0];
    if (!gate) throw new CloseAutomationLeaseFencedError(args.executionId);
    if (gate.done) return false;
    await args.effect(tx);
    const stamped = await tx.execute(sql`
      update close_automation_executions
         set stages = stages || ${JSON.stringify({ [args.stageKey]: true })}::jsonb,
             updated_at = now()
       where id = ${args.executionId} and org_id = ${args.orgId} and status = 'running'
         and lease_token = ${args.leaseToken}
    `);
    if ((stamped.rowCount ?? 0) !== 1)
      throw new CloseAutomationLeaseFencedError(args.executionId);
    return true;
  });
}

/** Terminal transition plus its audit event commit atomically, fenced on the
 * active token — a crash between them cannot orphan half-recorded outcomes. */
export async function finishCloseExecution(args: {
  orgId: string;
  runId: string;
  taskId?: string | null;
  actorId?: string | null;
  executionId: string;
  leaseToken: string;
  outcome: "completed" | "failed";
  error?: string;
  payload: { ruleId: string; trigger: string; action: string };
}): Promise<void> {
  await db.transaction(async (tx) => {
    const marked = await tx.execute(sql`
      update close_automation_executions
         set status = ${args.outcome},
             error = ${args.outcome === "failed" ? args.error : null},
             executed_at = now(), updated_at = now(), updated_by = ${args.actorId ?? null},
             lease_token = null, locked_at = null
       where id = ${args.executionId} and org_id = ${args.orgId} and status = 'running'
         and lease_token = ${args.leaseToken}
    `);
    if ((marked.rowCount ?? 0) !== 1)
      throw new CloseAutomationLeaseFencedError(args.executionId);
    await tx.execute(sql`insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, ${args.taskId ?? null},
              ${args.outcome === "completed" ? "automation.completed" : "automation.failed"},
              ${args.actorId ?? null},
              ${JSON.stringify({ ...args.payload, executionId: args.executionId, ...(args.error && args.outcome === "failed" ? { error: args.error } : {}) })}::jsonb)`);
  });
}
