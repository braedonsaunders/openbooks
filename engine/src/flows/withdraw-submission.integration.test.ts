import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { decideGate } from "./gates.ts";
import {
  submitForApproval,
  withdrawDocumentSubmission,
  WithdrawSubmissionError,
} from "./submit.ts";

/**
 * Withdraw a pending submission: the submitter (or an approver) recalls a bill
 * still awaiting decision back to draft. Live runs and gates cancel through
 * the Flows engine, the flip is audited with the reason, and a resubmission
 * opens a fresh run. Decided submissions refuse by name.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;
const ZERO = "00000000-0000-0000-0000-000000000000";

async function docStatus(orgId: string, id: string): Promise<string> {
  const rows = await db.execute<{ status: string }>(
    sql`
    select status from documents where id = ${id} and org_id = ${orgId}`,
    "objects",
  );
  return rows[0]!.status;
}

async function runStatus(orgId: string, runId: string): Promise<string> {
  const rows = await db.execute<{ status: string }>(
    sql`
    select status from flow_runs where id = ${runId} and org_id = ${orgId}`,
    "objects",
  );
  return rows[0]!.status;
}

async function gateStatuses(orgId: string, runId: string): Promise<string[]> {
  const rows = await db.execute<{ status: string }>(
    sql`
    select status from flow_gates where run_id = ${runId} and org_id = ${orgId} order by created_at`,
    "objects",
  );
  return rows.map((row) => row.status);
}

async function latestDocumentAudit(orgId: string, id: string) {
  const rows = await db.execute<{
    action: string;
    changes: {
      reason?: unknown;
      mode?: unknown;
      before: { document: Record<string, unknown> };
      after: { document: Record<string, unknown> };
    };
  }>(
    sql`
    select action, changes from audit_log
     where org_id = ${orgId} and table_name = 'documents' and row_id = ${id}
     order by at desc, id desc limit 1`,
    "objects",
  );
  return rows[0]!;
}

async function pendingGateId(orgId: string, billId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from flow_gates where subject_id = ${billId} and org_id = ${orgId} and status = 'pending'`,
    "objects",
  );
  assert.equal(rows.length, 1, `expected one pending gate, got ${rows.length}`);
  return rows[0]!.id;
}

test("a withdrawal reason is required and refused by its own name before any database work", async () => {
  for (const reason of ["", "   ", "no", null, undefined, 42]) {
    await assert.rejects(
      withdrawDocumentSubmission({
        documentId: ZERO,
        orgId: ZERO,
        actorId: null,
        actorIsApprover: false,
        reason,
      }),
      (error: unknown) =>
        error instanceof WithdrawSubmissionError &&
        error.code === "invalid_reason" &&
        error.status === 422 &&
        /withdrawal reason between 5 and 500/.test(error.message),
    );
  }
});

test(
  "the submitter recalls a pending bill to draft with its run and gate cancelled, then resubmits",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const billId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      const submitted = await submitForApproval("vendor_bill", billId, actors.submitterId);
      assert.equal(submitted.gated, true);
      const runId = submitted.runId!;
      assert.equal(await docStatus(org.orgId, billId), "pending_approval");

      const reason = "billed the wrong vendor";
      const withdrawn = await withdrawDocumentSubmission({
        documentId: billId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        actorIsApprover: false,
        reason,
      });
      assert.deepEqual(withdrawn, { status: "draft", cancelledRunIds: [runId] });
      assert.equal(await docStatus(org.orgId, billId), "draft");
      assert.equal(await runStatus(org.orgId, runId), "cancelled");
      assert.deepEqual(await gateStatuses(org.orgId, runId), ["cancelled"]);

      const audit = await latestDocumentAudit(org.orgId, billId);
      assert.equal(audit.action, "update");
      assert.equal(audit.changes.reason, reason);
      assert.equal(audit.changes.before.document.status, "pending_approval");
      assert.equal(audit.changes.after.document.status, "draft");

      const resubmitted = await submitForApproval("vendor_bill", billId, actors.submitterId);
      assert.equal(resubmitted.gated, true);
      assert.ok(resubmitted.runId && resubmitted.runId !== runId, "resubmission opens a fresh run");
      assert.equal(await docStatus(org.orgId, billId), "pending_approval");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a withdrawal by a stranger refuses as forbidden and leaves the submission intact",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const billId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      const runId = (await submitForApproval("vendor_bill", billId, actors.submitterId)).runId!;

      await assert.rejects(
        withdrawDocumentSubmission({
          documentId: billId,
          orgId: org.orgId,
          actorId: actors.outsiderId,
          actorIsApprover: false,
          reason: "not my bill to recall",
        }),
        (error: unknown) =>
          error instanceof WithdrawSubmissionError &&
          error.code === "forbidden" &&
          error.status === 403,
      );
      assert.equal(await docStatus(org.orgId, billId), "pending_approval");
      assert.equal(await runStatus(org.orgId, runId), "waiting");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an approver may withdraw a submission they did not make", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const billId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    const runId = (await submitForApproval("vendor_bill", billId, actors.submitterId)).runId!;

    const withdrawn = await withdrawDocumentSubmission({
      documentId: billId,
      orgId: org.orgId,
      actorId: actors.approver1Id,
      actorIsApprover: true,
      reason: "needs the cost center corrected first",
    });
    assert.deepEqual(withdrawn.cancelledRunIds, [runId]);
    assert.equal(await docStatus(org.orgId, billId), "draft");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a later unrelated run on the bill is neither cancelled nor required for the recall",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const { flowId } = await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const billId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      const runId = (await submitForApproval("vendor_bill", billId, actors.submitterId)).runId!;
      // A scheduled reminder on the same bill that completed after the submission.
      const reminderId = randomUUID();
      await db.execute(sql`
      insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status, context, finished_at, created_by)
      values (${reminderId}, ${org.orgId}, ${flowId}, 'vendor_bill', ${billId}, 'scheduled', 'completed', '{}'::jsonb, now(), null)`);

      const withdrawn = await withdrawDocumentSubmission({
        documentId: billId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        actorIsApprover: false,
        reason: "recalling after the reminder ran",
      });
      assert.deepEqual(withdrawn.cancelledRunIds, [runId]);
      assert.equal(await runStatus(org.orgId, reminderId), "completed");
      assert.equal(await docStatus(org.orgId, billId), "draft");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a decided submission refuses with the return-to-draft remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const billId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitForApproval("vendor_bill", billId, actors.submitterId);
    await decideGate({
      gateId: await pendingGateId(org.orgId, billId),
      decision: "approved",
      userId: actors.approver1Id,
    });
    assert.equal(await docStatus(org.orgId, billId), "approved");

    await assert.rejects(
      withdrawDocumentSubmission({
        documentId: billId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        actorIsApprover: false,
        reason: "changed my mind after approval",
      }),
      (error: unknown) =>
        error instanceof WithdrawSubmissionError && /return it to draft/.test(error.message),
    );
    assert.equal(await docStatus(org.orgId, billId), "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stale drawer revision refuses before any mutation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const billId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    const runId = (await submitForApproval("vendor_bill", billId, actors.submitterId)).runId!;

    await assert.rejects(
      withdrawDocumentSubmission({
        documentId: billId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        actorIsApprover: false,
        reason: "recalling from an old drawer",
        expectedUpdatedAt: "1",
      }),
      (error: unknown) =>
        error instanceof WithdrawSubmissionError &&
        error.status === 409 &&
        error.code === "stale-revision",
    );
    assert.equal(await docStatus(org.orgId, billId), "pending_approval");
    assert.equal(await runStatus(org.orgId, runId), "waiting");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a pending quote is recalled by its submitter through the same withdraw path back to draft",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "quote",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const quoteId = await seedDraftDocument(org.orgId, {
        kind: "quote",
        createdBy: actors.submitterId,
      });
      const submitted = await submitForApproval("quote", quoteId, actors.submitterId);
      assert.equal(submitted.gated, true);
      const runId = submitted.runId!;
      assert.equal(await docStatus(org.orgId, quoteId), "pending_approval");

      const reason = "customer asked for a revised scope";
      const withdrawn = await withdrawDocumentSubmission({
        documentId: quoteId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        actorIsApprover: false,
        reason,
      });
      assert.deepEqual(withdrawn, { status: "draft", cancelledRunIds: [runId] });
      assert.equal(await docStatus(org.orgId, quoteId), "draft");
      assert.equal(await runStatus(org.orgId, runId), "cancelled");
      assert.deepEqual(await gateStatuses(org.orgId, runId), ["cancelled"]);

      const audit = await latestDocumentAudit(org.orgId, quoteId);
      assert.equal(audit.action, "update");
      assert.equal(audit.changes.reason, reason);
      assert.equal(audit.changes.before.document.status, "pending_approval");
      assert.equal(audit.changes.after.document.status, "draft");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
