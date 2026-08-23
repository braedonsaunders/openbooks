import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { AutomationPlan } from "@openbooks/forms-core";
import { db, schema } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedDraftDocument,
  type ScratchOrg,
  type FlowActors,
} from "../test-fixtures.ts";
import { executeFlowPlan } from "./execute.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";

/**
 * Effect-claim atomicity. A flow_run_effects checkpoint must be claimed with
 * an atomic INSERT … ON CONFLICT DO NOTHING RETURNING BEFORE the side effect
 * runs — the old read-then-act let two concurrent executions of one run both
 * pass the completed-check and double-fire notifications/approval requests.
 * Proves:
 *
 *   • Two concurrent executions of one run fire a notify effect EXACTLY once.
 *   • Same for a gate node (approval notifications are not themselves deduped).
 *   • Failure semantics unchanged: a failed action leaves NO claim behind, so
 *     a retry resumes from the failed node.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const adapter = createDocumentsFlowAdapter("vendor_bill");

function notifyPlan(to: Array<{ type: "user"; userId: string } | { type: "role"; role: string }>): AutomationPlan {
  return {
    actions: [],
    actionNodes: [
      { nodeId: "notify_1", action: { action: "notify", to, title: "Concurrent race probe" } },
    ],
    gates: [],
  };
}

function gatePlan(assignees: Array<{ type: "user"; userId: string }>): AutomationPlan {
  return {
    actions: [],
    actionNodes: [],
    gates: [{ nodeId: "gate_1", gate: { title: "Race gate", assignees, mode: "any" } }],
  };
}

async function createRun(
  orgId: string,
  submitterId: string,
): Promise<{ runId: string; flowId: string; subjectId: string }> {
  const flowId = randomUUID();
  const subjectId = await seedDraftDocument(orgId, { kind: "vendor_bill", createdBy: submitterId });
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, ${"Race probe"}, 'vendor_bill', true, '{"nodes":[],"edges":[]}'::jsonb)`);
  const [run] = await db
    .insert(schema.flowRuns)
    .values({
      orgId,
      flowId,
      subjectKind: "vendor_bill",
      subjectId,
      trigger: "on_submit",
      status: "running",
      context: {},
    })
    .returning({ id: schema.flowRuns.id });
  return { runId: run!.id, flowId, subjectId };
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const r = await db.execute<{ n: number }>(query);
  return Number(r.rows[0]!.n);
}

async function withOrgFixture(fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await fn(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

test("two concurrent executions of one run fire a notify exactly once", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const params = {
      flow: { id: run.flowId, name: "Race probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: notifyPlan([{ type: "user", userId: actors.approver1Id }]),
      evalCtx: { values: {}, rows: {} },
    };

    // Fire two executions of the SAME run simultaneously — promise racing per
    // posting-exactly-once.integration.test.ts conventions.
    const results = await Promise.allSettled([
      executeFlowPlan({ orgId: org.orgId }, adapter, params),
      executeFlowPlan({ orgId: org.orgId }, adapter, params),
    ]);
    for (const r of results) assert.equal(r.status, "fulfilled");

    const outcomes = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof executeFlowPlan>>>).value);
    const totalCompleted = outcomes.reduce((n, res) => n + res.completed.length, 0);
    assert.equal(totalCompleted, 1, "exactly one execution reported the effect");
    assert.equal(outcomes.filter((res) => res.failed.length > 0).length, 0, "no execution failed");

    assert.equal(
      await countRows(sql`select count(*) as n from notifications where org_id = ${org.orgId} and kind = 'flow'`),
      1,
      "one notification — never a duplicate",
    );
    assert.equal(
      await countRows(sql`select count(*) as n from flow_run_effects where run_id = ${run.runId}`),
      1,
      "exactly one claimed checkpoint",
    );
  });
});

test("a failed action releases its claim so a retry resumes from it", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);

    // A role with no members resolves zero recipients → the notify throws.
    const first = await executeFlowPlan({ orgId: org.orgId }, adapter, {
      flow: { id: run.flowId, name: "Resume probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: notifyPlan([{ type: "role", role: "nonexistent_role" }]),
      evalCtx: { values: {}, rows: {} },
    });
    assert.equal(first.failed.length, 1);
    assert.match(first.failed[0]!, /no users resolved/);
    assert.equal(
      await countRows(sql`select count(*) as n from flow_run_effects where run_id = ${run.runId}`),
      0,
      "failed node left no claim behind",
    );

    // The retry (same run) with recipients resolved succeeds and claims.
    const second = await executeFlowPlan({ orgId: org.orgId }, adapter, {
      flow: { id: run.flowId, name: "Resume probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: notifyPlan([{ type: "user", userId: actors.approver1Id }]),
      evalCtx: { values: {}, rows: {} },
    });
    assert.equal(second.failed.length, 0);
    assert.equal(second.completed.length, 1, "the retry ran the previously failed node");
    assert.equal(await countRows(sql`select count(*) as n from flow_run_effects where run_id = ${run.runId}`), 1);
    assert.equal(
      await countRows(sql`select count(*) as n from notifications where org_id = ${org.orgId} and kind = 'flow'`),
      1,
    );
  });
});

test("two concurrent executions of one run create a gate's approval notifications once", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const params = {
      flow: { id: run.flowId, name: "Gate race probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: gatePlan([
        { type: "user", userId: actors.approver1Id },
        { type: "user", userId: actors.approver2Id },
      ]),
      evalCtx: { values: {}, rows: {} },
    };

    const results = await Promise.allSettled([
      executeFlowPlan({ orgId: org.orgId }, adapter, params),
      executeFlowPlan({ orgId: org.orgId }, adapter, params),
    ]);
    for (const r of results) assert.equal(r.status, "fulfilled");

    const outcomes = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof executeFlowPlan>>>).value);
    const totalGates = outcomes.reduce((n, res) => n + res.gatesCreated, 0);
    assert.equal(totalGates, 2, "one gate row per assignee, created by exactly one execution");

    assert.equal(
      await countRows(sql`select count(*) as n from notifications where org_id = ${org.orgId} and kind = 'approval'`),
      2,
      "one approval notification per assignee — never duplicated",
    );
    assert.equal(
      await countRows(sql`select count(*) as n from flow_run_effects where run_id = ${run.runId}`),
      1,
      "exactly one claimed gate checkpoint",
    );
  });
});
