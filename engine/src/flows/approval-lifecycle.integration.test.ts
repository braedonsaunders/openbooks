import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  grantScratchPermissions,
  seedApprovalFlow,
  seedDraftDocument,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import { submitForApproval } from "./submit.ts";
import { retryFlowRun } from "./run.ts";
import {
  decideGate,
  delegateGate,
  escalateDueGate,
  GateError,
  gateDecisionCapability,
  worklistGates,
} from "./gates.ts";
import { createDelegation } from "./delegations.ts";

/**
 * DB-backed contract tests for the approval lifecycle — the sole path gating
 * financial-document release. Proves the institutional-grade invariants:
 *
 *   • ENGINE-ENFORCED release — the document reaches 'approved' / returns to
 *     'draft' from the engine reconciling gate state, with NO authored
 *     change_status node in the flow (the exact graph that used to strand it).
 *   • Quorum any/all end-to-end through real gate rows.
 *   • FAIL-CLOSED submit — a flow that resolves to zero approvers never lets
 *     the document auto-approve; it stays draft with a flowError.
 *   • Separation of duties — the submitter can't approve their own document,
 *     even as an admin.
 *   • Concurrency — two simultaneous decisions resolve once (no double release).
 *   • Cross-user authorization — a non-approver is refused.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function docStatus(id: string): Promise<string | null> {
  const r = await db.execute<{ status: string }>(
    sql`select status from documents where id = ${id}`,
    "objects",
  );
  return r[0]?.status ?? null;
}

async function gateRows(runOrSubject: {
  subjectId: string;
}): Promise<{ id: string; status: string; assigneeUserId: string | null }[]> {
  const r = await db.execute<{ id: string; status: string; assigneeUserId: string | null }>(
    sql`
    select id, status, assignee_user_id as "assigneeUserId"
      from flow_gates where subject_id = ${runOrSubject.subjectId} order by created_at
  `,
    "objects",
  );
  return r;
}

async function withOrgFixture(
  fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await fn(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

test(
  "engine releases the document to approved with NO authored change_status (single approver)",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });

      const res = await submitForApproval("vendor_bill", docId, actors.submitterId);
      assert.equal(res.gated, true, "submit created a gate");
      assert.equal(res.flowError, null);
      assert.equal(await docStatus(docId), "pending_approval");

      const gates = await gateRows({ subjectId: docId });
      assert.equal(gates.length, 1);
      assert.equal(gates[0]!.status, "pending");

      const decision = await decideGate({
        gateId: gates[0]!.id,
        decision: "approved",
        userId: actors.approver1Id,
      });
      assert.equal(decision.resumed, "approve");
      assert.equal(decision.runStatus, "completed");
      // The engine released it — even though the flow has no change_status node.
      assert.equal(await docStatus(docId), "approved");
    });
  },
);

test("reject returns the document to draft (engine-enforced)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);
    const [gate] = await gateRows({ subjectId: docId });

    const decision = await decideGate({
      gateId: gate!.id,
      decision: "rejected",
      userId: actors.approver1Id,
      comment: "over budget",
    });
    assert.equal(decision.resumed, "reject");
    assert.equal(await docStatus(docId), "draft");
  });
});

test("quorum 'all' requires every approver before release", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "all",
      assignees: [
        { type: "user", userId: actors.approver1Id },
        { type: "user", userId: actors.approver2Id },
      ],
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);
    const gates = await gateRows({ subjectId: docId });
    assert.equal(gates.length, 2, "one gate row per approver");

    const first = gates.find((g) => g.assigneeUserId === actors.approver1Id)!;
    const second = gates.find((g) => g.assigneeUserId === actors.approver2Id)!;

    const d1 = await decideGate({
      gateId: first.id,
      decision: "approved",
      userId: actors.approver1Id,
    });
    assert.equal(d1.resumed, null, "still waiting on the second approver");
    assert.equal(await docStatus(docId), "pending_approval");

    const d2 = await decideGate({
      gateId: second.id,
      decision: "approved",
      userId: actors.approver2Id,
    });
    assert.equal(d2.resumed, "approve");
    assert.equal(await docStatus(docId), "approved");
  });
});

test(
  "quorum 'any' releases on the first approval and cancels the sibling",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [
          { type: "user", userId: actors.approver1Id },
          { type: "user", userId: actors.approver2Id },
        ],
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", docId, actors.submitterId);
      const gates = await gateRows({ subjectId: docId });
      const first = gates.find((g) => g.assigneeUserId === actors.approver1Id)!;

      await decideGate({ gateId: first.id, decision: "approved", userId: actors.approver1Id });
      assert.equal(await docStatus(docId), "approved");
      const after = await gateRows({ subjectId: docId });
      assert.equal(after.find((g) => g.assigneeUserId === actors.approver1Id)!.status, "approved");
      assert.equal(after.find((g) => g.assigneeUserId === actors.approver2Id)!.status, "cancelled");
    });
  },
);

test("submit FAILS CLOSED when an enabled flow has an invalid graph", { skip: !DB }, async () =>
  withOrgFixture(async (org, actors) => {
    await db.execute(
      sql`insert into flows(id,org_id,name,subject_kind,enabled,graph) values(${randomUUID()},${org.orgId},'Invalid approval','vendor_bill',true,'{"nodes":"invalid"}'::jsonb)`,
    );
    const id = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await assert.rejects(
      submitForApproval("vendor_bill", id, actors.submitterId),
      /invalid|cannot run/i,
    );
    assert.equal(await docStatus(id), "draft");
    assert.deepEqual(await gateRows({ subjectId: id }), []);
    assert.equal(
      (
        await db.execute(
          sql`select id from flow_runs where org_id=${org.orgId} and subject_id=${id}`,
          "objects",
        )
      ).length,
      0,
      "refused submission leaves no incomplete routing transaction",
    );
  }),
);

test("submit is REFUSED when one flow gates and another fails", { skip: !DB }, async () =>
  withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "all",
    });
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "role", role: "missing_reviewers" }],
      mode: "all",
    });
    const id = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await assert.rejects(
      submitForApproval("vendor_bill", id, actors.submitterId),
      /zero assignees/,
    );
    assert.equal(await docStatus(id), "draft");
    assert.deepEqual(await gateRows({ subjectId: id }), []);
    assert.equal(
      (
        await db.execute(
          sql`select id from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
          "objects",
        )
      ).length,
      0,
    );
  }),
);

test(
  "submit FAILS CLOSED when the approval flow resolves to zero approvers",
  { skip: !DB },
  async () =>
    withOrgFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "role", role: "missing_reviewers" }],
        mode: "all",
      });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await assert.rejects(
        submitForApproval("vendor_bill", id, actors.submitterId),
        /zero assignees/,
      );
      assert.equal(await docStatus(id), "draft");
      assert.deepEqual(await gateRows({ subjectId: id }), []);
    }),
);

test(
  "a refused initial submission can be resubmitted after its tenant corrects the Flow",
  { skip: !DB },
  async () =>
    withOrgFixture(async (org, actors) => {
      const flow = await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "role", role: "missing_reviewers" }],
        mode: "all",
      });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await assert.rejects(
        submitForApproval("vendor_bill", id, actors.submitterId),
        /zero assignees/,
      );
      await db.execute(
        sql`update flows set graph=jsonb_set(graph,'{nodes,1,data,gate,assignees}',${JSON.stringify([{ type: "user", userId: actors.approver1Id }])}::jsonb) where org_id=${org.orgId} and id=${flow.flowId}`,
      );
      const submitted = await submitForApproval("vendor_bill", id, actors.submitterId);
      assert.equal(submitted.gated, true);
      const gates = await gateRows({ subjectId: id });
      assert.equal(gates.length, 1);
      await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: actors.approver1Id });
      assert.equal(await docStatus(id), "approved");
      const receipts = await db.execute(
        sql`select id from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
        "objects",
      );
      assert.equal(receipts.length, 1);
    }),
);

test("retrying a non-failed run is refused", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);
    const waitingRun = (
      await db.execute<{ id: string }>(
        sql`
      select id from flow_runs where subject_id = ${docId} and status = 'waiting' order by started_at desc limit 1
    `,
        "objects",
      )
    )[0];
    assert.ok(waitingRun, "a waiting run must exist");
    await assert.rejects(
      retryFlowRun(waitingRun.id, { orgId: org.orgId, userId: actors.adminId }),
      /only a failed run can be retried/,
    );
  });
});

test(
  "the maker cannot approve their document even after a gate is assigned to them",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      // Normal routing excludes the maker; retarget a live gate to prove the
      // decision boundary also refuses a legacy or otherwise reassigned row.
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", docId, actors.submitterId);
      const [gate] = await gateRows({ subjectId: docId });
      assert.ok(gate, "an independent approver receives the gate");
      await grantScratchPermissions(org.orgId, actors.submitterId, ["ap.approve"]);
      await db.execute(
        sql`update flow_gates set assignee_user_id = ${actors.submitterId} where id = ${gate.id}`,
      );

      await assert.rejects(
        () => decideGate({ gateId: gate.id, decision: "approved", userId: actors.submitterId }),
        (error: unknown) => error instanceof GateError && error.code === "self_approval_forbidden",
      );
      assert.equal(await docStatus(docId), "pending_approval", "still gated, not self-approved");
    });
  },
);

test("an unassigned administrator cannot decide a document gate", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    // Gate assigned to a role the admin holds; the admin is also the submitter.
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.adminId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);
    const [gate] = await gateRows({ subjectId: docId });

    // Admin (not the assignee, but privileged) is the submitter → refused.
    await assert.rejects(
      () => decideGate({ gateId: gate!.id, decision: "approved", userId: actors.adminId }),
      (error: unknown) => error instanceof GateError,
    );
  });
});

test("a non-approver is refused", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);
    const [gate] = await gateRows({ subjectId: docId });

    await assert.rejects(
      () => decideGate({ gateId: gate!.id, decision: "approved", userId: actors.outsiderId }),
      /not an approver/,
    );
  });
});

test(
  "a deactivated approver cannot decide, even through a live one-click link",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", docId, actors.submitterId);
      const [gate] = await gateRows({ subjectId: docId });

      // The approver is deactivated after the gate (and its email link) went
      // out. The decision call below is exactly what the sessionless
      // email-action route issues: gate + decision + the bound assignee id.
      await db.execute(
        sql`update users set is_active = false where id = ${actors.approver1Id} and org_id = ${org.orgId}`,
      );
      await assert.rejects(
        () => decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id }),
        /not an approver/,
      );
      assert.equal(
        await docStatus(docId),
        "pending_approval",
        "still gated, not decided by a deactivated user",
      );
    });
  },
);

test("concurrent decisions on an 'any' gate release exactly once", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [
        { type: "user", userId: actors.approver1Id },
        { type: "user", userId: actors.approver2Id },
      ],
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);
    const gates = await gateRows({ subjectId: docId });
    const g1 = gates.find((g) => g.assigneeUserId === actors.approver1Id)!;
    const g2 = gates.find((g) => g.assigneeUserId === actors.approver2Id)!;

    // Fire both approvals simultaneously — the per-run lock serializes them.
    const results = await Promise.allSettled([
      decideGate({ gateId: g1.id, decision: "approved", userId: actors.approver1Id }),
      decideGate({ gateId: g2.id, decision: "approved", userId: actors.approver2Id }),
    ]);
    const resumed = results.filter(
      (r) => r.status === "fulfilled" && r.value.resumed === "approve",
    ).length;
    assert.equal(resumed, 1, "exactly one decision resumed the branch");
    assert.equal(await docStatus(docId), "approved");

    // Exactly one approved gate + one cancelled — never two approvals counted.
    const after = await gateRows({ subjectId: docId });
    assert.equal(after.filter((g) => g.status === "approved").length, 1);
    assert.equal(after.filter((g) => g.status === "cancelled").length, 1);
  });
});

async function gateProvenance(id: string): Promise<{
  assigneeUserId: string | null;
  decidedBy: string | null;
  delegatedFromUserId: string | null;
  onBehalfOfUserId: string | null;
}> {
  const r = await db.execute<{
    assigneeUserId: string | null;
    decidedBy: string | null;
    delegatedFromUserId: string | null;
    onBehalfOfUserId: string | null;
  }>(
    sql`
    select assignee_user_id as "assigneeUserId", decided_by as "decidedBy",
           delegated_from_user_id as "delegatedFromUserId", on_behalf_of_user_id as "onBehalfOfUserId"
      from flow_gates where id = ${id}
  `,
    "objects",
  );
  return r[0]!;
}

test(
  "delegateGate reassigns and records structured provenance (not a comment)",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", docId, actors.submitterId);
      const [gate] = await gateRows({ subjectId: docId });

      await delegateGate(gate!.id, actors.approver1Id, actors.approver2Id);
      let prov = await gateProvenance(gate!.id);
      assert.equal(prov.assigneeUserId, actors.approver2Id, "reassigned to the delegate");
      assert.equal(
        prov.delegatedFromUserId,
        actors.approver1Id,
        "original assignee preserved structurally",
      );

      // The delegate decides; provenance survives the decision.
      await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver2Id });
      prov = await gateProvenance(gate!.id);
      assert.equal(prov.decidedBy, actors.approver2Id);
      assert.equal(
        prov.delegatedFromUserId,
        actors.approver1Id,
        "hand-off audit not overwritten by the decision",
      );
      assert.equal(await docStatus(docId), "approved");
    });
  },
);

test("an out-of-office delegate decides on behalf of the principal", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);
    const [gate] = await gateRows({ subjectId: docId });

    // approver1 is out of office; approver2 covers (active window over now).
    const now = await dbNow();
    await createDelegation({
      orgId: org.orgId,
      fromUserId: actors.approver1Id,
      toUserId: actors.approver2Id,
      startsAt: new Date(now - 3_600_000),
      endsAt: new Date(now + 24 * 3_600_000),
    });

    const res = await decideGate({
      gateId: gate!.id,
      decision: "approved",
      userId: actors.approver2Id,
    });
    assert.equal(res.resumed, "approve");
    const prov = await gateProvenance(gate!.id);
    assert.equal(prov.decidedBy, actors.approver2Id, "the delegate is the decider");
    assert.equal(prov.onBehalfOfUserId, actors.approver1Id, "principal recorded structurally");
    assert.equal(await docStatus(docId), "approved");
  });
});

test("worklistGates surfaces a pending gate to its assignee only", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", docId, actors.submitterId);

    const mine = await worklistGates(org.orgId, actors.approver1Id);
    assert.equal(mine.filter((g) => g.subjectId === docId).length, 1);
    const notMine = await worklistGates(org.orgId, actors.approver2Id);
    assert.equal(notMine.filter((g) => g.subjectId === docId).length, 0);
  });
});

/**
 * Database clock: delegation windows are evaluated by Postgres' now()
 * (delegations.ts), so anchor test windows to it — never to the app clock,
 * which may skew from the database in shared environments.
 */
