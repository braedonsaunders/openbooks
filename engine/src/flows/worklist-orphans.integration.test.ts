import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  worklistApprovals,
  worklistApprovalsCount,
  worklistApprovalsPage,
  type WorklistPageScope,
} from "./approval-worklist.ts";
import { listOrphanedPendingGates } from "./gates.ts";
import {
  assertDedicatedFixtureDatabase,
  createScratchOrg,
  grantScratchPermissions,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { submitForApproval } from "./submit.ts";

/**
 * Orphaned pending gates — a gate that stays `pending` after its run closed
 * or its subject left the decidable state — must leave the worklist rows and
 * the badge count together (one shared predicate), and must surface on the
 * reconciliation readout instead of silently inflating the badge.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;
const SCOPE: WorklistPageScope = { roles: ["approver"], allowedSubsidiaryIds: null };

async function countMatchesList(orgId: string, userId: string): Promise<number> {
  const count = await worklistApprovalsCount(orgId, userId, SCOPE);
  const page = await worklistApprovalsPage(orgId, userId, SCOPE, { limit: 25, offset: 0 });
  assert.equal(count, page.total, "badge count and paged total share one predicate");
  const items = await worklistApprovals(orgId, userId, SCOPE);
  assert.equal(count, items.length, "badge count and full list share one predicate");
  return count;
}

/** Retained orphan evidence keeps the same frozen graph and receipt contract as native submission. */
async function retainedGate(
  orgId: string,
  flowId: string,
  runId: string,
  kind: string,
  subjectId: string,
  actorId: string,
  assigneeId: string,
  title: string,
) {
  const graph = (
    await db.execute<{ graph: unknown }>(
      sql`select graph from flows where org_id=${orgId} and id=${flowId}`,
      "objects",
    )
  )[0]!.graph;
  const policy = {
    version: 1,
    trigger: "on_submit",
    kind: "gated",
    flowIds: [flowId],
    runIds: [runId],
  };
  await db.execute(sql`insert into flow_runs(id,org_id,flow_id,subject_kind,subject_id,trigger,status,created_by,context)
  values(${runId},${orgId},${flowId},${kind},${subjectId},'on_submit','waiting',${actorId},
   ${JSON.stringify({ submissionPolicy: { flowId, graph } })}::jsonb)`);
  await db.execute(sql`insert into flow_gates(id,org_id,flow_id,run_id,node_id,subject_kind,subject_id,title,group_key,quorum,status,assignee_user_id)
  values(${randomUUID()},${orgId},${flowId},${runId},'gate',${kind},${subjectId},${title},${runId + ":gate"},'any','pending',${assigneeId})`);
  await db.execute(sql`insert into flow_submissions(org_id,subject_kind,subject_id,actor_id,policy,context,graphs)
  values(${orgId},${kind},${subjectId},${actorId},${JSON.stringify(policy)}::jsonb,'{}'::jsonb,${JSON.stringify([{ id: flowId, graph }])}::jsonb)`);
}

test(
  "pending gates on closed runs leave the worklist and its count together",
  { skip: !DB },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      const submitted = await submitForApproval("vendor_bill", docId, actors.submitterId);
      assert.equal(submitted.gated, true);
      assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 1);

      // The run closed (failed, superseded, or completed) with the gate still
      // pending: the gate is unactionable and must not count or list.
      await db.execute(sql`update flow_runs set status = 'failed' where org_id = ${org.orgId}`);
      assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 0);
      const orphans = await listOrphanedPendingGates(org.orgId);
      assert.equal(orphans.length, 1, "the closed-run gate is reported for reconciliation");
      assert.equal(orphans[0]?.reason, "run_closed");
      assert.equal(orphans[0]?.subjectId, docId);

      // Reopening the run restores the gate through the same predicate.
      await db.execute(sql`update flow_runs set status = 'waiting' where org_id = ${org.orgId}`);
      assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 1);
      assert.deepEqual(await listOrphanedPendingGates(org.orgId), []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "pending gates on undecided or missing accounting events leave the worklist",
  { skip: !DB },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["assets.manage"]);
      const { flowId } = await seedApprovalFlow(org.orgId, {
        subjectKind: "financial_change",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const changeId = randomUUID();
      const runId = randomUUID();
      await db.execute(sql`
      insert into financial_changes
        (id, org_id, subsidiary_id, domain, subject_id, operation, effective_on, reason,
         idempotency_key, payload, before_state, status, submitted_by, created_by, updated_by)
      values (${changeId}, ${org.orgId}, ${org.subsidiaryId}, 'asset', ${randomUUID()}, 'revaluation',
        '2026-07-15', 'revalue the asset for the test readout', ${`orphan-${changeId}`},
        '{}'::jsonb, '{}'::jsonb, 'draft', ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})`);
      await retainedGate(
        org.orgId,
        flowId,
        runId,
        "financial_change",
        changeId,
        actors.submitterId,
        actors.approver1Id,
        "Asset revaluation",
      );

      // A gate on a draft (never submitted) event cannot be decided.
      assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 0);
      const draftOrphans = await listOrphanedPendingGates(org.orgId);
      assert.equal(draftOrphans.length, 1);
      assert.equal(draftOrphans[0]?.reason, "subject_decided");

      // Submitting the event restores the gate through the same predicate.
      await db.execute(
        sql`update financial_changes set status = 'pending', submission_policy=(select policy from flow_submissions where org_id=${org.orgId} and subject_kind='financial_change' and subject_id=${changeId} order by created_at desc,id desc limit 1) where org_id = ${org.orgId} and id = ${changeId}`,
      );
      assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 1);
      assert.deepEqual(await listOrphanedPendingGates(org.orgId), []);

      // A gate naming an event that no longer exists is missing its subject.
      // (Change rows are immutable evidence, so the event cannot be deleted
      // here — the gate points at an id no row carries, the same shape a
      // removed subject leaves behind.)
      const goneChangeId = randomUUID();
      const goneRunId = randomUUID();
      await retainedGate(
        org.orgId,
        flowId,
        goneRunId,
        "financial_change",
        goneChangeId,
        actors.submitterId,
        actors.approver1Id,
        "Gone event",
      );
      assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 1);
      const missing = await listOrphanedPendingGates(org.orgId);
      assert.equal(missing.length, 1);
      assert.equal(missing[0]?.reason, "subject_missing");
      assert.equal(missing[0]?.subjectId, goneChangeId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("pending gates on deleted documents leave the worklist", { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const missingDocId = randomUUID();
    const runId = randomUUID();
    await retainedGate(
      org.orgId,
      flowId,
      runId,
      "vendor_bill",
      missingDocId,
      actors.submitterId,
      actors.approver1Id,
      "Missing bill",
    );

    assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 0);
    const orphans = await listOrphanedPendingGates(org.orgId);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]?.reason, "subject_missing");
    assert.equal(orphans[0]?.subjectId, missingDocId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
