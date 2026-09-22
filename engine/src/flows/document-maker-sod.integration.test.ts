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
import { decideGate, gateDecisionCapability } from "./gates.ts";
import { decideDocumentApproval, worklistApprovals } from "./approval-worklist.ts";
import { createDelegation } from "./delegations.ts";

/**
 * Maker/submitter separation of duties for documents (PROCUREMENT-2).
 *
 * Authorship never rebinds: after a third-party submit, submitted_by names
 * the submitter, so a submitter-only guard lets the MAKER approve their own
 * record. The decision-time guard excludes BOTH identities under the gate's
 * existing self-approval policy — on the routed gate path, the direct
 * gateless path, the capability probe, the delegated path, and the worklist —
 * while third-party submission itself stays legal and an independent
 * approver keeps deciding (legitimate teamwork is preserved).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withOrgFixture(fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await fn(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function docRow(id: string): Promise<{ status: string; submittedBy: string | null; createdBy: string | null }> {
  const r = (await db.execute<{ status: string; submittedBy: string | null; createdBy: string | null }>(sql`
    select status::text as status, submitted_by::text as "submittedBy", created_by::text as "createdBy"
      from documents where id = ${id}`));
  return r.rows[0]!;
}

async function pendingGateFor(subjectId: string, assigneeUserId: string): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`
    select id from flow_gates
     where subject_id = ${subjectId} and assignee_user_id = ${assigneeUserId} and status = 'pending'
     limit 1`));
  return r.rows[0]?.id ?? null;
}

async function gateStatus(gateId: string): Promise<string | null> {
  const r = (await db.execute<{ status: string }>(sql`select status::text as status from flow_gates where id = ${gateId}`));
  return r.rows[0]?.status ?? null;
}

test("maker cannot approve their own bill after a third-party submit (routed gate)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const maker = actors.approver1Id;
    const submitter = actors.submitterId;
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "role", role: "approver" }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: maker });
    const submitted = await submitForApproval("vendor_bill", docId, submitter);
    assert.equal(submitted.gated, true);
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
    const audit = (await db.execute<{ n: string }>(sql`
      select count(*) as n from audit_log
       where org_id = ${org.orgId} and table_name = 'flow_gates' and row_id = ${gateId!}`)).rows[0]!;
    assert.equal(audit.n, "0", "refused decision leaves no audit residue");
    // Truthful attribution is preserved: the submitter is named, not the maker.
    assert.equal((await docRow(docId)).submittedBy, submitter);
    assert.equal((await docRow(docId)).createdBy, maker);
    // The viewer capability agrees with the decision path.
    assert.equal((await gateDecisionCapability(gateId!, maker)).canAct, false);
  });
});

test("submitter cannot approve after a third-party submit (control)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const maker = actors.approver1Id;
    const submitter = actors.submitterId;
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [
        { type: "user", userId: maker },
        { type: "user", userId: submitter },
      ],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: maker });
    await submitForApproval("vendor_bill", docId, submitter);
    const gateId = await pendingGateFor(docId, submitter);
    assert.ok(gateId);
    await assert.rejects(
      decideGate({ gateId: gateId!, decision: "approved", userId: submitter }),
      /your own submission/,
    );
    assert.equal(await gateStatus(gateId!), "pending");
  });
});

test("an independent approver still decides maker/submitter teamwork (control)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const maker = actors.approver1Id;
    const submitter = actors.submitterId;
    const independent = actors.approver2Id;
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "role", role: "approver" }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: maker });
    await submitForApproval("vendor_bill", docId, submitter);
    const gateId = await pendingGateFor(docId, independent);
    assert.ok(gateId, "independent approver holds a pending gate");
    const decision = await decideGate({ gateId: gateId!, decision: "approved", userId: independent });
    assert.equal(decision.resumed, "approve");
    assert.equal((await docRow(docId)).status, "approved");
  });
});

test("a maker acting as delegate still cannot decide (SoD survives delegation)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const maker = actors.approver1Id;
    const submitter = actors.submitterId;
    const principal = actors.approver2Id;
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: principal }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: maker });
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
});

test("explicit self-approval opt-out still permits the maker (compatibility)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const maker = actors.approver1Id;
    const submitter = actors.submitterId;
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: maker }],
      mode: "any",
      preventSelfApproval: false,
    });
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: maker });
    await submitForApproval("vendor_bill", docId, submitter);
    const gateId = await pendingGateFor(docId, maker);
    assert.ok(gateId);
    const decision = await decideGate({ gateId: gateId!, decision: "approved", userId: maker });
    assert.equal(decision.resumed, "approve");
    assert.equal((await docRow(docId)).status, "approved");
  });
});

test("direct gateless path refuses the maker but serves an independent approver", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const maker = actors.approver1Id;
    const submitter = actors.submitterId;
    const independent = actors.approver2Id;
    // A gateless pending_approval row (migrated/abandoned-run shape): maker
    // authored, someone else submitted, no flow gate routes it.
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: maker });
    await db.execute(sql`
      update documents set status = 'pending_approval', submitted_by = ${submitter}, submitted_at = now()
       where id = ${docId} and org_id = ${org.orgId}`);
    await assert.rejects(
      decideDocumentApproval(org.orgId, docId, maker, "approved"),
      /author cannot approve their own document/,
    );
    assert.equal((await docRow(docId)).status, "pending_approval");
    // The maker's own submission never appears in their actionable worklist…
    const mine = await worklistApprovals(org.orgId, maker, {});
    assert.equal(mine.filter((i) => i.kind === "document" && i.id === docId).length, 0);
    // …but an independent approver sees it and decides it.
    const theirs = await worklistApprovals(org.orgId, independent, {});
    assert.equal(theirs.filter((i) => i.kind === "document" && i.id === docId).length, 1);
    const outcome = await decideDocumentApproval(org.orgId, docId, independent, "approved");
    assert.equal(outcome.status, "approved");
  });
});
