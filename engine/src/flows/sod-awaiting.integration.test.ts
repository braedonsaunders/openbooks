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
import { gateDecisionCapability } from "./gates.ts";
import {
  worklistGatesAwaitingAnotherApprover,
} from "./approval-worklist.ts";
import { flowsApprovalAdapter } from "../inbox/adapters/flows-approval.ts";

/**
 * Separation of duties resolved IN ADVANCE on Flow gates.
 *
 * When a gate's prevent-self-approval excludes the viewer as
 * submitter/maker, every surface renders "Awaiting another approver" with
 * no decision actions — resolved through the same native gate check the
 * decide path enforces — instead of offering Approve and refusing on
 * click. An independent approver on the same gate keeps deciding, and the
 * awaiting set counts separately from actionable items.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withOwnSubmissionFixture(
  fn: (org: ScratchOrg, actors: FlowActors, docId: string, gateId: string) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const maker = actors.approver1Id;
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "role", role: "approver" }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: maker });
    const submitted = await submitForApproval("vendor_bill", docId, maker);
    assert.equal(submitted.gated, true, "the maker's own submission must route a gate");
    const gateId = (await db.execute<{ id: string }>(sql`
      select id from flow_gates
       where subject_id = ${docId} and assignee_user_id = ${maker} and status = 'pending'
       limit 1`)).rows[0]?.id;
    assert.ok(gateId, "the maker holds a pending gate on their own document");
    await fn(org, actors, docId, gateId!);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function pendingGateForUser(orgId: string, docId: string, userId: string): Promise<string | null> {
  const rows = (await db.execute<{ id: string }>(sql`
    select g.id from flow_gates g
     where g.subject_id = ${docId} and g.status = 'pending'
       and (g.assignee_user_id = ${userId} or g.assignee_role in (
         select r.key from role_assignments ra join app_roles r on r.id = ra.role_id
          where ra.org_id = ${orgId} and ra.user_id = ${userId}))
     limit 1`)).rows;
  return rows[0]?.id ?? null;
}

test("the native gate check names the SoD denial in advance", { skip: !DB }, async () => {
  await withOwnSubmissionFixture(async (org, actors, docId, gateId) => {
    const maker = actors.approver1Id;
    const other = actors.approver2Id;
    const makerCap = await gateDecisionCapability(gateId, maker);
    assert.equal(makerCap.canAct, false);
    assert.equal(makerCap.sodBlocked, true, "the maker is SoD-blocked, not merely unassigned");
    const otherGateId = await pendingGateForUser(org.orgId, docId, other);
    assert.ok(otherGateId, "the independent approver holds a gate on the same document");
    const otherCap = await gateDecisionCapability(otherGateId!, other);
    assert.equal(otherCap.canAct, true, "an independent approver keeps deciding");
    assert.equal(otherCap.sodBlocked, false);
  });
});

test("the awaiting set holds exactly the SoD-blocked gates", { skip: !DB }, async () => {
  await withOwnSubmissionFixture(async (org, actors, _docId, gateId) => {
    const maker = actors.approver1Id;
    const other = actors.approver2Id;
    assert.deepEqual(
      await worklistGatesAwaitingAnotherApprover(org.orgId, maker, ["approver"]),
      [gateId],
      "the maker's own gate awaits another approver",
    );
    assert.deepEqual(
      await worklistGatesAwaitingAnotherApprover(org.orgId, other, ["approver"]),
      [],
      "the independent approver has nothing awaiting another",
    );
  });
});

test("the inbox leg renders awaiting without actions, actionable with Approve", { skip: !DB }, async () => {
  await withOwnSubmissionFixture(async (org, actors, docId, gateId) => {
    const maker = actors.approver1Id;
    const other = actors.approver2Id;
    const asOf = new Date().toISOString();
    const makerItems = (await flowsApprovalAdapter.list!({
      orgId: org.orgId, actorId: maker, asOf,
      scope: { roles: ["approver"] },
    })).filter((item) => item.source.id === gateId);
    assert.equal(makerItems.length, 1, "the maker's gate still lists (it awaits, it is not hidden)");
    assert.deepEqual(makerItems[0]!.actions, [], "no decision action is offered to the blocked viewer");
    assert.match(makerItems[0]!.subtitle ?? "", /^Awaiting another approver/, "the item names the outcome in advance");
    void docId;
    const otherGateId = await pendingGateForUser(org.orgId, docId, other);
    assert.ok(otherGateId, "the independent approver holds a gate on the same document");
    const otherItems = (await flowsApprovalAdapter.list!({
      orgId: org.orgId, actorId: other, asOf,
      scope: { roles: ["approver"] },
    })).filter((item) => item.source.id === otherGateId);
    assert.equal(otherItems.length, 1);
    assert.ok(
      otherItems[0]!.actions.some((action) => action.key === "approve"),
      "the independent approver is still offered Approve through the same path",
    );
  });
});