async function dbNow(): Promise<number> {
  const r = await db.execute<{ now: Date | string }>(sql`select now() as now`, "objects");
  const v = r[0]!.now;
  return (v instanceof Date ? v : new Date(v)).getTime();
}

/** Point a seeded flow's gate node at an escalation target (seed helper has no escalateTo). */
async function setGateEscalateTo(flowId: string, escalateTo: unknown): Promise<void> {
  const r = await db.execute<{
    graph: { nodes: Array<{ id: string; data: { gate?: Record<string, unknown> } }> };
  }>(
    sql`
    select graph from flows where id = ${flowId}`,
    "objects",
  );
  const graph = r[0]!.graph;
  const node = graph.nodes.find((n) => n.id === "gate");
  node!.data.gate!.escalateTo = escalateTo as never;
  await db.execute(
    sql`update flows set graph = ${JSON.stringify(graph)}::jsonb where id = ${flowId}`,
  );
}

test(
  "an escalation excluded by the tenant separation policy leaves the assigned gate actionable",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const { flowId } = await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        preventSelfApproval: true,
      });
      await setGateEscalateTo(flowId, { type: "user", userId: actors.submitterId });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", id, actors.submitterId);
      const [gate] = await gateRows({ subjectId: id });
      assert.equal(await escalateDueGate(gate!.id), false);
      const retained = await gateRows({ subjectId: id });
      assert.equal(retained.length, 1);
      assert.equal(retained[0]?.status, "pending");
      await assert.rejects(
        decideGate({ gateId: gate!.id, decision: "approved", userId: actors.adminId }),
        /not an approver|not assigned/,
      );
      await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id });
      assert.equal(await docStatus(id), "approved");
    });
  },
);

