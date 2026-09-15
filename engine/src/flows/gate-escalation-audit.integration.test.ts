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
import { escalateDueGate } from "./gates.ts";

/**
 * Gate-escalation audit: the scheduler's escalation of an overdue approval
 * flips the gate to escalated and seats replacement approvers — a routing
 * change with no human actor. It must leave a durable system-attributed
 * before/after audit row in the same transaction. A no-op re-escalation must
 * add no evidence.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withEscalatableGate(
  fn: (org: ScratchOrg, actors: FlowActors, gateId: string) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      mode: "any",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    // Point the gate node at the org admin as its escalation target.
    const r = await db.execute<{ graph: { nodes: Array<{ id: string; data: { gate?: Record<string, unknown> } }> } }>(sql`
      select graph from flows where id = ${flowId}`);
    const graph = r.rows[0]!.graph;
    graph.nodes.find((n) => n.id === "gate")!.data.gate!.escalateTo = {
      type: "user",
      userId: actors.adminId,
    } as never;
    await db.execute(sql`update flows set graph = ${JSON.stringify(graph)}::jsonb where id = ${flowId}`);
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

async function escalationAudit(orgId: string, gateId: string) {
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

test("an escalation writes system-attributed before/after audit evidence", { skip: !DB }, async () => {
  await withEscalatableGate(async (org, actors, gateId) => {
    assert.equal(await escalateDueGate(gateId), true, "escalation fires");
    const rows = await escalationAudit(org.orgId, gateId);
    assert.equal(rows.length, 1, "escalation must leave exactly one audit row for the gate");
    assert.equal(rows[0]!.action, "update");
    assert.equal(rows[0]!.actorId, null, "a system transition must not impersonate a human actor");
    const changes = rows[0]!.changes as {
      event: string;
      actor: { kind: string };
      before: { status: string; assigneeUserId: string };
      after: { status: string; replacementAssigneeUserIds: string[] };
    };
    assert.equal(changes.event, "escalated");
    assert.equal(changes.actor.kind, "system");
    assert.equal(changes.before.status, "pending");
    assert.equal(changes.before.assigneeUserId, actors.approver1Id);
    assert.equal(changes.after.status, "escalated");
    assert.ok(
      changes.after.replacementAssigneeUserIds.includes(actors.adminId),
      "evidence must name the seated replacement",
    );
  });
});

test("a no-op re-escalation adds no audit evidence", { skip: !DB }, async () => {
  await withEscalatableGate(async (org, _actors, gateId) => {
    assert.equal(await escalateDueGate(gateId), true, "escalation fires");
    assert.equal(await escalateDueGate(gateId), false, "an escalated gate has nothing to escalate");
    const rows = await escalationAudit(org.orgId, gateId);
    assert.equal(rows.length, 1, "the no-op pass must not add evidence");
  });
});
