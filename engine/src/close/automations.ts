/** Durable close automation claims, fenced effects, and scheduler entrypoint. */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { CloseError } from "./period-policy.ts";
import { advancedCloseEnabled } from "./features.ts";

type CloseAutomationTrigger =
  | "run_started"
  | "task_ready"
  | "exception_opened"
  | "deadline_approaching"
  | "run_closed";

type CloseAutomationContext = {
  orgId: string;
  runId: string;
  trigger: CloseAutomationTrigger;
  eventKey: string;
  actorId?: string;
  taskId?: string;
  exceptionId?: string;
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function conditionMatches(expected: unknown, actual: unknown): boolean {
  if (expected == null) return true;
  return Array.isArray(expected)
    ? expected.includes(actual)
    : expected === actual;
}

/** Whole calendar days from one ISO date to another. */
function calendarDaysBetween(fromIso: string, toIso: string): number {
  const [fromYear, fromMonth, fromDay] = fromIso.split("-").map(Number);
  const [toYear, toMonth, toDay] = toIso.split("-").map(Number);
  return Math.round(
    (Date.UTC(toYear!, toMonth! - 1, toDay!) -
      Date.UTC(fromYear!, fromMonth! - 1, fromDay!)) /
      86_400_000,
  );
}

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
async function claimCloseAutomationExecution(
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
async function commitCloseEffectStage(args: {
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
async function finishCloseExecution(args: {
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

/** Execute tenant-authored close automation with a leased, fenced database
 * claim. A failed action is retained for audit and never reported as
 * successful; a crashed attempt is recovered by stale takeover without
 * duplicating the effects it already committed. */
export async function runCloseAutomations(
  context: CloseAutomationContext,
): Promise<{ completed: number; failed: number }> {
  // Tenant-authored deadline/task automations are the Advanced Close layer.
  // Core close (start, attest, lock) still runs; existing rules are preserved.
  if (!(await advancedCloseEnabled(context.orgId))) return { completed: 0, failed: 0 };
  const runResult = (await db.execute<{
    id: string;
    period_id: string;
    book_id: string;
    status: string;
    target_close_date: string | null;
    readiness_score: string | number | null;
    data_fingerprint: string;
    started_by: string | null;
    period_name: string;
    book_name: string;
    task_key: string | null;
    workstream: string | null;
    task_status: string | null;
    exception_severity: string | null;
    exception_code: string | null;
  }>(sql`
    select r.*, p.name as period_name, b.name as book_name,
           t.key as task_key, t.workstream, t.status as task_status,
           x.severity as exception_severity, x.code as exception_code
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
      left join close_run_tasks t on t.id = ${context.taskId ?? null} and t.run_id = r.id and t.org_id = r.org_id
      left join close_exceptions x on x.id = ${context.exceptionId ?? null} and x.run_id = r.id and x.org_id = r.org_id
     where r.id = ${context.runId} and r.org_id = ${context.orgId}
  `));
  const run = runResult.rows[0];
  if (!run) throw new CloseError("close run not found");
  const rules = (await db.execute(sql`
    select * from close_automation_rules
     where org_id = ${context.orgId} and trigger = ${context.trigger} and is_active
     order by created_at, id
  `));
  let completed = 0;
  let failed = 0;
  let automationDate: string | null = null;
  for (const rule of rules.rows) {
    const conditions = (rule.conditions ?? {}) as Record<string, unknown>;
    const withinDays = typeof conditions.withinDays === "number"
      ? conditions.withinDays
      : null;
    let outsideDeadlineWindow = false;
    if (withinDays !== null) {
      automationDate ??= await businessToday(context.orgId);
      outsideDeadlineWindow = calendarDaysBetween(
        automationDate,
        String(run.target_close_date),
      ) > withinDays;
    }
    if (
      !conditionMatches(conditions.runStatus, run.status) ||
      !conditionMatches(conditions.taskKey, run.task_key) ||
      !conditionMatches(conditions.workstream, run.workstream) ||
      !conditionMatches(conditions.taskStatus, run.task_status) ||
      !conditionMatches(conditions.severity, run.exception_severity) ||
      (typeof conditions.minReadiness === "number" &&
        Number(run.readiness_score) < conditions.minReadiness) ||
      (typeof conditions.maxReadiness === "number" &&
        Number(run.readiness_score) > conditions.maxReadiness) ||
      outsideDeadlineWindow
    )
      continue;

    const claim = await claimCloseAutomationExecution(context, String(rule.id));
    if (!claim) continue;
    const executionId = claim.executionId;
    try {
      const config = (rule.config ?? {}) as Record<string, unknown>;
      if (rule.action === "notify") {
        const users = new Map<string, { id: string }>();
        if (stringList(config.userIds).length) {
          const direct =
            (await db.execute<{ id: string }>(sql`select id from users where org_id = ${context.orgId} and is_active
            and id in (${sql.join(
              stringList(config.userIds).map((id) => sql`${id}`),
              sql`, `,
            )})`));
          for (const user of direct.rows) users.set(user.id, user);
        }
        for (const role of stringList(config.roleKeys)) {
          const roleUsers = (await db.execute<{ id: string }>(sql`
            select distinct u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
             where u.org_id = ${context.orgId} and u.is_active and ar.key = ${role}
          `));
          for (const user of roleUsers.rows) users.set(user.id, user);
        }
        if (users.size === 0 && run.started_by)
          users.set(run.started_by, { id: run.started_by });
        if (users.size === 0)
          throw new CloseError(
            "notification automation resolved no recipients",
          );
        for (const user of users.values()) {
          // Each recipient's insert commits WITH its stage checkpoint: a crash
          // mid fan-out resumes with the already-notified skipped instead of
          // double-sending everyone after the crashed recipient.
          await commitCloseEffectStage({
            orgId: context.orgId,
            executionId,
            leaseToken: claim.leaseToken,
            stageKey: `notify:${user.id}`,
            effect: async (tx) => {
              await tx.execute(sql`insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
                values (${context.orgId}, ${user.id}, 'close', ${String(config.title ?? rule.name)},
                        ${String(config.body ?? `${run.period_name} · ${run.book_name}`)}, ${`/close?run=${context.runId}`},
                        ${context.actorId ?? null}, ${context.actorId ?? null})`);
            },
          });
        }
      } else if (rule.action === "assign") {
        if (!context.taskId)
          throw new CloseError("assignment automation requires a task event");
        async function resolveUser(
          userValue: unknown,
          roleValue: unknown,
        ): Promise<string | null> {
          if (typeof userValue === "string") {
            const direct = (await db.execute<{ id: string }>(
              sql`select id from users where id = ${userValue} and org_id = ${context.orgId} and is_active`,
            ));
            if (direct.rows[0]) return direct.rows[0].id;
          }
          if (typeof roleValue === "string") {
            const byRole =
              (await db.execute<{ id: string }>(sql`select distinct u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
              where u.org_id = ${context.orgId} and u.is_active and ar.key = ${roleValue}
              order by u.id limit 1`));
            if (byRole.rows[0]) return byRole.rows[0].id;
          }
          return null;
        }
        const ownerId = await resolveUser(
          config.ownerUserId,
          config.ownerRoleKey,
        );
        const reviewerId = await resolveUser(
          config.reviewerUserId,
          config.reviewerRoleKey,
        );
        if (!ownerId && !reviewerId)
          throw new CloseError(
            "assignment automation resolved no owner or reviewer",
          );
        await db.execute(sql`update close_run_tasks set owner_id = coalesce(${ownerId}, owner_id),
          reviewer_id = coalesce(${reviewerId}, reviewer_id), updated_at = now(), updated_by = ${context.actorId ?? null}
          where id = ${context.taskId} and run_id = ${context.runId} and org_id = ${context.orgId}`);
      } else if (rule.action === "run_check") {
        await refreshCloseRun(context.orgId, context.runId, context.actorId);
      } else if (rule.action === "complete_task") {
        if (!context.taskId)
          throw new CloseError(
            "complete-task automation requires a task event",
          );
        await db.transaction(async (tx) => {
          const task = (await tx.execute<{ evidence_required: boolean; evidence_count: string }>(sql`select evidence_required,
            (select count(*) from close_task_evidence e where e.task_id = t.id and e.org_id = t.org_id) as evidence_count
            from close_run_tasks t where t.id = ${context.taskId} and t.run_id = ${context.runId}
              and t.org_id = ${context.orgId} for update`));
          if (!task.rows[0]) throw new CloseError("automation task not found");
          if (
            task.rows[0].evidence_required &&
            Number(task.rows[0].evidence_count) === 0
          ) {
            throw new CloseError(
              "automatic task requires evidence before completion",
            );
          }
          await tx.execute(sql`update close_run_tasks set status = 'complete', completed_at = now(),
            completed_by = ${context.actorId ?? run.started_by ?? null}, data_fingerprint = ${run.data_fingerprint},
            updated_at = now(), updated_by = ${context.actorId ?? null}
            where id = ${context.taskId} and run_id = ${context.runId} and org_id = ${context.orgId} and status not in ('complete','waived')`);
          await resolveTaskDependenciesTx(tx, context.orgId, context.runId);
        });
        await refreshCloseRun(context.orgId, context.runId, context.actorId);
      } else if (rule.action === "create_task") {
        const key =
          typeof config.key === "string" &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.key)
            ? config.key
            : `automation-${rule.id}`;
        await db.execute(sql`insert into close_run_tasks
          (org_id, run_id, key, title, description, workstream, task_type, completion_mode, gate_type,
           status, sort_order, owner_id, due_on, evidence_required, created_by, updated_by)
          values (${context.orgId}, ${context.runId}, ${key}, ${String(config.title ?? rule.name)},
                  ${typeof config.description === "string" ? config.description : null},
                  ${String(config.workstream ?? "review")}, 'action', 'manual', ${String(config.gateType ?? "none")},
                  'ready', 9000, ${context.actorId ?? run.started_by ?? null}, ${run.target_close_date},
                  ${config.evidenceRequired === true}, ${context.actorId ?? null}, ${context.actorId ?? null})
          on conflict (run_id, key) do nothing`);
      } else if (rule.action === "generate_report") {
        const report = String(config.report ?? "trial-balance");
        const target =
          (await db.execute<{ id: string }>(sql`select id from close_run_tasks where run_id = ${context.runId} and org_id = ${context.orgId}
          and id = coalesce(${context.taskId ?? null}, id) order by case when key = 'publish-package' then 0 else 1 end, sort_order limit 1`));
        if (!target.rows[0])
          throw new CloseError(
            "report automation could not resolve an evidence task",
          );
        const snapshot = {
          report,
          periodId: run.period_id,
          bookId: run.book_id,
          generatedAt: new Date().toISOString(),
          fingerprint: run.data_fingerprint,
        };
        const hash = createHash("sha256")
          .update(canonicalJson(snapshot), "utf8")
          .digest("hex");
        // The snapshot embeds wall-clock time, so re-running after a crash
        // would record different bytes. The stage checkpoint (committed in the
        // same transaction as the insert) makes the resumed attempt skip
        // instead of double-recording evidence.
        await commitCloseEffectStage({
          orgId: context.orgId,
          executionId,
          leaseToken: claim.leaseToken,
          stageKey: "report_evidence",
          effect: async (tx) => {
            await tx.execute(sql`insert into close_task_evidence
            (org_id, run_id, task_id, evidence_type, reference_url, label, snapshot, content_hash, created_by, updated_by)
            values (${context.orgId}, ${context.runId}, ${target.rows[0]!.id}, 'report',
                    ${`/reports/${report}?period=${run.period_id}&book=${run.book_id}`}, ${String(config.label ?? report)},
                    ${JSON.stringify(snapshot)}::jsonb, ${hash}, ${context.actorId ?? null}, ${context.actorId ?? null})`);
          },
        });
      } else if (rule.action === "start_flow") {
        const subjectKind =
          typeof config.subjectKind === "string" ? config.subjectKind : "";
        const subjectId =
          config.subjectId === "$task"
            ? context.taskId
            : config.subjectId === "$run"
              ? context.runId
              : config.subjectId;
        const buttonId =
          typeof config.buttonId === "string" ? config.buttonId : "";
        if (!subjectKind || typeof subjectId !== "string" || !buttonId)
          throw new CloseError(
            "flow automation requires subjectKind, subjectId, and buttonId",
          );
        const { runRecordFlows } = await import("../flows/index.ts");
        // The deterministic occurrence key makes a resumed attempt adopt the
        // SAME flow runs (flows/run.ts insert-or-adopt, as with scheduled
        // flows) instead of re-firing duplicate flows after a crash.
        const result = await runRecordFlows(
          {
            kind: "manual",
            buttonId,
            source: "close_automation",
            occurrenceKey: `${executionId}`,
          },
          subjectKind,
          subjectId,
          {
            orgId: context.orgId,
            userId: context.actorId,
          },
        );
        if (result.runs.length === 0)
          throw new CloseError("flow automation matched no enabled flow");
        if (result.runs.some((item) => item.status === "failed"))
          throw new CloseError("one or more started flows failed");
      } else if (rule.action === "run_allocation") {
        // Allocation runs preview for the close run's period/book and post
        // when the action config asks for it. Each rule's effects commit
        // under a per-rule stage checkpoint, so a crash mid-fan-out resumes
        // with finished rules skipped instead of re-fired.
        const { runAllocationCloseAction } = await import("../allocations/scheduling.ts");
        // Unattended: each rule fires as its published version's publisher.
        await runAllocationCloseAction({
          orgId: context.orgId,
          runId: context.runId,
          config,
          commitStage: (stageKey, effect) =>
            commitCloseEffectStage({
              orgId: context.orgId,
              executionId,
              leaseToken: claim.leaseToken,
              stageKey,
              effect,
            }),
        });
      } else {
        throw new CloseError(
          `unsupported close automation action: ${rule.action}`,
        );
      }
      await finishCloseExecution({
        orgId: context.orgId,
        runId: context.runId,
        taskId: context.taskId,
        actorId: context.actorId,
        executionId,
        leaseToken: claim.leaseToken,
        outcome: "completed",
        payload: { ruleId: String(rule.id), trigger: context.trigger, action: String(rule.action) },
      });
      completed++;
    } catch (error) {
      // Fenced means another attempt took the claim and owns the outcome from
      // here — record nothing, count nothing, do not fight it.
      if (error instanceof CloseAutomationLeaseFencedError) continue;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await finishCloseExecution({
          orgId: context.orgId,
          runId: context.runId,
          taskId: context.taskId,
          actorId: context.actorId,
          executionId,
          leaseToken: claim.leaseToken,
          outcome: "failed",
          error: message,
          payload: { ruleId: String(rule.id), trigger: context.trigger, action: String(rule.action) },
        });
      } catch (completionError) {
        if (!(completionError instanceof CloseAutomationLeaseFencedError))
          throw completionError;
        continue;
      }
      failed++;
    }
  }
  return { completed, failed };
}

/** Scheduler entrypoint. Each run/rule/day is idempotent across processes. */
export async function runDueCloseAutomations(): Promise<number> {
  // Org-spanning discovery crosses an explicit trusted boundary; each rule then
  // executes inside its own tenant. Without this the contextless scheduler tick
  // is denied by default and no deadline automation ever runs.
  const due = await withBypassContext(() =>
    db.execute<{ org_id: string; id: string; target_close_date: string }>(sql`
    select distinct r.org_id, r.id, r.target_close_date::text as target_close_date
      from close_runs r
      join close_automation_rules a on a.org_id = r.org_id and a.trigger = 'deadline_approaching' and a.is_active
      join orgs organization on organization.id = r.org_id and organization.env_kind = 'production'
     where r.status in ('in_progress','review','approved') and r.target_close_date <= current_date + 91
       and coalesce((organization.settings->'features'->>'advancedClose')::boolean, false)
       and coalesce((organization.settings->'features'->>'flows')::boolean, true)
  `));
  for (const run of due.rows) {
    await withOrgContext(run.org_id, async () => {
      const today = await businessToday(run.org_id);
      // Discovery is one UTC day wide so a west-coast org is not missed; the
      // 90-day window is then applied on that org's own business day.
      if (run.target_close_date > addCalendarDays(today, 90)) return;
      await runCloseAutomations({
        orgId: run.org_id,
        runId: run.id,
        trigger: "deadline_approaching",
        eventKey: `deadline:${run.id}:${today}`,
      });
    });
  }
  return due.rows.length;
}
