import { lockApprovalSubject, cancelNativeApprovals } from "../platform/approval-routing.ts";
import { canonicalPeriodLabelSql, CloseError } from "../periods/period-policy.ts";
import { advancedCloseEnabled } from "./features.ts";
import {
  claimCloseAutomationExecution,
  commitCloseEffectStage,
  finishCloseExecution,
  CloseAutomationLeaseFencedError,
  type CloseAutomationContext,
} from "./automations.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { addCalendarDays, businessToday, calendarDaysBetween } from "../platform/business-date.ts";
import { db, withOrgTransaction, withBypassContext, withOrgContext } from "../platform/db.ts";
import { readinessChecks } from "./readiness.ts";

import {
  fingerprintChangeBuckets,
  periodFingerprintWithEvidence,
  type PeriodFingerprintEvidence,
} from "./period-fingerprint.ts";
import { snapshotCommerceCloseEvidence } from "./commerce-close.ts";
import { resolveTaskDependenciesTx } from "./task-dependencies.ts";
export async function refreshCloseRun(
  orgId: string,
  runId: string,
  actorId?: string,
): Promise<{
  readinessScore: number;
  fingerprint: string;
  invalidated: number;
  openExceptions: number;
}> {
  const runRes = await db.execute<{
    period_id: string;
    book_id: string;
    data_fingerprint: string | null;
    scope: { subsidiaryIds?: string[] };
    system_blueprint: boolean;
  }>(
    sql`
    select r.period_id, r.book_id, r.data_fingerprint, r.scope,
           b.name='close.defaultData.blueprint.name' as system_blueprint
      from close_runs r join close_blueprints b on b.id=r.blueprint_id and b.org_id=r.org_id
      where r.id = ${runId} and r.org_id = ${orgId}`,
    "objects",
  );
  const run = runRes[0];
  if (!run) throw new CloseError("close run not found");
  const { fingerprint, evidence } = await periodFingerprintWithEvidence(
    orgId,
    run.period_id,
    run.book_id,
    run.scope?.subsidiaryIds ?? [],
    !run.system_blueprint || !run.scope?.subsidiaryIds?.length,
  );
  const dataChanged = Boolean(run.data_fingerprint && run.data_fingerprint !== fingerprint);
  // Name what moved since the fingerprint the completed tasks were stamped
  // with: the last validation snapshot carrying that fingerprint is the
  // baseline, so the reason says what actually changed rather than that
  // something did. Without a baseline (first validation after this ships)
  // the invalidation stays generic.
  let changedBuckets: string[] = [];
  if (dataChanged) {
    const baseline =
      (
        await db.execute<{ evidence: PeriodFingerprintEvidence | null }>(
          sql`
      select payload->'evidence' as evidence from close_events
       where org_id = ${orgId} and run_id = ${runId} and event_type = 'run.validated'
         and payload->>'fingerprint' = ${run.data_fingerprint}
       order by at desc limit 1`,
          "objects",
        )
      )[0]?.evidence ?? null;
    changedBuckets = fingerprintChangeBuckets(baseline, evidence);
  }
  const availableTasks = await db.execute<{ key: string }>(
    sql`
    select key from close_run_tasks where run_id=${runId} and org_id=${orgId}
  `,
    "objects",
  );
  const availableTaskKeys = new Set(availableTasks.map((task) => task.key));
  const groupNotApplicable = run.system_blueprint && !!run.scope?.subsidiaryIds?.length;
  const checks = (await readinessChecks(orgId, runId)).filter(
    (check) =>
      availableTaskKeys.has(check.taskKey) &&
      !(groupNotApplicable && check.taskKey === "intercompany-balanced"),
  );
  const hardChecks = checks.filter((check) => check.severity !== "warning");
  const readinessScore = Math.round(
    (hardChecks.filter((check) => check.count === 0).length / Math.max(hardChecks.length, 1)) * 100,
  );

  const outcome = await withOrgTransaction(orgId, async () => {
    const tx = db;
    await lockApprovalSubject(orgId, "close_run", runId);
    const tasks = await tx.execute<{ id: string }>(
      sql`select id from close_run_tasks where org_id=${orgId} and run_id=${runId} order by id`,
      "objects",
    );
    for (const task of tasks) await lockApprovalSubject(orgId, "close_task", task.id);
    const current = (
      await tx.execute<{ data_fingerprint: string | null }>(
        sql`select data_fingerprint from close_runs
      where org_id=${orgId} and id=${runId} for update`,
        "objects",
      )
    )[0];
    if (!current || current.data_fingerprint !== run.data_fingerprint)
      throw new CloseError("The close changed during validation; revalidate its current evidence.");
    const stale = await tx.execute<{ id: string }>(
      sql`select id from close_run_tasks where org_id=${orgId} and run_id=${runId}
      and id in(select jsonb_array_elements_text(${JSON.stringify(tasks.map((task) => task.id))}::jsonb)::uuid)
      and status in('complete','submitted','waived') and data_fingerprint is distinct from ${fingerprint}`,
      "objects",
    );
    let invalidated = 0;
    if (dataChanged || stale.length > 0) {
      await cancelNativeApprovals({
        orgId,
        subjectKind: "close_run",
        subjectId: runId,
        actorId: actorId ?? null,
      });
      for (const task of stale)
        await cancelNativeApprovals({
          orgId,
          subjectKind: "close_task",
          subjectId: task.id,
          actorId: actorId ?? null,
        });
      // The invalidation reason rides on the task row so the heading can say
      // re-review is needed because <what> changed. Computed tasks get a
      // fresh result below; manual attestations keep this until re-decided,
      // and the card only renders it while the status is invalidated.
      const changed = await tx.execute<{ id: string }>(
        sql`
        update close_run_tasks
           set status = 'invalidated', completed_at = null, completed_by = null,
               reviewed_at = null, reviewed_by = null, updated_at = now(), updated_by = ${actorId ?? null}
               ${
                 changedBuckets.length > 0
                   ? sql`, result = coalesce(result, '{}'::jsonb) || ${JSON.stringify({ invalidatedBecause: changedBuckets })}::jsonb`
                   : sql``
               }
         where run_id = ${runId} and org_id = ${orgId}
           and id in(select jsonb_array_elements_text(${JSON.stringify(stale.map((task) => task.id))}::jsonb)::uuid)
           and status in ('complete','submitted','waived') and data_fingerprint is distinct from ${fingerprint}
         returning id`,
        "objects",
      );
      invalidated = changed.length;
      await tx.execute(sql`
        insert into close_events (org_id, run_id, event_type, actor_id, payload)
        values (${orgId}, ${runId}, 'run.data_changed', ${actorId ?? null},
                ${JSON.stringify({ invalidated, changedBuckets })}::jsonb)`);
    }
    // Snapshot every validation with the evidence behind its fingerprint:
    // the next change diffs against the snapshot carrying the stamped
    // fingerprint, which is what makes the invalidation reason specific.
    await tx.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.validated', ${actorId ?? null},
              ${JSON.stringify({ fingerprint, evidence })}::jsonb)`);

    for (const check of checks) {
      const task = await tx.execute<{ id: string }>(
        sql`
        select id from close_run_tasks where run_id = ${runId} and org_id = ${orgId} and key = ${check.taskKey}`,
        "objects",
      );
      const taskId = task[0]?.id ?? null;
      if (check.count > 0) {
        await tx.execute(sql`
          insert into close_exceptions
            (org_id, run_id, task_id, code, category, severity, status, title, message,
             source, details, created_by, updated_by)
          values (${orgId}, ${runId}, ${taskId}, ${check.code}, ${check.category}, ${check.severity},
                  'open', ${check.title}, ${check.message}, 'system',
                  ${JSON.stringify({ count: check.count, ...(check.details ?? {}) })}::jsonb,
                  ${actorId ?? null}, ${actorId ?? null})
          on conflict (run_id, code) do update set
            task_id = excluded.task_id, severity = excluded.severity, status = 'open',
            title = excluded.title, message = excluded.message, details = excluded.details,
            resolved_at = null, resolved_by = null, resolution = null, updated_at = now()
          where close_exceptions.org_id = ${orgId}`);
      } else {
        await tx.execute(sql`
          update close_exceptions set status = 'resolved', resolved_at = now(),
                 resolution = 'close.diagnostics.autoResolved', updated_at = now()
           where run_id = ${runId} and org_id = ${orgId} and code = ${check.code} and status = 'open'`);
      }
    }
    // A computed task is complete only when EVERY check that feeds it is
    // clean. Several checks share a task (drafts-open and
    // posting-period-missing both feed drafts-cleared): folding them one by
    // one let the last clean check mark the task complete while an earlier
    // check still had an open critical exception — a false-green task beside
    // a red exception.
    const byTask = new Map<string, { count: number; checks: Record<string, number> }>();
    for (const check of checks) {
      const agg = byTask.get(check.taskKey) ?? { count: 0, checks: {} };
      agg.count += check.count;
      agg.checks[check.code] = check.count;
      byTask.set(check.taskKey, agg);
    }
    for (const [taskKey, agg] of byTask) {
      const clean = agg.count === 0;
      await tx.execute(sql`
        update close_run_tasks
           set status = ${clean ? "complete" : "ready"},
               completed_at = ${clean ? sql`now()` : sql`null`},
               completed_by = ${clean ? (actorId ?? null) : null},
               data_fingerprint = ${fingerprint},
               result = ${JSON.stringify({ count: agg.count, checks: agg.checks, checkedAt: new Date().toISOString() })}::jsonb,
               updated_at = now(), updated_by = ${actorId ?? null}
         where run_id = ${runId} and org_id = ${orgId} and key = ${taskKey} and completion_mode = 'computed'`);
    }

    await tx.execute(sql`
      update close_runs set readiness_score = ${readinessScore}, data_fingerprint = ${fingerprint},
             status = case when ${dataChanged || invalidated > 0} and status in ('review','approved') then 'in_progress' else status end,
             approved_at = case when ${dataChanged || invalidated > 0} and status in ('review','approved') then null else approved_at end,
             approved_by = case when ${dataChanged || invalidated > 0} and status in ('review','approved') then null else approved_by end,
             current_stage = case
               when status in ('closed','published') then 'publish'
               when status = 'approved' and not ${dataChanged || invalidated > 0} then 'lock'
               when exists (select 1 from close_exceptions x where x.run_id = ${runId}
                 and x.org_id = ${orgId} and x.status = 'open' and x.severity in ('error','critical')) then 'readiness'
               when exists (select 1 from close_run_tasks t where t.run_id = ${runId}
                 and t.org_id = ${orgId}
                 and t.workstream not in ('review','publish') and t.key not like 'lock-%'
                 and t.status not in ('complete','waived')) then 'execute'
               else 'review'
             end,
             last_validated_at = now(), updated_at = now(), updated_by = ${actorId ?? null}
       where id = ${runId} and org_id = ${orgId}`);
    // Dependency state must compare preparation against the newly validated fingerprint.
    await resolveTaskDependenciesTx(tx, orgId, runId);
    const open = await tx.execute<{ count: string }>(
      sql`
      select count(*) as count from close_exceptions where run_id = ${runId} and org_id = ${orgId} and status = 'open'`,
      "objects",
    );
    return {
      readinessScore,
      fingerprint,
      invalidated,
      openExceptions: Number(open[0]?.count ?? 0),
    };
  });
  // A clean commerce proof freezes onto the task as report evidence, one
  // snapshot per data fingerprint. Post-commit in its own transaction: a
  // snapshot failure surfaces without undoing the committed refresh, and a
  // retry attaches the same fingerprint exactly once.
  await snapshotCommerceCloseEvidence(orgId, runId, actorId);
  const automationSubjects = await db.execute<{
    task_id: string;
    task_key: string;
    status: string;
    exception_id: string | null;
    exception_code: string | null;
  }>(
    sql`
    select t.id as task_id, t.key as task_key, t.status,
           x.id as exception_id, x.code as exception_code
      from close_run_tasks t
      left join close_exceptions x on x.task_id = t.id and x.run_id = t.run_id and x.org_id = t.org_id and x.status = 'open'
     where t.run_id = ${runId} and t.org_id = ${orgId} and (t.status = 'ready' or x.id is not null)
  `,
    "objects",
  );
  for (const subject of automationSubjects) {
    if (subject.status === "ready") {
      await runCloseAutomations({
        orgId,
        runId,
        taskId: subject.task_id,
        trigger: "task_ready",
        eventKey: `task:${subject.task_key}:${fingerprint}`,
        actorId,
      });
    }
    if (subject.exception_id && subject.exception_code) {
      await runCloseAutomations({
        orgId,
        runId,
        taskId: subject.task_id,
        exceptionId: subject.exception_id,
        trigger: "exception_opened",
        eventKey: `exception:${subject.exception_code}:${fingerprint}`,
        actorId,
      });
    }
  }
  return outcome;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function conditionMatches(expected: unknown, actual: unknown): boolean {
  if (expected == null) return true;
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

/**
 * Whether a close target date falls outside a rule's deadline window, in
 * whole calendar days. The single civil-date definition lives in
 * platform/business-date.ts: Date.UTC remaps years 0-99 onto 1900-1999, which
 * misclassified deadline windows spanning the 0099/0100 boundary. Pure —
 * unit-tested directly.
 */
export function outsideDeadlineWindow(
  automationDateIso: string,
  targetCloseDateIso: string,
  withinDays: number,
): boolean {
  return calendarDaysBetween(automationDateIso, targetCloseDateIso) > withinDays;
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
  const runResult = await db.execute<{
    id: string;
    period_id: string;
    book_id: string;
    status: string;
    target_close_date: string | null;
    readiness_score: string | number | null;
    data_fingerprint: string;
    started_by: string | null;
    period_label: string;
    book_name: string;
    task_key: string | null;
    workstream: string | null;
    task_status: string | null;
    exception_severity: string | null;
    exception_code: string | null;
  }>(
    sql`
    select r.*, ${canonicalPeriodLabelSql()} as period_label, b.name as book_name,
           t.key as task_key, t.workstream, t.status as task_status,
           x.severity as exception_severity, x.code as exception_code
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
      left join close_run_tasks t on t.id = ${context.taskId ?? null} and t.run_id = r.id and t.org_id = r.org_id
      left join close_exceptions x on x.id = ${context.exceptionId ?? null} and x.run_id = r.id and x.org_id = r.org_id
     where r.id = ${context.runId} and r.org_id = ${context.orgId}
  `,
    "objects",
  );
  const run = runResult[0];
  if (!run) throw new CloseError("close run not found");
  const rules = await db.execute(
    sql`
    select * from close_automation_rules
     where org_id = ${context.orgId} and trigger = ${context.trigger} and is_active
     order by created_at, id
  `,
    "objects",
  );
  let completed = 0;
  let failed = 0;
  let automationDate: string | null = null;
  for (const rule of rules) {
    const conditions = (rule.conditions ?? {}) as Record<string, unknown>;
    const withinDays = typeof conditions.withinDays === "number" ? conditions.withinDays : null;
    let outsideWindow = false;
    if (withinDays !== null) {
      automationDate ??= await businessToday(context.orgId);
      outsideWindow = outsideDeadlineWindow(
        automationDate,
        String(run.target_close_date),
        withinDays,
      );
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
      outsideWindow
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
          const direct = await db.execute<{ id: string }>(
            sql`select id from users where org_id = ${context.orgId} and is_active
            and id in (${sql.join(
              stringList(config.userIds).map((id) => sql`${id}`),
              sql`, `,
            )})`,
            "objects",
          );
          for (const user of direct) users.set(user.id, user);
        }
        for (const role of stringList(config.roleKeys)) {
          const roleUsers = await db.execute<{ id: string }>(
            sql`
            select distinct u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
             where u.org_id = ${context.orgId} and u.is_active and ar.key = ${role}
          `,
            "objects",
          );
          for (const user of roleUsers) users.set(user.id, user);
        }
        if (users.size === 0 && run.started_by) users.set(run.started_by, { id: run.started_by });
        if (users.size === 0)
          throw new CloseError("notification automation resolved no recipients");
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
                        ${String(config.body ?? `${run.period_label} · ${run.book_name}`)}, ${`/close?run=${context.runId}`},
                        ${context.actorId ?? null}, ${context.actorId ?? null})`);
            },
          });
        }
      } else if (rule.action === "assign") {
        if (!context.taskId) throw new CloseError("assignment automation requires a task event");
        // Capture while narrowed: property narrowing does not survive the
        // awaits below, and an undefined task must never reach the update.
        const assignTaskId: string = context.taskId;
        async function resolveUser(userValue: unknown, roleValue: unknown): Promise<string | null> {
          if (typeof userValue === "string") {
            const direct = await db.execute<{ id: string }>(
              sql`select id from users where id = ${userValue} and org_id = ${context.orgId} and is_active`,
              "objects",
            );
            if (direct[0]) return direct[0].id;
          }
          if (typeof roleValue === "string") {
            const byRole = await db.execute<{ id: string }>(
              sql`select distinct u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
              where u.org_id = ${context.orgId} and u.is_active and ar.key = ${roleValue}
              order by u.id limit 1`,
              "objects",
            );
            if (byRole[0]) return byRole[0].id;
          }
          return null;
        }
        const ownerId = await resolveUser(config.ownerUserId, config.ownerRoleKey);
        if (config.reviewerUserId !== undefined || config.reviewerRoleKey !== undefined)
          throw new CloseError(
            "Configure close task approvals in Flows; assignment automations only choose the preparation owner.",
          );
        if (!ownerId) throw new CloseError("assignment automation resolved no owner");
        // Route through the canonical assignment so automation writes the
        // same task audit event as every other task write. A vanished task
        // throws by name and lands in the automation result as failed —
        // never a silent success on zero matched rows.
        const { assignCloseTaskTx } = await import("./tasks.ts");
        await withOrgTransaction(context.orgId, async () => {
          const tx = db;
          await assignCloseTaskTx(tx, {
            orgId: context.orgId,
            runId: context.runId,
            taskId: assignTaskId,
            ownerId,
            actorId: context.actorId ?? null,
          });
        });
      } else if (rule.action === "run_check") {
        await refreshCloseRun(context.orgId, context.runId, context.actorId);
      } else if (rule.action === "complete_task") {
        const taskId = context.taskId;
        if (!taskId) throw new CloseError("complete-task automation requires a task event");
        // The native task command applies the same tenant Flow policy to
        // manual and automated preparation, without recursive automation fan-out.
        const { transitionCloseTaskTx } = await import("./tasks.ts");
        await withOrgTransaction(context.orgId, async () => {
          const tx = db;
          const task = await tx.execute<{ status: string; completion_mode: string }>(
            sql`
            select status, completion_mode from close_run_tasks
             where id = ${taskId} and run_id = ${context.runId}
               and org_id = ${context.orgId}`,
            "objects",
          );
          if (!task[0]) throw new CloseError("automation task not found");
          if (task[0].status === "complete" || task[0].status === "waived") return;
          if (task[0].completion_mode === "computed") {
            throw new CloseError(
              "automatic completion is only for manual tasks; computed tasks complete when the close run is validated — run a run_check automation or validate the run",
            );
          }
          const fingerprintRes = await tx.execute<{ data_fingerprint: string | null }>(
            sql`
            select data_fingerprint from close_runs where id = ${context.runId} and org_id = ${context.orgId}`,
            "objects",
          );
          const fingerprint = fingerprintRes[0]?.data_fingerprint;
          if (!fingerprint) throw new CloseError("validate the close run before updating tasks");
          await transitionCloseTaskTx(tx, {
            orgId: context.orgId,
            runId: context.runId,
            taskId,
            actorId: context.actorId ?? run.started_by ?? null,
            action: "complete",
            fingerprint,
          });
        });
        await refreshCloseRun(context.orgId, context.runId, context.actorId);
      } else if (rule.action === "create_task") {
        const key =
          typeof config.key === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.key)
            ? config.key
            : `automation-${rule.id}`;
        const title = String(config.title ?? rule.name);
        const description = typeof config.description === "string" ? config.description : null;
        const workstream = String(config.workstream ?? "review");
        const gateType = String(config.gateType ?? "none");
        const evidenceRequired = config.evidenceRequired === true;
        // Invariant: a zero-row insert re-reads the surviving row. Only a
        // row matching everything this insert promises — the five authored
        // fields plus the fixed action/manual semantics — is adopted as an
        // ensure-task replay. Anything else refuses by name below; the
        // survivor is never updated here. `do nothing` is justified solely
        // by that identical-replay case.
        const inserted = await db.execute<{ id: string }>(
          sql`insert into close_run_tasks
          (org_id, run_id, key, title, description, workstream, task_type, completion_mode, gate_type,
           status, sort_order, owner_id, due_on, evidence_required, created_by, updated_by)
          values (${context.orgId}, ${context.runId}, ${key}, ${title},
                  ${description},
                  ${workstream}, 'action', 'manual', ${gateType},
                  'ready', 9000, ${context.actorId ?? run.started_by ?? null}, ${run.target_close_date},
                  ${evidenceRequired}, ${context.actorId ?? null}, ${context.actorId ?? null})
          -- The existing task is accepted below only when every requested task attribute is identical.
          on conflict (run_id, key) do nothing returning id`,
          "objects",
        );
        if (inserted.length === 0) {
          const existing = await db.execute<{
            title: string;
            description: string | null;
            workstream: string;
            task_type: string;
            completion_mode: string;
            gate_type: string;
            evidence_required: boolean;
          }>(
            sql`select title, description, workstream, task_type, completion_mode, gate_type, evidence_required
              from close_run_tasks
             where run_id = ${context.runId} and org_id = ${context.orgId} and key = ${key}`,
            "objects",
          );
          const row = existing[0];
          const identical =
            !!row &&
            row.title === title &&
            (row.description ?? null) === description &&
            row.workstream === workstream &&
            row.task_type === "action" &&
            row.completion_mode === "manual" &&
            row.gate_type === gateType &&
            row.evidence_required === evidenceRequired;
          if (!identical) {
            throw new CloseError(
              `close automation rule "${String(rule.name)}" cannot create task key "${key}": ` +
                `a task with that key already exists on this close run with different configuration. ` +
                `Edit the automation rule to use a unique config.key, or reuse the existing task instead of creating a duplicate.`,
            );
          }
        }
      } else if (rule.action === "generate_report") {
        const report = String(config.report ?? "trial-balance");
        const target = await db.execute<{ id: string }>(
          sql`select id from close_run_tasks where run_id = ${context.runId} and org_id = ${context.orgId}
          and id = coalesce(${context.taskId ?? null}, id) order by case when key = 'publish-package' then 0 else 1 end, sort_order limit 1`,
          "objects",
        );
        if (!target[0])
          throw new CloseError("report automation could not resolve an evidence task");
        const snapshot = {
          report,
          periodId: run.period_id,
          bookId: run.book_id,
          generatedAt: new Date().toISOString(),
          fingerprint: run.data_fingerprint,
        };
        const hash = createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
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
            values (${context.orgId}, ${context.runId}, ${target[0]!.id}, 'report',
                    ${`/reports/${report}?period=${run.period_id}&book=${run.book_id}`}, ${String(config.label ?? report)},
                    ${JSON.stringify(snapshot)}::jsonb, ${hash}, ${context.actorId ?? null}, ${context.actorId ?? null})`);
          },
        });
      } else if (rule.action === "start_flow") {
        const subjectKind = typeof config.subjectKind === "string" ? config.subjectKind : "";
        const subjectId =
          config.subjectId === "$task"
            ? context.taskId
            : config.subjectId === "$run"
              ? context.runId
              : config.subjectId;
        const buttonId = typeof config.buttonId === "string" ? config.buttonId : "";
        if (!subjectKind || typeof subjectId !== "string" || !buttonId)
          throw new CloseError("flow automation requires subjectKind, subjectId, and buttonId");
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
        throw new CloseError(`unsupported close automation action: ${rule.action}`);
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
          payload: {
            ruleId: String(rule.id),
            trigger: context.trigger,
            action: String(rule.action),
          },
        });
      } catch (completionError) {
        if (!(completionError instanceof CloseAutomationLeaseFencedError)) throw completionError;
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
  // bypass: scheduler-tick — due close automations are found across every production organization.
  const due = await withBypassContext(() =>
    db.execute<{ org_id: string; id: string; target_close_date: string }>(
      sql`
    select distinct r.org_id, r.id, r.target_close_date::text as target_close_date
      from close_runs r
      join close_automation_rules a on a.org_id = r.org_id and a.trigger = 'deadline_approaching' and a.is_active
      join orgs organization on organization.id = r.org_id and organization.env_kind = 'production'
     where r.status in ('in_progress','review','approved') and r.target_close_date <= current_date + 91
       -- Registry fallback shape (non-boolean stored values fall back to the
       -- default instead of throwing 22P02); the explicit conjunction is the
       -- advancedClose parentKey ['flows'] chain.
       and case (organization.settings->'features'->>'advancedClose') when 'true' then true when 'false' then false else false end
       and case (organization.settings->'features'->>'flows') when 'true' then true when 'false' then false else true end
  `,
      "objects",
    ),
  );
  for (const run of due) {
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
  return due.length;
}
