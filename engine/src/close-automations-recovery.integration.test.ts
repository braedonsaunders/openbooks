import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { ensureCloseDefaults, runCloseAutomations } from "./close.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/** A crashed claim's durable shape: a running row whose worker died mid-run.
 * A `null` lease token / lock timestamp models pre-migration stuck rows. */
async function seedCrashedClaim(args: {
  orgId: string;
  ruleId: string;
  runId: string;
  eventKey: string;
  taskId?: string | null;
  leaseToken?: string | null;
  lockedAtMinutesAgo?: number | null;
  stages?: Record<string, boolean>;
}): Promise<string> {
  const token =
    args.leaseToken === null ? null : (args.leaseToken ?? randomUUID());
  const lockedAt =
    args.lockedAtMinutesAgo === null
      ? null
      : new Date(Date.now() - (args.lockedAtMinutesAgo ?? 20) * 60_000);
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into close_automation_executions
      (org_id, rule_id, run_id, task_id, trigger, event_key, status,
       attempt_count, lease_token, locked_at, created_by, updated_by)
    values (${args.orgId}, ${args.ruleId}, ${args.runId}, ${args.taskId ?? null}, 'run_started',
            ${args.eventKey}, 'running', 0, ${token}, ${lockedAt}, null, null)
    returning id
  `));
  const executionId = inserted.rows[0]!.id;
  if (args.stages && Object.keys(args.stages).length > 0) {
    await db.execute(sql`
      update close_automation_executions
         set stages = ${JSON.stringify(args.stages)}::jsonb
       where id = ${executionId}
    `);
  }
  return executionId;
}

async function seedRule(args: {
  orgId: string;
  action: string;
  config: Record<string, unknown>;
}): Promise<string> {
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into close_automation_rules
      (org_id, name, trigger, action, conditions, config, is_active)
    values (${args.orgId}, 'recovery probe rule', 'run_started', ${args.action},
            '{}'::jsonb, ${JSON.stringify(args.config)}::jsonb, true)
    returning id
  `));
  return inserted.rows[0]!.id;
}

async function readExecution(executionId: string): Promise<{
  status: string;
  attemptCount: number;
  leaseToken: string | null;
  lockedAt: Date | null;
  executedAt: Date | null;
}> {
  const result = (await db.execute<{
    status: string;
    attemptCount: number;
    leaseToken: string | null;
    lockedAt: Date | null;
    executedAt: Date | null;
  }>(sql`
    select status, attempt_count as "attemptCount", lease_token as "leaseToken",
           locked_at as "lockedAt", executed_at as "executedAt"
      from close_automation_executions
     where id = ${executionId}
  `));
  return result.rows[0]!;
}

async function notificationCounts(orgId: string): Promise<Map<string, number>> {
  const rows = (await db.execute<{ user_id: string; n: number }>(sql`
    select user_id, count(*)::int as n from notifications
     where org_id = ${orgId} and kind = 'close'
     group by user_id
  `)).rows;
  return new Map(rows.map((row) => [row.user_id, row.n]));
}

async function terminalEventCounts(
  orgId: string,
  executionId: string,
): Promise<{ completed: number; failed: number }> {
  const rows = (await db.execute<{ event_type: string; n: number }>(sql`
    select event_type, count(*)::int as n from close_events
     where org_id = ${orgId} and task_id is null
       and payload->>'executionId' = ${executionId}
     group by event_type
  `)).rows;
  return {
    completed: rows.find((r) => r.event_type === "automation.completed")?.n ?? 0,
    failed: rows.find((r) => r.event_type === "automation.failed")?.n ?? 0,
  };
}

async function withProbe(
  fn: (fixture: ScratchOrg, actors: FlowActors, runId: string) => Promise<void>,
): Promise<void> {
  const fixture = await createScratchOrg();
  try {
    const actors = await seedFlowActors(fixture.orgId);
    await db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"advancedClose":true}'::jsonb, true)
      where id = ${fixture.orgId}
    `);
    const defaults = await ensureCloseDefaults(fixture.orgId, actors.adminId);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into close_runs
        (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
         current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
      values (${fixture.orgId}, ${fixture.periodId}, ${fixture.bookId}, ${defaults.blueprintId},
              ${defaults.reportingPackageId}, 'in_progress', 'review', current_date + 30,
              '{}'::jsonb, now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})
      returning id
    `));
    await fn(fixture, actors, inserted.rows[0]!.id);
  } finally {
    await dropScratchOrg(fixture.orgId);
  }
}

