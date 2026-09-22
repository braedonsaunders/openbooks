import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  seedDraftDocument,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import { submitForApproval } from "./submit.ts";
import { retryFlowRun } from "./run.ts";
import { decideGate, delegateGate, escalateDueGate, worklistGates } from "./gates.ts";
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
  const r = (await db.execute<{ status: string }>(sql`select status from documents where id = ${id}`));
  return r.rows[0]?.status ?? null;
}

async function gateRows(runOrSubject: { subjectId: string }): Promise<{ id: string; status: string; assigneeUserId: string | null }[]> {
  const r = (await db.execute<{ id: string; status: string; assigneeUserId: string | null }>(sql`
    select id, status, assignee_user_id as "assigneeUserId"
      from flow_gates where subject_id = ${runOrSubject.subjectId} order by created_at
  `));
  return r.rows;
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

test("engine releases the document to approved with NO authored change_status (single approver)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });

    const res = await submitForApproval("vendor_bill", docId);
    assert.equal(res.gated, true, "submit created a gate");
    assert.equal(res.flowError, null);
    assert.equal(await docStatus(docId), "pending_approval");

    const gates = await gateRows({ subjectId: docId });
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.status, "pending");

    const decision = await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: actors.approver1Id });
    assert.equal(decision.resumed, "approve");
    assert.equal(decision.runStatus, "completed");
    // The engine released it — even though the flow has no change_status node.
    assert.equal(await docStatus(docId), "approved");
  });
});

test("reject returns the document to draft (engine-enforced)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    const decision = await decideGate({ gateId: gate!.id, decision: "rejected", userId: actors.approver1Id, comment: "over budget" });
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
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const gates = await gateRows({ subjectId: docId });
    assert.equal(gates.length, 2, "one gate row per approver");

    const first = gates.find((g) => g.assigneeUserId === actors.approver1Id)!;
    const second = gates.find((g) => g.assigneeUserId === actors.approver2Id)!;

    const d1 = await decideGate({ gateId: first.id, decision: "approved", userId: actors.approver1Id });
    assert.equal(d1.resumed, null, "still waiting on the second approver");
    assert.equal(await docStatus(docId), "pending_approval");

    const d2 = await decideGate({ gateId: second.id, decision: "approved", userId: actors.approver2Id });
    assert.equal(d2.resumed, "approve");
    assert.equal(await docStatus(docId), "approved");
  });
});

test("quorum 'any' releases on the first approval and cancels the sibling", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [
        { type: "user", userId: actors.approver1Id },
        { type: "user", userId: actors.approver2Id },
      ],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const gates = await gateRows({ subjectId: docId });
    const first = gates.find((g) => g.assigneeUserId === actors.approver1Id)!;

    await decideGate({ gateId: first.id, decision: "approved", userId: actors.approver1Id });
    assert.equal(await docStatus(docId), "approved");
    const after = await gateRows({ subjectId: docId });
    assert.equal(after.find((g) => g.assigneeUserId === actors.approver1Id)!.status, "approved");
    assert.equal(after.find((g) => g.assigneeUserId === actors.approver2Id)!.status, "cancelled");
  });
});

test("submit FAILS CLOSED when an enabled flow has an invalid graph", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    // Raw SQL bypasses the validated flow writer: the stored graph cannot parse.
    await db.execute(sql`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${randomUUID()}, ${org.orgId}, 'Broken flow', 'vendor_bill', true, ${JSON.stringify({ nodes: "not-an-array" })}::jsonb)`);
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });

    const res = await submitForApproval("vendor_bill", docId);
    assert.equal(res.gated, false, "an unparseable flow must never read as approval granted");
    assert.ok(res.flowError, "a flowError is surfaced so the caller fails closed");
    assert.equal(await docStatus(docId), "draft");
    const gates = await gateRows({ subjectId: docId });
    assert.equal(gates.length, 0, "no gate may dangle from a refused dispatch");
    // The failure is recorded on its own failed run row, so fixing the graph
    // unblocks the retry path instead of stranding the subject.
    const runs = (await db.execute<{ status: string; error: string | null }>(sql`
      select status, error from flow_runs where subject_id = ${docId}`)).rows;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "failed");
    assert.match(runs[0]!.error ?? "", /Broken flow/);
  });
});

test("submit FAILS CLOSED when the approval flow resolves to zero approvers", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    // A role with no members → createGate throws → run failed → gatesCreated 0.
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "role", role: "nonexistent_role" }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });

    const res = await submitForApproval("vendor_bill", docId);
    assert.equal(res.gated, false);
    assert.ok(res.flowError, "a flowError is surfaced so the caller fails closed");
    // The document must NOT have been auto-approved — it stays draft.
    assert.equal(await docStatus(docId), "draft");
  });
});