test(
  "explicit self-approval opt-out still lets an escalation reach the submitter",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await grantScratchPermissions(org.orgId, actors.submitterId, ["ap.approve"]);
      const { flowId } = await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        preventSelfApproval: false,
      });
      await setGateEscalateTo(flowId, { type: "user", userId: actors.submitterId });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", docId, actors.submitterId);
      const [gate] = await gateRows({ subjectId: docId });

      assert.equal(await escalateDueGate(gate!.id), true, "escalation fires");
      const replacements = (await gateRows({ subjectId: docId })).filter(
        (g) => g.status === "pending",
      );
      assert.equal(replacements.length, 1);
      assert.equal(
        replacements[0]!.assigneeUserId,
        actors.submitterId,
        "opt-out honors the authored target",
      );

      const decision = await decideGate({
        gateId: replacements[0]!.id,
        decision: "approved",
        userId: actors.submitterId,
      });
      assert.equal(decision.resumed, "approve");
      assert.equal(await docStatus(docId), "approved");
    });
  },
);

test(
  "a delegate who is the submitter still cannot decide (SoD survives delegation)",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", docId, actors.submitterId);
      const [gate] = await gateRows({ subjectId: docId });

      // approver1 hands coverage to the submitter — the grant travels, but the
      // submitter's own separation-of-duties block still applies.
      const now = await dbNow();
      await createDelegation({
        orgId: org.orgId,
        fromUserId: actors.approver1Id,
        toUserId: actors.submitterId,
        startsAt: new Date(now - 3_600_000),
        endsAt: new Date(now + 24 * 3_600_000),
      });

      await assert.rejects(
        decideGate({ gateId: gate!.id, decision: "approved", userId: actors.submitterId }),
        /you cannot approve your own submission/,
        "delegation never raises the submitter above SoD",
      );
      assert.equal(
        (await gateRows({ subjectId: docId }))[0]!.status,
        "pending",
        "gate stays decidable by an eligible approver",
      );
      assert.equal(await docStatus(docId), "pending_approval");
    });
  },
);

