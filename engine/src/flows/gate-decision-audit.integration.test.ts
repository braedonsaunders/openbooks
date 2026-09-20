import { test } from "node:test";
import assert from "node:assert/strict";
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
import { decideGate } from "./gates.ts";

/**
 * Gate-decision audit: approving or rejecting a flow gate releases or returns
 * a financial document, so every decision must leave a durable
 * actor-attributed before/after audit row (with the decision reason and any
 * delegation provenance) in the same transaction as the flip. A refused
 * second decision must add no evidence.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withGatedDocument(
  fn: (org: ScratchOrg, actors: FlowActors, docId: string, gateId: string) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    const res = await submitForApproval("vendor_bill", docId);
    assert.equal(res.gated, true, "submit created a gate");
    const gate = (
      await db.execute<{ id: string }>(sql`
        select id from flow_gates where subject_id = ${docId} order by created_at
      `)
    ).rows[0]!.id;
    await fn(org, actors, docId, gate);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function decisionAudit(orgId: string, gateId: string) {
  return (
    await db.execute(sql`
      select action, actor_id as "actorId", changes
        from audit_log
       where org_id = ${orgId}
         and table_name = 'flow_gates'
         and row_id = ${gateId}
       order by at, id
    `)
  ).rows;
}

test("an approval decision writes actor-attributed before/after audit evidence", { skip: !DB }, async () => {
  await withGatedDocument(async (org, actors, _docId, gateId) => {
    const decision = await decideGate({ gateId, decision: "approved", userId: actors.approver1Id });
    assert.equal(decision.resumed, "approve");
    const rows = await decisionAudit(org.orgId, gateId);
    assert.equal(rows.length, 1, "approval must leave exactly one audit row for the gate");
    assert.equal(rows[0]!.action, "update");
    assert.equal(rows[0]!.actorId, actors.approver1Id);
    const changes = rows[0]!.changes as {
      event: string;
      actor: { kind: string; userId: string };
      before: { status: string };
      after: { status: string };
      subjectId: string;
    };
    assert.equal(changes.event, "approved");
    assert.deepEqual(changes.actor, { kind: "user", userId: actors.approver1Id });
    assert.equal(changes.before.status, "pending");
    assert.equal(changes.after.status, "approved");
    assert.equal(changes.subjectId, _docId);
  });
});

test("a rejection decision records the reason, and a refused re-decision adds nothing", { skip: !DB }, async () => {
  await withGatedDocument(async (org, actors, _docId, gateId) => {
    const decision = await decideGate({
      gateId,
      decision: "rejected",
      userId: actors.approver1Id,
      comment: "over budget",
    });
    assert.equal(decision.resumed, "reject");
    const rows = await decisionAudit(org.orgId, gateId);
    assert.equal(rows.length, 1, "rejection must leave exactly one audit row for the gate");
    assert.equal(rows[0]!.actorId, actors.approver1Id);
    const changes = rows[0]!.changes as {
      event: string;
      before: { status: string };
      after: { status: string };
      reason: string;
    };
    assert.equal(changes.event, "rejected");
    assert.equal(changes.before.status, "pending");
    assert.equal(changes.after.status, "rejected");
    assert.equal(changes.reason, "over budget");
    await assert.rejects(decideGate({ gateId, decision: "approved", userId: actors.approver1Id }));
    assert.equal(
      (await decisionAudit(org.orgId, gateId)).length,
      1,
      "the refused second decision must not add evidence",
    );
  });
});