test("a crash right after the claim is recovered by stale takeover", { skip: !DB }, async () => {
  await withProbe(async (fixture, actors, runId) => {
    const recipients = [actors.submitterId, actors.approver1Id, actors.approver2Id];
    const ruleId = await seedRule({
      orgId: fixture.orgId,
      action: "notify",
      config: { userIds: recipients, title: "Post-claim crash" },
    });
    const eventKey = `probe:${randomUUID()}`;
    // The crashed attempt claimed the row twenty minutes ago and died before
    // any effect. Before this fix such a row blocked every future retry.
    const executionId = await seedCrashedClaim({
      orgId: fixture.orgId,
      ruleId,
      runId,
      eventKey,
    });

    const result = await runCloseAutomations({
      orgId: fixture.orgId,
      runId,
      trigger: "run_started",
      eventKey,
    });
    assert.deepEqual(result, { completed: 1, failed: 0 });

    const counts = await notificationCounts(fixture.orgId);
    assert.deepEqual([...counts.values()], [1, 1, 1]);
    assert.equal(counts.size, 3);

    const execution = await readExecution(executionId);
    assert.equal(execution.status, "completed");
    assert.equal(execution.attemptCount, 1);
    assert.equal(execution.leaseToken, null);
    assert.equal(execution.lockedAt, null);
    assert.ok(execution.executedAt);

    const events = await terminalEventCounts(fixture.orgId, executionId);
    assert.deepEqual(events, { completed: 1, failed: 0 });
  });
});

test("a legacy pre-lease stuck claim is reclaimable too", { skip: !DB }, async () => {
  await withProbe(async (fixture, actors, runId) => {
    const ruleId = await seedRule({
      orgId: fixture.orgId,
      action: "notify",
      config: { userIds: [actors.submitterId], title: "Legacy freeze" },
    });
    const eventKey = `probe:${randomUUID()}`;
    const executionId = await seedCrashedClaim({
      orgId: fixture.orgId,
      ruleId,
      runId,
      eventKey,
      leaseToken: null,
      lockedAtMinutesAgo: null,
    });
    assert.equal((await readExecution(executionId)).leaseToken, null);

    await runCloseAutomations({
      orgId: fixture.orgId,
      runId,
      trigger: "run_started",
      eventKey,
    });
    const counts = await notificationCounts(fixture.orgId);
    assert.deepEqual(counts.get(actors.submitterId), 1);
    assert.equal((await readExecution(executionId)).status, "completed");
  });
});

test("a crash mid multi-recipient notify resumes exactly once with no missing or duplicate send", { skip: !DB }, async () => {
  await withProbe(async (fixture, actors, runId) => {
    const recipients = [actors.submitterId, actors.approver1Id, actors.approver2Id];
    const ruleId = await seedRule({
      orgId: fixture.orgId,
      action: "notify",
      config: { userIds: recipients, title: "Mid-notify crash" },
    });
    const eventKey = `probe:${randomUUID()}`;
    // Durable state at the crash point: recipient one's unit effect (the
    // insert + its stage checkpoint commit atomically together) landed; the
    // other two never happened.
    const executionId = await seedCrashedClaim({
      orgId: fixture.orgId,
      ruleId,
      runId,
      eventKey,
      stages: { [`notify:${actors.submitterId}`]: true },
    });
    await db.execute(sql`
      insert into notifications (org_id, user_id, kind, title, body, href)
      values (${fixture.orgId}, ${actors.submitterId}, 'close', 'Mid-notify crash', 'body', ${`/close?run=${runId}`})
    `);

    const result = await runCloseAutomations({
      orgId: fixture.orgId,
      runId,
      trigger: "run_started",
      eventKey,
    });
    assert.deepEqual(result, { completed: 1, failed: 0 });

    const counts = await notificationCounts(fixture.orgId);
    assert.deepEqual(Object.fromEntries(counts), {
      [actors.submitterId]: 1,
      [actors.approver1Id]: 1,
      [actors.approver2Id]: 1,
    });

    const execution = await readExecution(executionId);
    assert.equal(execution.status, "completed");
    const events = await terminalEventCounts(fixture.orgId, executionId);
    assert.deepEqual(events, { completed: 1, failed: 0 });
  });
});

