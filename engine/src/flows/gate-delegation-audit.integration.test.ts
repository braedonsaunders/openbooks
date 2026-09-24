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
import { delegateGate } from "./gates.ts";

/**
 * Gate-delegation audit: reassigning a pending approval changes who may
 * release its financial document, so every hand-off must leave a durable
 * actor-attributed before/after audit row (prior assignee → new assignee) in
 * the same transaction as the reassignment. A refused delegation must add no
 * evidence.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withPendingGate(
  fn: (org: ScratchOrg, actors: FlowActors, gateId: string) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    const res = await submitForApproval("vendor_bill", docId);
    assert.equal(res.gated, true, "submit created a gate");
    const gate = (
      await db.execute<{ id: string }>(sql`
        select id from flow_gates where subject_id = ${docId} order by created_at
      `)
    ).rows[0]!.id;
    await fn(org, actors, gate);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function delegationAudit(orgId: string, gateId: string) {
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

test("delegating a gate writes actor-attributed before/after assignee evidence", { skip: !DB }, async () => {
  await withPendingGate(async (org, actors, gateId) => {
    await delegateGate(gateId, actors.approver1Id, actors.approver2Id);
    const rows = await delegationAudit(org.orgId, gateId);
    assert.equal(rows.length, 1, "delegation must leave exactly one audit row for the gate");
    assert.equal(rows[0]!.action, "update");
    assert.equal(rows[0]!.actorId, actors.approver1Id);
    const changes = rows[0]!.changes as {
      event: string;
      actor: { kind: string; userId: string };
      before: { assigneeUserId: string };
      after: { assigneeUserId: string };
    };
    assert.equal(changes.event, "delegated");
    assert.deepEqual(changes.actor, { kind: "user", userId: actors.approver1Id });
    assert.equal(changes.before.assigneeUserId, actors.approver1Id);
    assert.equal(changes.after.assigneeUserId, actors.approver2Id);
  });
});

test("a refused delegation leaves no audit evidence behind", { skip: !DB }, async () => {
  await withPendingGate(async (org, actors, gateId) => {
    // An outsider who is neither assignee nor admin cannot delegate.
    await assert.rejects(delegateGate(gateId, actors.outsiderId, actors.approver2Id));
    const rows = await delegationAudit(org.orgId, gateId);
    assert.equal(rows.length, 0, "the refused delegation must not leave evidence");
  });
});

test("a delegation handover note reaches the audit row and the delegate notice (B-INB-1/B3-INB-01)", { skip: !DB }, async () => {
  await withPendingGate(async (org, actors, gateId) => {
    const note = "Covering my on-call week — the vendor bill is already matched";
    await delegateGate(gateId, actors.approver1Id, actors.approver2Id, undefined, note);
    const rows = await delegationAudit(org.orgId, gateId);
    assert.equal(rows.length, 1);
    const changes = rows[0]!.changes as { after: { handoverNote: string | null } };
    assert.equal(changes.after.handoverNote, note);
    const notices = (
      await db.execute<{ body: string | null }>(sql`
        select body from notifications
         where org_id = ${org.orgId} and user_id = ${actors.approver2Id}
         order by created_at desc limit 1
      `)
    ).rows;
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.body, note);
  });
});

test("a delegation without a note records a null handover, not an empty string", { skip: !DB }, async () => {
  await withPendingGate(async (org, actors, gateId) => {
    await delegateGate(gateId, actors.approver1Id, actors.approver2Id, undefined, "");
    const rows = await delegationAudit(org.orgId, gateId);
    assert.equal(rows.length, 1);
    const changes = rows[0]!.changes as { after: { handoverNote: string | null } };
    assert.equal(changes.after.handoverNote, null);
  });
});