test(
  "default SoD excludes maker and submitter and blocks them through delegated authority",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [
          { type: "user", userId: actors.approver1Id },
          { type: "user", userId: actors.submitterId },
          { type: "user", userId: actors.adminId },
        ],
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.approver1Id,
      });
      await submitForApproval("vendor_bill", docId, actors.submitterId);
      const createdGates = await gateRows({ subjectId: docId });
      assert.deepEqual(
        createdGates.map((gate) => gate.assigneeUserId),
        [actors.adminId],
      );

      const gate = createdGates[0]!;
      await db.execute(
        sql`update flow_gates set assignee_user_id = ${actors.submitterId} where id = ${gate.id}`,
      );
      const now = await dbNow();
      await createDelegation({
        orgId: org.orgId,
        fromUserId: actors.submitterId,
        toUserId: actors.approver2Id,
        startsAt: new Date(now - 3_600_000),
        endsAt: new Date(now + 24 * 3_600_000),
      });
      assert.deepEqual(await gateDecisionCapability(gate.id, actors.approver2Id), {
        canAct: false,
        signatureRequired: false,
        sodBlocked: true,
        canDelegate: false,
      });
      await assert.rejects(
        decideGate({ gateId: gate.id, decision: "approved", userId: actors.approver2Id }),
        /you cannot approve your own submission/,
      );

      await assert.rejects(
        delegateGate(gate.id, actors.adminId, actors.approver1Id),
        /cannot be delegated to its submitter or maker/,
      );

      await db.execute(
        sql`update flow_gates set assignee_user_id = ${actors.approver2Id}, delegated_from_user_id = ${actors.approver1Id} where id = ${gate.id}`,
      );
      assert.deepEqual(await gateDecisionCapability(gate.id, actors.approver2Id), {
        canAct: false,
        signatureRequired: false,
        sodBlocked: true,
        canDelegate: true,
      });
    });
  },
);

