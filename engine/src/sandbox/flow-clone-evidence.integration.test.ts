import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { assertDedicatedFixtureDatabase } from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "sandbox Flow evidence rebases tenant identities while preserving graph references and financial terms",
  DB,
  async () => {
    await assertDedicatedFixtureDatabase();
    const seed = randomUUID(),
      org = randomUUID(),
      target = randomUUID(),
      actor = randomUUID(),
      flow = randomUUID(),
      run = randomUUID(),
      subject = randomUUID(),
      gate = randomUUID(),
      node = randomUUID();
    const graph = {
      schemaVersion: 1,
      nodes: [
        {
          id: node,
          position: { x: 0, y: 0 },
          data: {
            kind: "gate",
            gate: {
              title: "Review",
              mode: "all",
              assignees: [{ type: "user", userId: actor }],
              preventSelfApproval: false,
            },
          },
        },
      ],
      edges: [
        {
          id: randomUUID(),
          source: node,
          target: node,
          sourceHandle: "approve",
        },
      ],
    };
    const original = {
      id: subject,
      orgId: org,
      createdBy: actor,
      submitted_by: actor,
      amount: "2918.7660",
      effectiveOn: "2026-08-31",
      submissionPolicy: {
        flowId: flow,
        graph,
        rows: { lines: [{ id: randomUUID(), amount: "2918.7660" }] },
      },
      policy: {
        version: 1,
        kind: "gated",
        trigger: "on_submit",
        flowIds: [flow],
        runIds: [run],
      },
      approvalContinuation: {
        version: 1,
        gateId: gate,
        nodeId: node,
        actorId: actor,
        evalCtx: { values: { id: subject, amount: "2918.7660" }, rows: {} },
      },
      custom: { externalReference: subject },
      requestKey: gate,
    };
    const row = (
      await db.execute<{
        actual: typeof original;
        actor: string;
        flow: string;
        run: string;
        subject: string;
        gate: string;
      }>(
        sql`
  select public.flow_clone_evidence(${JSON.stringify(original)}::jsonb,${seed}::uuid,'context',${target}::uuid) as actual,
   public.ob_rebase(${actor}::uuid,${seed}::uuid)::text as actor,public.ob_rebase(${flow}::uuid,${seed}::uuid)::text as flow,
   public.ob_rebase(${run}::uuid,${seed}::uuid)::text as run,public.ob_rebase(${subject}::uuid,${seed}::uuid)::text as subject,
   public.ob_rebase(${gate}::uuid,${seed}::uuid)::text as gate`,
        "objects",
      )
    )[0]!;
    assert.equal(row.actual.orgId, target);
    assert.equal(row.actual.id, row.subject);
    assert.equal(row.actual.createdBy, row.actor);
    assert.equal(row.actual.submitted_by, row.actor);
    assert.deepEqual(row.actual.policy, {
      ...original.policy,
      flowIds: [row.flow],
      runIds: [row.run],
    });
    assert.equal(row.actual.submissionPolicy.flowId, row.flow);
    assert.equal(row.actual.submissionPolicy.graph.nodes[0]?.id, node);
    assert.deepEqual(row.actual.submissionPolicy.graph.edges, graph.edges);
    assert.equal(
      row.actual.submissionPolicy.graph.nodes[0]?.data.gate.assignees[0]?.userId,
      row.actor,
    );
    assert.deepEqual(row.actual.approvalContinuation, {
      ...original.approvalContinuation,
      gateId: row.gate,
      actorId: row.actor,
      evalCtx: { values: { id: row.subject, amount: "2918.7660" }, rows: {} },
    });
    assert.equal(row.actual.amount, original.amount);
    assert.equal(row.actual.effectiveOn, original.effectiveOn);
    assert.deepEqual(row.actual.custom, original.custom);
    assert.equal(row.actual.requestKey, row.gate);
  },
);
