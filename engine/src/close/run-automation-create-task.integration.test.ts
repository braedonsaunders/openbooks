import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ensureCloseDefaults } from "./defaults.ts";
import { runCloseAutomations } from "./run-automation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function seedCreateTaskRule(args: {
  orgId: string;
  name: string;
  config: Record<string, unknown>;
}): Promise<string> {
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into close_automation_rules
      (org_id, name, trigger, action, conditions, config, is_active)
    values (${args.orgId}, ${args.name}, 'run_started', 'create_task',
            '{}'::jsonb, ${JSON.stringify(args.config)}::jsonb, true)
    returning id
  `));
  return inserted.rows[0]!.id;
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

async function executionStatus(
  orgId: string,
  ruleId: string,
  eventKey: string,
): Promise<{ status: string; error: string | null }> {
  const result = (await db.execute<{
    status: string;
    error: string | null;
  }>(sql`
    select status, error from close_automation_executions
     where org_id = ${orgId} and rule_id = ${ruleId} and event_key = ${eventKey}
  `));
  return result.rows[0]!;
}

test(
  "conflicting create_task rules on one key: second refuses by name, first row unchanged",
  { skip: !DB },
  async () => {
    await withProbe(async (fixture, _actors, runId) => {
      const key = `shared-${randomUUID().slice(0, 8)}`;
      const ruleA = await seedCreateTaskRule({
        orgId: fixture.orgId,
        name: "conflict rule A",
        config: {
          key,
          title: "Shared title A",
          description: "A controls",
          evidenceRequired: true,
        },
      });
      const ruleB = await seedCreateTaskRule({
        orgId: fixture.orgId,
        name: "conflict rule B",
        config: {
          key,
          title: "Conflicting title B",
          description: "B controls",
          evidenceRequired: false,
        },
      });
      const eventKey = `probe:${randomUUID()}`;

      const result = await runCloseAutomations({
        orgId: fixture.orgId,
        runId,
        trigger: "run_started",
        eventKey,
      });
      assert.deepEqual(result, { completed: 1, failed: 1 });

      // Exactly one row survives, with the FIRST rule's configuration: the
      // conflicting configuration was refused, never overwritten.
      const rows = (
        await db.execute<{
          title: string;
          description: string | null;
          workstream: string;
          evidence_required: boolean;
          status: string;
          completed_at: Date | null;
        }>(sql`
        select title, description, workstream, evidence_required, status, completed_at
          from close_run_tasks
         where org_id = ${fixture.orgId} and run_id = ${runId} and key = ${key}
      `)
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.title, "Shared title A");
      assert.equal(rows[0]!.description, "A controls");
      assert.equal(rows[0]!.evidence_required, true);
      assert.equal(rows[0]!.status, "ready");
      assert.equal(rows[0]!.completed_at, null);

      // The first rule's execution completed; the conflicting rule's
      // execution failed and names the colliding key plus the remedy.
      assert.deepEqual((await executionStatus(fixture.orgId, ruleA, eventKey)).status, "completed");
      const failedB = await executionStatus(fixture.orgId, ruleB, eventKey);
      assert.equal(failedB.status, "failed");
      assert.match(failedB.error ?? "", new RegExp(key));
      assert.match(failedB.error ?? "", /unique config\.key/);
    });
  },
);

test(
  "identical create_task replay under a new event adopts the row and completes",
  { skip: !DB },
  async () => {
    await withProbe(async (fixture, _actors, runId) => {
      const key = `ensure-${randomUUID().slice(0, 8)}`;
      const ruleId = await seedCreateTaskRule({
        orgId: fixture.orgId,
        name: "ensure rule",
        config: { key, title: "Ensure title" },
      });
      const first = await runCloseAutomations({
        orgId: fixture.orgId,
        runId,
        trigger: "run_started",
        eventKey: `probe:${randomUUID()}`,
      });
      assert.deepEqual(first, { completed: 1, failed: 0 });
      const second = await runCloseAutomations({
        orgId: fixture.orgId,
        runId,
        trigger: "run_started",
        eventKey: `probe:${randomUUID()}`,
      });
      assert.deepEqual(second, { completed: 1, failed: 0 });

      const count = (
        await db.execute<{ n: number }>(sql`
        select count(*)::int as n from close_run_tasks
         where org_id = ${fixture.orgId} and run_id = ${runId} and key = ${key}
      `)
      ).rows[0]!.n;
      assert.equal(count, 1);
      const executions = (
        await db.execute<{ status: string }>(sql`
        select status from close_automation_executions
         where org_id = ${fixture.orgId} and rule_id = ${ruleId}
      `)
      ).rows;
      assert.equal(executions.length, 2);
      assert.ok(executions.every((execution) => execution.status === "completed"));
    });
  },
);

test(
  "computed survivor with matching authored fields still refuses the key",
  { skip: !DB },
  async () => {
    await withProbe(async (fixture, actors, runId) => {
      const key = `computed-${randomUUID().slice(0, 8)}`;
      // A blueprint/computed task carrying the same five authored fields the
      // rule would write — but different fixed semantics (system/computed).
      // Adoption must require the action/manual semantics the insert
      // promises, so this collision refuses instead of adopting.
      await db.execute(sql`
        insert into close_run_tasks
          (org_id, run_id, key, title, description, workstream, task_type, completion_mode, gate_type,
           status, sort_order, evidence_required, created_by, updated_by)
        values (${fixture.orgId}, ${runId}, ${key}, 'Computed title', 'Shared controls', 'review',
                'system', 'computed', 'none', 'ready', 10, false, ${actors.adminId}, ${actors.adminId})`);
      const ruleId = await seedCreateTaskRule({
        orgId: fixture.orgId,
        name: "computed colliding rule",
        config: { key, title: "Computed title", description: "Shared controls" },
      });
      const eventKey = `probe:${randomUUID()}`;

      const result = await runCloseAutomations({
        orgId: fixture.orgId,
        runId,
        trigger: "run_started",
        eventKey,
      });
      assert.deepEqual(result, { completed: 0, failed: 1 });

      // The computed survivor is unchanged — no overwrite, no completion.
      const rows = (
        await db.execute<{
          title: string;
          task_type: string;
          completion_mode: string;
          status: string;
          completed_at: Date | null;
        }>(sql`
        select title, task_type, completion_mode, status, completed_at
          from close_run_tasks
         where org_id = ${fixture.orgId} and run_id = ${runId} and key = ${key}
      `)
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.title, "Computed title");
      assert.equal(rows[0]!.task_type, "system");
      assert.equal(rows[0]!.completion_mode, "computed");
      assert.equal(rows[0]!.status, "ready");
      assert.equal(rows[0]!.completed_at, null);

      const failed = await executionStatus(fixture.orgId, ruleId, eventKey);
      assert.equal(failed.status, "failed");
      assert.match(failed.error ?? "", new RegExp(key));
      assert.match(failed.error ?? "", /unique config\.key/);
    });
  },
);
