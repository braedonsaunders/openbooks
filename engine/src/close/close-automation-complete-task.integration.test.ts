import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ensureCloseDefaults } from "./defaults.ts";
import { refreshCloseRun, runCloseAutomations } from "./run-automation.ts";
import { addCloseEvidence, updateCloseTask } from "./tasks.ts";
import { CloseError } from "./period-policy.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface Harness {
  orgId: string;
  runId: string;
  blueprintId: string;
  reportingPackageId: string;
  submitterId: string;
  approver1Id: string;
  adminId: string;
}

async function setupHarness(fingerprint: string | null = "fp-complete-task"): Promise<Harness> {
  const fixture = await createScratchOrg();
  const actors = await seedFlowActors(fixture.orgId);
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"advancedClose":true}'::jsonb, true)
    where id = ${fixture.orgId}`);
  const defaults = await ensureCloseDefaults(fixture.orgId, actors.adminId);
  const runId = (await db.execute<{ id: string }>(sql`
    insert into close_runs
      (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
       current_stage, target_close_date, scope, data_fingerprint, started_at, started_by, created_by, updated_by)
    values (${fixture.orgId}, ${fixture.periodId}, ${fixture.bookId}, ${defaults.blueprintId},
            ${defaults.reportingPackageId}, 'in_progress', 'execute', current_date + 30,
            '{}'::jsonb, ${fingerprint}, now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})
    returning id`)).rows[0]!.id;
  return {
    orgId: fixture.orgId,
    runId,
    blueprintId: defaults.blueprintId,
    reportingPackageId: defaults.reportingPackageId,
    submitterId: actors.submitterId,
    approver1Id: actors.approver1Id,
    adminId: actors.adminId,
  };
}

async function insertTask(
  h: Harness,
  key: string,
  overrides: {
    ownerId?: string | null;
    reviewerId?: string | null;
    status?: string;
    completionMode?: string;
    evidenceRequired?: boolean;
    gateType?: string;
  } = {},
): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into close_run_tasks
      (org_id, run_id, key, title, workstream, task_type, completion_mode, gate_type,
       status, sort_order, owner_id, reviewer_id, evidence_required, created_by, updated_by)
    values (${h.orgId}, ${h.runId}, ${key}, ${key}, 'execute', 'action',
            ${overrides.completionMode ?? "manual"}, ${overrides.gateType ?? "hard"},
            ${overrides.status ?? "ready"}, 10,
            ${overrides.ownerId === undefined ? h.submitterId : overrides.ownerId},
            ${overrides.reviewerId ?? null},
            ${overrides.evidenceRequired ?? false}, ${h.adminId}, ${h.adminId})
    returning id`)).rows[0]!.id;
}

async function taskState(h: Harness, taskId: string) {
  return (await db.execute<{
    status: string;
    completed_by: string | null;
    reviewer_id: string | null;
  }>(sql`
    select status, completed_by, reviewer_id from close_run_tasks where id = ${taskId}`)).rows[0]!;
}

async function taskAuditCount(h: Harness, taskId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from close_events
     where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}
       and event_type like 'task.%'`)).rows[0]!.n;
}

async function taskSignoffCount(h: Harness, taskId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from close_signoffs
     where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}`)).rows[0]!.n;
}

