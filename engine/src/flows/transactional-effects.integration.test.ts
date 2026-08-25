import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import type { AutomationPlan } from "@openbooks/forms-core";
import { db, env, schema, withOrgTransaction } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../test-fixtures.ts";
import { executeFlowPlan } from "./execute.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import {
  enqueueFlowEmail,
  processDueSchedulerOutbox,
  type OutboxRow,
} from "../scheduler-outbox.ts";

/**
 * Transactional flow-email effects. Flows dispatched from inside a caller's
 * database transaction (document void reservation, posting commands) must
 * keep every external side effect atomic with that unit:
 *
 *   • A rolled-back unit leaves NO pending flow_email behind — mail can never
 *     escape for mutations that never committed (the audit defect where Redis
 *     kept an enqueued email while PostgreSQL discarded the flow_run, effect
 *     claims, and gates).
 *   • A replayed execution collapses onto the same outbox row (deterministic
 *     occurrence key), so a lost checkpoint cannot double-send either.
 *   • A COMMITTED unit's emails are delivered by the scheduler-outbox worker
 *     exactly once and then never again.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

// Gate one-click links sign HMAC tokens at render time; the engine's resolved
// env snapshot is populated here so deferral itself is what's under test.
env.FLOWS_EMAIL_SECRET ||= "transactional-flow-email-test-signing-secret";

const adapter = createDocumentsFlowAdapter("vendor_bill");

type EmailTarget = { type: "user"; userId: string };

function emailPlan(to: EmailTarget[]): AutomationPlan {
  return {
    actions: [],
    actionNodes: [
      {
        nodeId: "email_1",
        action: {
          action: "send_email",
          to,
          subject: "Void request received",
          body: "The void request for {{status}} was recorded.",
        },
      },
    ],
    gates: [],
  };
}

function gatePlan(assignees: EmailTarget[]): AutomationPlan {
  return {
    actions: [],
    actionNodes: [],
    gates: [
      { nodeId: "gate_1", gate: { title: "Void approval", assignees, mode: "any" } },
    ],
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
    values (${flowId}, ${orgId}, ${"Transactional email probe"}, 'vendor_bill', true, '{"nodes":[],"edges":[]}'::jsonb)`);
  const [run] = await db
    .insert(schema.flowRuns)
    .values({
      orgId,
      flowId,
      subjectKind: "vendor_bill",
      subjectId,
      trigger: "before_void",
      status: "running",
      context: {},
    })
    .returning({ id: schema.flowRuns.id });
  return { runId: run!.id, flowId, subjectId };
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

const outboxForRun = (runId: string) =>
  db.execute<{ id: string; status: string; payload: unknown }>(sql`
    select id, status, payload from scheduler_outbox
     where kind = 'flow_email' and subject_id = ${runId}
     order by created_at
  `);

test("a rolled-back transactional flow leaves no pending email behind", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const params = {
      flow: { id: run.flowId, name: "Rollback probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: emailPlan([{ type: "user", userId: actors.approver1Id }]),
      evalCtx: { values: {}, rows: {} },
    };

    await assert.rejects(
      withOrgTransaction(org.orgId, async () => {
        const res = await executeFlowPlan({ orgId: org.orgId }, adapter, params);
        assert.equal(res.failed.length, 0);
        assert.equal(res.completed.length, 1, "the email effect ran inside the unit");
        // The deferred send is visible inside the caller's own transaction…
        const visible = await outboxForRun(run.runId);
        assert.equal(visible.rows.length, 1);
        // …and then the business unit fails after the flow ran.
        throw new Error("void completion exploded");
      }),
      /void completion exploded/,
    );

    // Rollback discards the pending send together with every flow effect.
    assert.equal(
      (await outboxForRun(run.runId)).rows.length,
      0,
      "no flow email may survive the rolled-back unit",
    );
    assert.equal(
      await db.execute<{ n: number }>(sql`
        select count(*) as n from flow_run_effects where run_id = ${run.runId}
      `).then((r) => Number(r.rows[0]!.n)),
      0,
      "effect checkpoints roll back with the unit",
    );
  });
});

test("a replayed execution collapses onto the same outbox row", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const params = {
      flow: { id: run.flowId, name: "Replay probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: emailPlan([{ type: "user", userId: actors.approver1Id }]),
      evalCtx: { values: {}, rows: {} },
    };

    const first = await executeFlowPlan({ orgId: org.orgId }, adapter, params);
    assert.equal(first.completed.length, 1);
    const rows = (await outboxForRun(run.runId)).rows;
    assert.equal(rows.length, 1);

    // Crash-window replay: the effect checkpoint was lost (crash before its
    // side effect completed) while the outbox row survived. Re-executing the
    // same run re-runs the node but must NOT enqueue a second copy.
    await db.execute(sql`delete from flow_run_effects where run_id = ${run.runId}`);
    const second = await executeFlowPlan({ orgId: org.orgId }, adapter, params);
    assert.equal(second.completed.length, 1, "the replay re-ran the unclaimed node");
    assert.equal((await outboxForRun(run.runId)).rows.length, 1, "still exactly one pending send");
  });
});

test("committed flow emails drain through the outbox exactly once", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const first = await executeFlowPlan({ orgId: org.orgId }, adapter, {
      flow: { id: run.flowId, name: "Drain probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: emailPlan([{ type: "user", userId: actors.approver1Id }]),
      evalCtx: { values: {}, rows: {} },
    });
    assert.equal(first.failed.length, 0);

    const sent: OutboxRow[] = [];
    await processDueSchedulerOutbox(new Date(Date.now() + 1_000), 50, async (row) => {
      if (row.kind === "flow_email" && row.subject_id === run.runId) sent.push(row);
    });
    assert.equal(sent.length, 1, "the worker delivered exactly one flow email");
    assert.equal(sent[0]!.org_id, org.orgId, "the delivery carries its organization");
    const stored = (await outboxForRun(run.runId)).rows[0]!;
    const payload = stored.payload as {
      to: string[];
      subject: string;
      html: string;
      text: string;
      meta?: { category?: string };
    };
    assert.deepEqual(payload.to, [`u-${actors.approver1Id.slice(0, 8)}@scratch.test`]);
    assert.equal(payload.subject, "Void request received");
    assert.match(payload.html, /Void request received/);
    assert.equal(typeof payload.text, "string");
    assert.deepEqual(payload.meta, { category: "flows" });
    assert.equal(stored.status, "succeeded", "a delivered send is terminal");

    // A later tick must not resend the terminal row.
    const again: OutboxRow[] = [];
    await processDueSchedulerOutbox(new Date(Date.now() + 61_000), 50, async (row) => {
      if (row.kind === "flow_email" && row.subject_id === run.runId) again.push(row);
    });
    assert.equal(again.length, 0, "delivered flow email is never re-sent");
  });
});

test("gate approval requests defer per assignee through the outbox", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const res = await executeFlowPlan({ orgId: org.orgId }, adapter, {
      flow: { id: run.flowId, name: "Gate deferral probe", subjectKind: "vendor_bill", graph: {} },
      runId: run.runId,
      subjectId: run.subjectId,
      plan: gatePlan([
        { type: "user", userId: actors.approver1Id },
        { type: "user", userId: actors.approver2Id },
      ]),
      evalCtx: { values: {}, rows: {} },
    });
    assert.equal(res.gatesCreated, 2);

    // One pending approval-request email per gate ROW, keyed deterministically.
    const rows = (await outboxForRun(run.runId)).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const payload = row.payload as { meta?: { category?: string }; to: string[] };
      assert.equal(payload.meta?.category, "approvals");
    }
    assert.notEqual(rows[0]!.id, rows[1]!.id);

    const gateRows = await db.execute<{ id: string }>(sql`
      select id from flow_gates where run_id = ${run.runId} order by created_at
    `);
    const keys = await db.execute<{ occurrence_key: string }>(sql`
      select occurrence_key from scheduler_outbox
       where kind = 'flow_email' and subject_id = ${run.runId}
       order by occurrence_key
    `);
    for (const gate of gateRows.rows) {
      assert.ok(
        keys.rows.some((k) => k.occurrence_key === `${run.runId}:gate-email:${gate.id}`),
        "each gate row owns exactly one deterministic approval email",
      );
    }
  });
});

test("enqueueFlowEmail rejects malformed deliveries before they become durable", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const runId = randomUUID();
    await assert.rejects(
      enqueueFlowEmail({
        orgId: org.orgId,
        runId,
        occurrenceKey: `${runId}:bad`,
        payload: { to: [], subject: "x", html: "", text: "" },
      }),
      /malformed/,
    );
    await assert.rejects(
      enqueueFlowEmail({
        orgId: org.orgId,
        runId,
        occurrenceKey: `${runId}:bad`,
        payload: { to: ["not-an-email"], subject: "x", html: "", text: "" },
      }),
      /malformed/,
    );
    assert.equal(
      Number((await db.execute<{ n: number }>(sql`
        select count(*) as n from scheduler_outbox
         where kind = 'flow_email' and subject_id = ${runId}
      `)).rows[0]!.n),
      0,
      "no malformed delivery may reach storage",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
