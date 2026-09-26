import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { refreshCloseRun, runCloseAutomations } from "./run-automation.ts";
import { assignCloseTaskTx } from "./tasks.ts";
import { CloseError } from "../periods/period-policy.ts";
import {
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  setupCloseAutomationHarness,
  type CloseAutomationHarness,
} from "../testing/hrm-harness.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type Harness = CloseAutomationHarness;

async function setupAssignHarness(): Promise<Harness> {
  return setupCloseAutomationHarness("fp-assign-task");
}

async function insertTask(h: Harness, key: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into close_run_tasks
      (org_id, run_id, key, title, workstream, task_type, completion_mode, gate_type,
       status, sort_order, owner_id, reviewer_id, evidence_required, created_by, updated_by)
    values (${h.orgId}, ${h.runId}, ${key}, ${key}, 'execute', 'action',
            'manual', 'hard', 'ready', 10, ${h.submitterId}, null, false, ${h.adminId}, ${h.adminId})
    returning id`)).rows[0]!.id;
}

async function taskOwner(h: Harness, taskId: string): Promise<string | null> {
  return (await db.execute<{ owner_id: string | null }>(sql`
    select owner_id from close_run_tasks where id = ${taskId}`)).rows[0]?.owner_id ?? null;
}

async function taskAssignEvents(h: Harness, taskId: string) {
  return (await db.execute<{ event_type: string; payload: unknown }>(sql`
    select event_type, payload from close_events
     where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}
       and event_type = 'task.assign'`)).rows;
}

async function stabilize(h: Harness, ownerId: string): Promise<void> {
  await refreshCloseRun(h.orgId, h.runId, h.submitterId);
  await db.execute(sql`
    insert into close_automation_rules
      (org_id, name, trigger, action, conditions, config, is_active)
    values (${h.orgId}, 'auto-assign', 'task_ready', 'assign', '{}'::jsonb,
            ${JSON.stringify({ ownerUserId: ownerId })}::jsonb, true)`);
}

function fire(h: Harness, taskId: string) {
  return runCloseAutomations({
    orgId: h.orgId,
    runId: h.runId,
    taskId,
    trigger: "task_ready",
    eventKey: `assign-task:${randomUUID()}`,
    actorId: h.submitterId,
  });
}

test("assignment automation sets the owner and writes a task audit event", { skip: !DB }, async () => {
  const h = await setupAssignHarness();
  try {
    const taskId = await insertTask(h, "assignable");
    await stabilize(h, h.approver1Id);
    const outcome = await fire(h, taskId);
    assert.equal(outcome.completed, 1);
    assert.equal(outcome.failed, 0);
    assert.equal(await taskOwner(h, taskId), h.approver1Id);
    const events = await taskAssignEvents(h, taskId);
    assert.equal(events.length, 1);
    assert.deepEqual((events[0]!.payload as { after: { ownerId: string } }).after.ownerId, h.approver1Id);
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("assignment against a vanished task is refused by name, never a zero-row success", { skip: !DB }, async () => {
  const h = await setupAssignHarness();
  try {
    // The automation claim blind-inserts the trigger's task id, so a fully
    // deleted task fails before any branch runs; the race this guards is a
    // task vanishing between claim and assignment, which lands here.
    await assert.rejects(
      db.transaction(async (tx) =>
        assignCloseTaskTx(tx, {
          orgId: h.orgId,
          runId: h.runId,
          taskId: randomUUID(),
          ownerId: h.approver1Id,
          reviewerId: null,
          actorId: h.submitterId,
        }),
      ),
      (error: unknown) => error instanceof CloseError && /automation task not found/.test(error.message),
    );
  } finally {
    await dropScratchOrg(h.orgId);
  }
});