async function failedExecutionCount(h: Harness, taskId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from close_automation_executions
     where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}
       and status = 'failed'`)).rows[0]!.n;
}

async function insertRule(h: Harness): Promise<void> {
  await db.execute(sql`
    insert into close_automation_rules
      (org_id, name, trigger, action, conditions, config, is_active)
    values (${h.orgId}, 'auto-complete', 'task_ready', 'complete_task', '{}'::jsonb, '{}'::jsonb, true)`);
}

// Validate the run so tasks carry the genuine ledger fingerprint. Without
// this, the post-completion refresh would see a fingerprint drift, invalidate
// the just-completed task, and re-drive it — two completions for one firing.
// The rule is inserted only after stabilization so setup itself fires nothing.
async function stabilize(h: Harness): Promise<void> {
  await refreshCloseRun(h.orgId, h.runId, h.submitterId);
  await insertRule(h);
}

function fire(h: Harness, taskId: string, actorId: string | null) {
  return runCloseAutomations({
    orgId: h.orgId,
    runId: h.runId,
    taskId,
    trigger: "task_ready",
    eventKey: `complete-task:${randomUUID()}`,
    actorId: actorId ?? undefined,
  });
}

test("automation completes an authorized reviewerless manual task with task audit", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const taskId = await insertTask(h, "plain");
    await stabilize(h);
    const outcome = await fire(h, taskId, h.submitterId);
    assert.equal(outcome.completed, 1);
    assert.equal(outcome.failed, 0);
    const task = await taskState(h, taskId);
    assert.equal(task.status, "complete");
    assert.equal(task.completed_by, h.submitterId);
    // The automation writes the same task-level audit event as the manual
    // path, and no review signoff: completing is not approving.
    assert.equal(await taskAuditCount(h, taskId), 1);
    const eventType = (await db.execute<{ event_type: string }>(sql`
      select event_type from close_events
       where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}
         and event_type like 'task.%'`)).rows[0]!.event_type;
    assert.equal(eventType, "task.complete");
    assert.equal(await taskSignoffCount(h, taskId), 0);
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("manual complete on a reviewer-gated task is refused; submit then approve reaches complete", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const taskId = await insertTask(h, "gated", { reviewerId: h.approver1Id });
    // RED-adjacent: the canonical path must not complete past review.
    await assert.rejects(
      updateCloseTask({ orgId: h.orgId, runId: h.runId, taskId, actorId: h.submitterId, action: "complete" }),
      (e: unknown) => e instanceof CloseError && /independent review.*submit it for review/.test(e.message),
    );
    assert.equal((await taskState(h, taskId)).status, "ready");
    // The reachable manual route still works: owner submits, a different
    // human approves, and the task completes with a review signoff.
    await assert.rejects(
      updateCloseTask({ orgId: h.orgId, runId: h.runId, taskId, actorId: h.submitterId, action: "approve" }),
      (e: unknown) => e instanceof CloseError && /only the assigned reviewer/.test(e.message),
    );
    await updateCloseTask({ orgId: h.orgId, runId: h.runId, taskId, actorId: h.submitterId, action: "submit" });
    assert.equal((await taskState(h, taskId)).status, "submitted");
    // Segregation of duties still holds: the same person cannot review
    // their own preparation.
    const selfReviewedId = await insertTask(h, "self-reviewed", {
      ownerId: h.submitterId,
      reviewerId: h.submitterId,
    });
    await updateCloseTask({ orgId: h.orgId, runId: h.runId, taskId: selfReviewedId, actorId: h.submitterId, action: "submit" });
    await assert.rejects(
      updateCloseTask({ orgId: h.orgId, runId: h.runId, taskId: selfReviewedId, actorId: h.submitterId, action: "approve" }),
      (e: unknown) => e instanceof CloseError && /different people/.test(e.message),
    );
    await updateCloseTask({ orgId: h.orgId, runId: h.runId, taskId, actorId: h.approver1Id, action: "approve" });
    const task = await taskState(h, taskId);
    assert.equal(task.status, "complete");
    assert.equal(await taskSignoffCount(h, taskId), 1);
    assert.equal(await taskAuditCount(h, taskId), 2);
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("automation refuses a reviewer-gated task and never auto-approves", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const taskId = await insertTask(h, "gated-auto", { reviewerId: h.approver1Id });
    await stabilize(h);
    // Even the owner cannot auto-complete past review through automation.
    const ownerOutcome = await fire(h, taskId, h.submitterId);
    assert.equal(ownerOutcome.completed, 0);
    assert.equal(ownerOutcome.failed, 1);
    assert.equal((await taskState(h, taskId)).status, "ready");
    assert.equal(await taskSignoffCount(h, taskId), 0);
    assert.equal(await failedExecutionCount(h, taskId), 1);
    // A non-owner is refused on owner grounds, exactly like the manual path.
    const strangerOutcome = await fire(h, taskId, h.adminId);
    assert.equal(strangerOutcome.failed, 1);
    assert.equal((await taskState(h, taskId)).status, "ready");
    // The pending review still gates approval: run approval only considers
    // complete/waived tasks done.
    const blockers = (await db.execute<{ tasks: string }>(sql`
      select (select count(*) from close_run_tasks where run_id = ${h.runId} and org_id = ${h.orgId} and gate_type = 'hard'
        and task_type <> 'approval' and status not in ('complete','waived')) as tasks`));
    assert.equal(Number(blockers.rows[0]?.tasks ?? 0) >= 1, true);
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("automation refuses blocked, non-owned, evidence-gated, and computed tasks", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const ownedId = await insertTask(h, "owned");
    const evidenceId = await insertTask(h, "needs-evidence", { evidenceRequired: true });
    const computedId = await insertTask(h, "computed", { completionMode: "computed" });
    await stabilize(h);
    // A blocked task is seeded after stabilization: dependency resolution
    // recomputes readiness from blueprint links, so seeding it earlier would
    // flip this link-free task back to ready before the refusal is probed.
    const blockedId = await insertTask(h, "blocked", { status: "blocked" });
    const blockedOutcome = await fire(h, blockedId, h.submitterId);
    assert.equal(blockedOutcome.failed, 1);
    assert.equal((await taskState(h, blockedId)).status, "blocked");
    const strangerOutcome = await fire(h, ownedId, h.adminId);
    assert.equal(strangerOutcome.failed, 1);
    assert.equal((await taskState(h, ownedId)).status, "ready");

    const bareOutcome = await fire(h, evidenceId, h.submitterId);
    assert.equal(bareOutcome.failed, 1);
    assert.equal((await taskState(h, evidenceId)).status, "ready");
    // The named remedy works: attach evidence, then automation completes.
    await addCloseEvidence({
      orgId: h.orgId,
      runId: h.runId,
      taskId: evidenceId,
      actorId: h.submitterId,
      evidenceType: "note",
      label: "reconciliation note",
    });
    const remediedOutcome = await fire(h, evidenceId, h.submitterId);
    assert.equal(remediedOutcome.completed, 1);
    assert.equal((await taskState(h, evidenceId)).status, "complete");

    const computedOutcome = await fire(h, computedId, h.submitterId);
    assert.equal(computedOutcome.failed, 1);
    assert.equal((await taskState(h, computedId)).status, "ready");
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("automation refuses to complete when the close run is not validated", { skip: !DB }, async () => {
  const h = await setupHarness(null);
  try {
    const taskId = await insertTask(h, "unvalidated");
    await insertRule(h);
    const outcome = await fire(h, taskId, h.submitterId);
    assert.equal(outcome.failed, 1);
    assert.equal((await taskState(h, taskId)).status, "ready");
  } finally {
    await dropScratchOrg(h.orgId);
  }
});