/** F-t04-004: a run that failed on a zero-assignee gate strands its subject
 * with no path forward. Retrying the failed run after the gate becomes
 * satisfiable must re-resolve assignees live and park the run at a gate —
 * the same run row. Once the run leaves failed, further retries are refused
 * (pinned by the test below), so a retry can never double-fan-out gates. */
test("a failed run can be retried once its gate resolves", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "role", role: "nonexistent_role" }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });

    const submit = await submitForApproval("vendor_bill", docId);
    assert.ok(submit.flowError, "the zero-assignee submit must fail its run");
    const failedRun = (await db.execute<{ id: string }>(sql`
      select id from flow_runs where subject_id = ${docId} and status = 'failed' order by started_at desc limit 1
    `)).rows[0];
    assert.ok(failedRun, "the failed run must be recorded");

    // The tenant fixes the gate (the QA story: granting the Approver role).
    await db.execute(sql`
      update flows set graph = jsonb_set(graph, '{nodes,1,data,gate,assignees}',
        ${JSON.stringify([{ type: "user", userId: actors.approver1Id }])}::jsonb)
       where org_id = ${org.orgId} and subject_kind = 'vendor_bill'`);

    const retried = await retryFlowRun(failedRun.id, { orgId: org.orgId, userId: actors.submitterId });
    assert.equal(retried.runId, failedRun.id, "a retry re-drives the same run row");
    assert.equal(retried.status, "waiting", "the retried run must park at the now-satisfiable gate");
    assert.equal(retried.gatesCreated, 1);
    const gates = await gateRows({ subjectId: docId });
    assert.equal(gates.length, 1, "exactly one live gate must exist after the retry");
    assert.equal(gates[0]!.assigneeUserId, actors.approver1Id);
    // Submit parity: a retry that gates must park the subject awaiting
    // approval, or the engine-enforced (pending_approval-only) release no-ops.
    assert.equal(await docStatus(docId), "pending_approval");

    // The approval now completes through the retried run.
    const decision = await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: actors.approver1Id });
    assert.equal(decision.runStatus, "completed");
    assert.equal(await docStatus(docId), "approved");
  });
});

test("retrying a non-failed run is refused", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const waitingRun = (await db.execute<{ id: string }>(sql`
      select id from flow_runs where subject_id = ${docId} and status = 'waiting' order by started_at desc limit 1
    `)).rows[0];
    assert.ok(waitingRun, "a waiting run must exist");
    await assert.rejects(
      retryFlowRun(waitingRun.id, { orgId: org.orgId, userId: actors.submitterId }),
      /only a failed run can be retried/,
    );
  });
});

test("the submitter cannot approve their own document (secure by default)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    // Gate directly assigned to the submitter, no preventSelfApproval flag.
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.submitterId }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    await assert.rejects(
      () => decideGate({ gateId: gate!.id, decision: "approved", userId: actors.submitterId }),
      /your own submission/,
    );
    assert.equal(await docStatus(docId), "pending_approval", "still gated, not self-approved");
  });
});

test("an admin still cannot approve a document they submitted", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    // Gate assigned to a role the admin holds; the admin is also the submitter.
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.adminId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    // Admin (not the assignee, but privileged) is the submitter → refused.
    await assert.rejects(
      () => decideGate({ gateId: gate!.id, decision: "approved", userId: actors.adminId }),
      /your own submission/,
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
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    await assert.rejects(
      () => decideGate({ gateId: gate!.id, decision: "approved", userId: actors.outsiderId }),
      /not an approver/,
    );
  });
});

test("a deactivated approver cannot decide, even through a live one-click link", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    // The approver is deactivated after the gate (and its email link) went
    // out. The decision call below is exactly what the sessionless
    // email-action route issues: gate + decision + the bound assignee id.
    await db.execute(sql`update users set is_active = false where id = ${actors.approver1Id} and org_id = ${org.orgId}`);
    await assert.rejects(
      () => decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id }),
      /not an approver/,
    );
    assert.equal(await docStatus(docId), "pending_approval", "still gated, not decided by a deactivated user");
  });
});

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
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
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
  const r = (await db.execute<{
    assigneeUserId: string | null;
    decidedBy: string | null;
    delegatedFromUserId: string | null;
    onBehalfOfUserId: string | null;
  }>(sql`
    select assignee_user_id as "assigneeUserId", decided_by as "decidedBy",
           delegated_from_user_id as "delegatedFromUserId", on_behalf_of_user_id as "onBehalfOfUserId"
      from flow_gates where id = ${id}
  `));
  return r.rows[0]!;
}

