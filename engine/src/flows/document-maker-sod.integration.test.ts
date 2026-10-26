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
  grantScratchPermissions,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import { submitForApproval, submitAndReleaseIfUngated } from "./submit.ts";
import { decideGate, gateDecisionCapability } from "./gates.ts";
import { worklistApprovals } from "./approval-worklist.ts";
import { createDelegation } from "./delegations.ts";

/** Document maker identities remain subject to the tenant's frozen gate policy. */

const DB = !!process.env.OPENBOOKS_DB_URL;

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

async function docRow(id: string): Promise<{
  status: string;
  submittedBy: string | null;
  createdBy: string | null;
}> {
  const r = await db.execute<{
    status: string;
    submittedBy: string | null;
    createdBy: string | null;
  }>(
    sql`
    select status::text as status, submitted_by::text as "submittedBy", created_by::text as "createdBy"
      from documents where id = ${id}`,
    "objects",
  );
  return r[0]!;
}

async function pendingGateFor(subjectId: string, assigneeUserId: string): Promise<string | null> {
  const r = await db.execute<{ id: string }>(
    sql`
    select id from flow_gates
     where subject_id = ${subjectId} and assignee_user_id = ${assigneeUserId} and status = 'pending'
     limit 1`,
    "objects",
  );
  return r[0]?.id ?? null;
}

async function gateStatus(gateId: string): Promise<string | null> {
  const r = await db.execute<{ status: string }>(
    sql`select status::text as status from flow_gates where id = ${gateId}`,
    "objects",
  );
  return r[0]?.status ?? null;
}

test(
  "maker cannot approve their own bill after a third-party submit (routed gate)",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const maker = actors.approver1Id;
      const submitter = actors.submitterId;
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "role", role: "approver" }],
        mode: "any",
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: maker,
      });
      const submitted = await submitForApproval("vendor_bill", docId, submitter);
      assert.equal(submitted.gated, true);
      const routed = await pendingGateFor(docId, actors.approver2Id);
      assert.ok(routed, "the native policy excludes its maker when resolving assignees");
      await db.execute(
        sql`update flow_gates set assignee_user_id=${maker} where org_id=${org.orgId} and id=${routed}`,
      );
      const gateId = await pendingGateFor(docId, maker);
      assert.ok(gateId, "maker holds a pending gate on their own document");

      await assert.rejects(
        decideGate({ gateId: gateId!, decision: "approved", userId: maker }),
        /your own submission/,
        "the maker must not be able to approve their own document",
      );
      // Refusal records nothing: the gate stays pending and the document stays parked.
      assert.equal(await gateStatus(gateId!), "pending");
      assert.equal((await docRow(docId)).status, "pending_approval");
      const audit = (
        await db.execute<{ n: string }>(
          sql`
      select count(*) as n from audit_log
       where org_id = ${org.orgId} and table_name = 'flow_gates' and row_id = ${gateId!}`,
          "objects",
        )
      )[0]!;
      assert.equal(audit.n, "0", "refused decision leaves no audit residue");
      // Truthful attribution is preserved: the submitter is named, not the maker.
      assert.equal((await docRow(docId)).submittedBy, submitter);
      assert.equal((await docRow(docId)).createdBy, maker);
      // The viewer capability agrees with the decision path.
      assert.equal((await gateDecisionCapability(gateId!, maker)).canAct, false);
    });
  },
);

test("submitter cannot approve after a third-party submit (control)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const maker = actors.approver1Id;
    const submitter = actors.submitterId;
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [
        { type: "user", userId: maker },
        { type: "user", userId: submitter },
        { type: "user", userId: actors.approver2Id },
      ],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: maker,
    });
    await submitForApproval("vendor_bill", docId, submitter);
    await grantScratchPermissions(org.orgId, submitter, ["ap.approve"]);
    const routed = await pendingGateFor(docId, actors.approver2Id);
    assert.ok(routed);
    await db.execute(
      sql`update flow_gates set assignee_user_id=${submitter} where org_id=${org.orgId} and id=${routed}`,
    );
    const gateId = await pendingGateFor(docId, submitter);
    assert.ok(gateId);
    await assert.rejects(
      decideGate({
        gateId: gateId!,
        decision: "approved",
        userId: submitter,
      }),
      /your own submission/,
    );
    assert.equal(await gateStatus(gateId!), "pending");
  });
});

test(
  "an independent approver still decides maker/submitter teamwork (control)",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const maker = actors.approver1Id;
      const submitter = actors.submitterId;
      const independent = actors.approver2Id;
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "role", role: "approver" }],
        mode: "any",
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: maker,
      });
      await submitForApproval("vendor_bill", docId, submitter);
      const gateId = await pendingGateFor(docId, independent);
      assert.ok(gateId, "independent approver holds a pending gate");
      const decision = await decideGate({
        gateId: gateId!,
        decision: "approved",
        userId: independent,
      });
      assert.equal(decision.resumed, "approve");
      assert.equal((await docRow(docId)).status, "approved");
    });
  },
);

test(
  "a maker acting as delegate still cannot decide (SoD survives delegation)",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const maker = actors.approver1Id;
      const submitter = actors.submitterId;
      const principal = actors.approver2Id;
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: principal }],
        mode: "any",
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: maker,
      });
      await submitForApproval("vendor_bill", docId, submitter);
      const gateId = await pendingGateFor(docId, principal);
      assert.ok(gateId);
      const now = Date.now();
      await createDelegation({
        orgId: org.orgId,
        fromUserId: principal,
        toUserId: maker,
        startsAt: new Date(now - 3_600_000),
        endsAt: new Date(now + 3_600_000),
      });
      await assert.rejects(
        decideGate({ gateId: gateId!, decision: "approved", userId: maker }),
        /your own submission/,
        "borrowing the principal's grant does not launder the maker's approval",
      );
      assert.equal(await gateStatus(gateId!), "pending");
    });
  },
);

test(
  "explicit self-approval opt-out still permits the maker under the tenant policy",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const maker = actors.approver1Id;
      const submitter = actors.submitterId;
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: maker }],
        mode: "any",
        preventSelfApproval: false,
      });
      const docId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: maker,
      });
      await submitForApproval("vendor_bill", docId, submitter);
      const gateId = await pendingGateFor(docId, maker);
      assert.ok(gateId);
      const decision = await decideGate({
        gateId: gateId!,
        decision: "approved",
        userId: maker,
      });
      assert.equal(decision.resumed, "approve");
      assert.equal((await docRow(docId)).status, "approved");
    });
  },
);

test(
  "zero-gate documents release on submission without a parallel approval item",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.approver1Id,
      });
      const result = await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      assert.equal(result.autoApproved, true);
      assert.equal((await docRow(id)).status, "approved");
      for (const user of [actors.approver1Id, actors.approver2Id, actors.submitterId])
        assert.ok(
          !(await worklistApprovals(org.orgId, user, {})).some(
            (item) => item.gate.subjectId === id,
          ),
        );
    });
  },
);