test(
  "an escalation to the existing assignee does not invent an administrator approval",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const { flowId } = await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "any",
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });
      await setGateEscalateTo(flowId, { type: "user", userId: actors.approver1Id });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", id, actors.submitterId);
      const [gate] = await gateRows({ subjectId: id });
      assert.equal(await escalateDueGate(gate!.id), false);
      const retained = await gateRows({ subjectId: id });
      assert.equal(retained.length, 1);
      assert.equal(retained[0]?.assigneeUserId, actors.approver1Id);
      await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id });
      assert.equal(await docStatus(id), "approved");
    });
  },
);

test(
  "an all-gate escalation honors the frozen target and records the replaced approval lineage",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const { flowId } = await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "all",
        assignees: [
          { type: "user", userId: actors.approver1Id },
          { type: "user", userId: actors.approver2Id },
        ],
      });
      await setGateEscalateTo(flowId, { type: "user", userId: actors.adminId });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitForApproval("vendor_bill", id, actors.submitterId);
      const initial = await gateRows({ subjectId: id }),
        first = initial.find((g) => g.assigneeUserId === actors.approver1Id)!,
        second = initial.find((g) => g.assigneeUserId === actors.approver2Id)!;
      await decideGate({
        gateId: second.id,
        userId: actors.approver2Id,
        decision: "approved",
      });
      assert.equal(await docStatus(id), "pending_approval");
      await setGateEscalateTo(flowId, { type: "user", userId: actors.submitterId });
      assert.equal(await escalateDueGate(first.id), true);
      const replacement = (await gateRows({ subjectId: id })).find((g) => g.status === "pending")!;
      assert.equal(replacement.assigneeUserId, actors.adminId);
      const lineage = (
        await db.execute<{ escalated_from_gate_id: string }>(
          sql`select escalated_from_gate_id from flow_gates where org_id=${org.orgId} and id=${replacement.id}`,
          "objects",
        )
      )[0];
      assert.equal(lineage?.escalated_from_gate_id, first.id);
      await decideGate({
        gateId: replacement.id,
        userId: actors.adminId,
        decision: "approved",
      });
      assert.equal(await docStatus(id), "approved");
      const proof = (
        await db.execute<{ allowed: boolean }>(
          sql`select public.flow_submission_approved(org_id,subject_kind,subject_id,id) as allowed from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
          "objects",
        )
      )[0];
      assert.equal(proof?.allowed, true);
    });
  },
);