test("delegateGate reassigns and records structured provenance (not a comment)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    await delegateGate(gate!.id, actors.approver1Id, actors.approver2Id);
    let prov = await gateProvenance(gate!.id);
    assert.equal(prov.assigneeUserId, actors.approver2Id, "reassigned to the delegate");
    assert.equal(prov.delegatedFromUserId, actors.approver1Id, "original assignee preserved structurally");

    // The delegate decides; provenance survives the decision.
    await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver2Id });
    prov = await gateProvenance(gate!.id);
    assert.equal(prov.decidedBy, actors.approver2Id);
    assert.equal(prov.delegatedFromUserId, actors.approver1Id, "hand-off audit not overwritten by the decision");
    assert.equal(await docStatus(docId), "approved");
  });
});

test("an out-of-office delegate decides on behalf of the principal", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
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

    const res = await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver2Id });
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
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);

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
  const r = (await db.execute<{ now: Date | string }>(sql`select now() as now`));
  const v = r.rows[0]!.now;
  return (v instanceof Date ? v : new Date(v)).getTime();
}

/** Point a seeded flow's gate node at an escalation target (seed helper has no escalateTo). */
async function setGateEscalateTo(flowId: string, escalateTo: unknown): Promise<void> {
  const r = (await db.execute<{ graph: { nodes: Array<{ id: string; data: { gate?: Record<string, unknown> } }> } }>(sql`
    select graph from flows where id = ${flowId}`));
  const graph = r.rows[0]!.graph;
  const node = graph.nodes.find((n) => n.id === "gate");
  node!.data.gate!.escalateTo = escalateTo as never;
  await db.execute(sql`update flows set graph = ${JSON.stringify(graph)}::jsonb where id = ${flowId}`);
}

test("escalation skips the submitter (SoD) and falls through to an eligible approver", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    // Escalation aimed at the submitter — who could never decide their own
    // gate. Scratch actors have no supervisor chain, so the eligible fallback
    // is the org admin.
    await setGateEscalateTo(flowId, { type: "user", userId: actors.submitterId });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    assert.equal(await escalateDueGate(gate!.id), true, "escalation fires");
    const after = await gateRows({ subjectId: docId });
    assert.equal(after.find((g) => g.id === gate!.id)!.status, "escalated");
    const replacements = after.filter((g) => g.status === "pending");
    assert.equal(replacements.length, 1, "exactly one live replacement");
    assert.notEqual(replacements[0]!.assigneeUserId, actors.submitterId, "never stranded on the submitter");
    assert.equal(replacements[0]!.assigneeUserId, actors.adminId, "falls through to the admin");

    // The eligible replacement decides; the run completes instead of stranding.
    const decision = await decideGate({ gateId: replacements[0]!.id, decision: "approved", userId: actors.adminId });
    assert.equal(decision.resumed, "approve");
    assert.equal(await docStatus(docId), "approved");
  });
});

test("explicit self-approval opt-out still lets an escalation reach the submitter", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      preventSelfApproval: false,
    });
    await setGateEscalateTo(flowId, { type: "user", userId: actors.submitterId });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
    const [gate] = await gateRows({ subjectId: docId });

    assert.equal(await escalateDueGate(gate!.id), true, "escalation fires");
    const replacements = (await gateRows({ subjectId: docId })).filter((g) => g.status === "pending");
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0]!.assigneeUserId, actors.submitterId, "opt-out honors the authored target");

    const decision = await decideGate({ gateId: replacements[0]!.id, decision: "approved", userId: actors.submitterId });
    assert.equal(decision.resumed, "approve");
    assert.equal(await docStatus(docId), "approved");
  });
});

test("a delegate who is the submitter still cannot decide (SoD survives delegation)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", docId);
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
    assert.equal((await gateRows({ subjectId: docId }))[0]!.status, "pending", "gate stays decidable by an eligible approver");
    assert.equal(await docStatus(docId), "pending_approval");
  });
});


test("escalation skips its current assignee before falling through to admins", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill", mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    await setGateEscalateTo(flowId, {type:"user",userId:actors.approver1Id});
    const docId=await seedDraftDocument(org.orgId,{kind:"vendor_bill",createdBy:actors.submitterId});
    await submitForApproval("vendor_bill",docId);
    const [gate]=await gateRows({subjectId:docId});
    assert.equal(await escalateDueGate(gate!.id),true);
    const replacement=(await gateRows({subjectId:docId})).find(g=>g.status==='pending');
    assert.equal(replacement?.assigneeUserId,actors.adminId);
    await decideGate({gateId:replacement!.id,decision:'approved',userId:actors.adminId});
    assert.equal(await docStatus(docId),'approved');
  });
});
