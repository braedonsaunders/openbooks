import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  seedDraftDocument,
  type ScratchOrg,
  type FlowActors,
} from "../test-fixtures.ts";
import { submitForApproval } from "./submit.ts";
import { decideGate, delegateGate, worklistGates } from "./gates.ts";
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
  const r = (await db.execute(sql`select status from documents where id = ${id}`)) as unknown as {
    rows: { status: string }[];
  };
  return r.rows[0]?.status ?? null;
}

async function gateRows(runOrSubject: { subjectId: string }): Promise<{ id: string; status: string; assigneeUserId: string | null }[]> {
  const r = (await db.execute(sql`
    select id, status, assignee_user_id as "assigneeUserId"
      from flow_gates where subject_id = ${runOrSubject.subjectId} order by created_at
  `)) as unknown as { rows: { id: string; status: string; assigneeUserId: string | null }[] };
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
  const r = (await db.execute(sql`
    select assignee_user_id as "assigneeUserId", decided_by as "decidedBy",
           delegated_from_user_id as "delegatedFromUserId", on_behalf_of_user_id as "onBehalfOfUserId"
      from flow_gates where id = ${id}
  `)) as unknown as { rows: any[] };
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
    const now = Date.now();
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