test("a post-effect pre-terminal crash finishes without duplicating the committed effect", { skip: !DB }, async () => {
  await withProbe(async (fixture, actors, runId) => {
    // create_task: the non-idempotent half is guarded by storage itself
    // (on conflict do nothing), so a resumed attempt converges on once.
    const createRuleId = await seedRule({
      orgId: fixture.orgId,
      action: "create_task",
      config: { key: `crash-proof-${randomUUID().slice(0, 8)}`, title: "Resumed task" },
    });
    const createEventKey = `probe:${randomUUID()}`;
    const createExecutionId = await seedCrashedClaim({
      orgId: fixture.orgId,
      ruleId: createRuleId,
      runId,
      eventKey: createEventKey,
    });

    const resultCreate = await runCloseAutomations({
      orgId: fixture.orgId,
      runId,
      trigger: "run_started",
      eventKey: createEventKey,
    });
    assert.deepEqual(resultCreate, { completed: 1, failed: 0 });
    assert.equal((await readExecution(createExecutionId)).status, "completed");

    // generate_report: the evidence insert rides its stage checkpoint in one
    // transaction, so a resumed attempt skips instead of double-recording.
    const reportRuleId = await seedRule({
      orgId: fixture.orgId,
      action: "generate_report",
      config: { report: "trial-balance", label: "resumed evidence" },
    });
    const reportEventKey = `probe:${randomUUID()}`;
    const snapshot = JSON.stringify({ report: "trial-balance", crashed: true });
    const contentHash = randomUUID();
    const taskId = (await db.execute<{ id: string }>(sql`
      insert into close_run_tasks
        (org_id, run_id, key, title, workstream, task_type, completion_mode, gate_type,
         status, sort_order, due_on)
      values (${fixture.orgId}, ${runId}, 'publish-package', 'Publish package', 'publish',
              'publish', 'automatic', 'hard', 'ready', 9000, current_date + 30)
      returning id
    `)).rows[0]!.id;
    const reportExecutionId = await seedCrashedClaim({
      orgId: fixture.orgId,
      ruleId: reportRuleId,
      runId,
      eventKey: reportEventKey,
      stages: { report_evidence: true },
    });
    await db.execute(sql`
      insert into close_task_evidence
        (org_id, run_id, task_id, evidence_type, reference_url, label, snapshot, content_hash)
      values (${fixture.orgId}, ${runId}, ${taskId}, 'report', '/reports/trial-balance',
              'resumed evidence', ${snapshot}::jsonb, ${contentHash})
    `);

    const resultReport = await runCloseAutomations({
      orgId: fixture.orgId,
      runId,
      trigger: "run_started",
      eventKey: reportEventKey,
    });
    // The resumed generate_report attempt finishes exactly once, and the
    // create_task rule also fires under this new event key (still once).
    assert.deepEqual(resultReport, { completed: 2, failed: 0 });

    // No duplicate task from the second firing, no duplicate evidence from
    // the recovered one.
    const taskCount = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from close_run_tasks
       where org_id = ${fixture.orgId} and run_id = ${runId}
         and key like 'crash-proof-%'
    `)).rows[0]!.n;
    assert.equal(taskCount, 1);
    const evidenceCount = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from close_task_evidence
       where org_id = ${fixture.orgId} and task_id = ${taskId}
         and label = 'resumed evidence'
    `)).rows[0]!.n;
    assert.equal(evidenceCount, 1, "the crashed attempt's evidence must not be duplicated");
    assert.equal((await readExecution(reportExecutionId)).status, "completed");

    const events = await terminalEventCounts(fixture.orgId, createExecutionId);
    assert.deepEqual(events, { completed: 1, failed: 0 });
  });
});

test("concurrent schedulers still single-fire through the leased claim", { skip: !DB }, async () => {
  await withProbe(async (fixture, actors, runId) => {
    const recipients = [actors.submitterId, actors.approver1Id];
    const ruleId = await seedRule({
      orgId: fixture.orgId,
      action: "notify",
      config: { userIds: recipients, title: "Concurrent fire" },
    });
    const eventKey = `probe:${randomUUID()}`;

    const results = await Promise.all([
      runCloseAutomations({ orgId: fixture.orgId, runId, trigger: "run_started", eventKey }),
      runCloseAutomations({ orgId: fixture.orgId, runId, trigger: "run_started", eventKey }),
    ]);
    // Whichever scheduler wins the claim completes the automation; the loser
    // sees a live lease or a terminal verdict and records nothing.
    const ordered = [...results].sort((a, b) => a.completed - b.completed);
    assert.deepEqual(ordered, [
      { completed: 0, failed: 0 },
      { completed: 1, failed: 0 },
    ]);

    const counts = await notificationCounts(fixture.orgId);
    assert.deepEqual([...counts.values()], [1, 1]);

    const executions = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from close_automation_executions
       where org_id = ${fixture.orgId} and rule_id = ${ruleId} and event_key = ${eventKey}
    `)).rows[0]!.n;
    assert.equal(executions, 1, "exactly one claim row must exist");

    const terminalEvents = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from close_events
       where org_id = ${fixture.orgId} and event_type = 'automation.completed'
         and payload->>'executionId' = (
           select id::text from close_automation_executions
            where org_id = ${fixture.orgId} and rule_id = ${ruleId} and event_key = ${eventKey})
    `)).rows[0]!.n;
    assert.equal(terminalEvents, 1);
  });
});

test("a live lease held by another scheduler is respected, not stolen", { skip: !DB }, async () => {
  await withProbe(async (fixture, actors, runId) => {
    const ruleId = await seedRule({
      orgId: fixture.orgId,
      action: "notify",
      config: { userIds: [actors.submitterId], title: "Live lease" },
    });
    const eventKey = `probe:${randomUUID()}`;
    const token = randomUUID();
    const executionId = await seedCrashedClaim({
      orgId: fixture.orgId,
      ruleId,
      runId,
      eventKey,
      leaseToken: token,
      lockedAtMinutesAgo: 0,
    });

    const result = await runCloseAutomations({
      orgId: fixture.orgId,
      runId,
      trigger: "run_started",
      eventKey,
    });
    assert.deepEqual(result, { completed: 0, failed: 0 });

    const execution = await readExecution(executionId);
    assert.equal(execution.status, "running");
    assert.equal(execution.attemptCount, 0);
    assert.equal(execution.leaseToken, token, "another worker's live claim was not touched");
    assert.equal((await notificationCounts(fixture.orgId)).size, 0);
  });
});
