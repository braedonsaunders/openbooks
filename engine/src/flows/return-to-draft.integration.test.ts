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
import { loadDocumentEditCurrent } from "../ledger/document-service.ts";
import { applyDocumentEdit, createDocument } from "../ledger/document-write.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import { decideGate } from "./gates.ts";
import {
  returnDocumentToDraft,
  ReturnToDraftError,
  submitAndReleaseIfUngated,
  submitForApproval,
} from "./submit.ts";

/**
 * Return to draft: an approved, never-posted document corrects through edit
 * and re-approval instead of a void on a record that never touched the GL.
 * The service is kind-agnostic (the approved-status gate decides, never a
 * kind list), audited before/after, and serialized on the document row lock
 * so a concurrent post converges to exactly one outcome.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function docStatus(orgId: string, id: string): Promise<string> {
  const rows = (await db.execute<{ status: string }>(sql`
    select status from documents where id = ${id} and org_id = ${orgId}`)).rows;
  return rows[0]!.status;
}

async function latestDocumentAudit(orgId: string, id: string) {
  const rows = (await db.execute<{ action: string; changes: Record<string, any> }>(sql`
    select action, changes from audit_log
     where org_id = ${orgId} and table_name = 'documents' and row_id = ${id}
     order by at desc, id desc limit 1`)).rows;
  return rows[0]!;
}

/** Pooled scratch orgs can carry settings from an earlier lease: pin the switch OFF. */
async function pinApprovalNotRequired(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb), '{approvals}',
         coalesce(settings->'approvals', '{}'::jsonb) || '{"requireVendorBillApproval": false}'::jsonb,
         true)
     where id = ${orgId}`);
}

async function runStatus(orgId: string, runId: string): Promise<string> {
  const rows = (await db.execute<{ status: string }>(sql`
    select status from flow_runs where id = ${runId} and org_id = ${orgId}`)).rows;
  return rows[0]!.status;
}

test("a return reason is required before any database work", async () => {
  for (const reason of ["", "   ", "no", "abcd", null, undefined, 42]) {
    await assert.rejects(
      returnDocumentToDraft({ documentId: "00000000-0000-0000-0000-000000000000", orgId: "00000000-0000-0000-0000-000000000000", actorId: null, reason }),
      (error: unknown) => error instanceof ReturnToDraftError && /between 5 and 500/.test(error.message),
    );
  }
});

test("an approved bill returns to draft with a before/after audit, edits, and re-approves", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await pinApprovalNotRequired(org.orgId);
    // A native draft with a real line, so the post-return edit exercises the
    // same validation a drawer save runs.
    const body = {
      partyId: org.vendorId,
      documentDate: org.date,
      lines: [{ accountId: org.accounts.cogs, amount: "100" }],
    };
    const created = await createDocument({
      orgId: org.orgId,
      userId: actors.submitterId,
      kind: "vendor_bill",
      key: randomUUID(),
      body,
      subsidiaryId: org.subsidiaryId,
      requestBody: body,
    });
    const billId = created.id;

    const released = await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);
    assert.equal(released.autoApproved, true);
    assert.equal(await docStatus(org.orgId, billId), "approved");

    // An approved document is not editable: the edit gate refuses first.
    const approvedCurrent = (await loadDocumentEditCurrent(billId, org.orgId))!;
    await assert.rejects(
      applyDocumentEdit(billId, approvedCurrent, {}, { orgId: org.orgId, userId: actors.submitterId, source: "ui", runFlows: false }),
      (error: unknown) => error instanceof DocumentEditError && /cannot be edited/.test(error.message),
    );

    const reason = "approved the wrong bill batch — amounts belong to next week";
    const revision = approvedCurrent.updatedAt;
    const returned = await returnDocumentToDraft({
      documentId: billId,
      orgId: org.orgId,
      actorId: actors.approver1Id,
      reason,
      expectedUpdatedAt: revision,
    });
    assert.deepEqual(returned, { status: "draft", supersededRunIds: [], cancelledRunIds: [] });
    assert.equal(await docStatus(org.orgId, billId), "draft");

    const audit = await latestDocumentAudit(org.orgId, billId);
    assert.equal(audit.action, "update");
    assert.equal(audit.changes.mode, "record_update");
    assert.equal(audit.changes.reason, reason);
    assert.equal(audit.changes.before.document.status, "approved");
    assert.equal(audit.changes.after.document.status, "draft");

    // The returned draft edits through the native edit path …
    const draftCurrent = (await loadDocumentEditCurrent(billId, org.orgId))!;
    await applyDocumentEdit(
      billId,
      draftCurrent,
      { expectedUpdatedAt: draftCurrent.updatedAt, memo: "corrected week" },
      { orgId: org.orgId, userId: actors.submitterId, source: "ui", runFlows: false },
    );

    // … and re-approves through the native release.
    const rereleased = await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);
    assert.equal(rereleased.autoApproved, true);
    assert.equal(await docStatus(org.orgId, billId), "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a flow-governed bill keeps its completed run as history and resubmits into a new run", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const billId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });

    const first = await submitForApproval("vendor_bill", billId);
    assert.equal(first.gated, true);
    const firstRunId = first.runId!;
    const gates = (await db.execute<{ id: string }>(sql`
      select id from flow_gates where subject_id = ${billId} and org_id = ${org.orgId}`)).rows;
    await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: actors.approver1Id });
    assert.equal(await docStatus(org.orgId, billId), "approved");
    assert.equal(await runStatus(org.orgId, firstRunId), "completed");

    const returned = await returnDocumentToDraft({
      documentId: billId,
      orgId: org.orgId,
      actorId: actors.approver1Id,
      reason: "wrong cost center on every line",
    });
    assert.deepEqual(returned.supersededRunIds, [firstRunId]);
    // Completed approval evidence stays as history — never deleted.
    assert.equal(await runStatus(org.orgId, firstRunId), "completed");

    // Resubmission starts a new run: the returned document must be re-approved.
    const second = await submitForApproval("vendor_bill", billId, actors.submitterId);
    assert.equal(second.gated, true);
    assert.ok(second.runId && second.runId !== firstRunId, "resubmission opens a fresh run");
    assert.equal(await docStatus(org.orgId, billId), "pending_approval");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("non-approved documents refuse with a named remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await pinApprovalNotRequired(org.orgId);
    const billId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });

    await assert.rejects(
      returnDocumentToDraft({ documentId: billId, orgId: org.orgId, actorId: actors.submitterId, reason: "mistake in the batch" }),
      (error: unknown) => error instanceof ReturnToDraftError && /already a draft/.test(error.message),
    );

    await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);
    await db.execute(sql`update documents set status = 'posted' where id = ${billId} and org_id = ${org.orgId}`);
    await assert.rejects(
      returnDocumentToDraft({ documentId: billId, orgId: org.orgId, actorId: actors.submitterId, reason: "mistake in the batch" }),
      (error: unknown) => error instanceof ReturnToDraftError && /void it or post a correction/.test(error.message),
    );

    await db.execute(sql`update documents set status = 'voided' where id = ${billId} and org_id = ${org.orgId}`);
    await assert.rejects(
      returnDocumentToDraft({ documentId: billId, orgId: org.orgId, actorId: actors.submitterId, reason: "mistake in the batch" }),
      (error: unknown) => error instanceof ReturnToDraftError && /terminal/.test(error.message),
    );
    assert.equal(await docStatus(org.orgId, billId), "voided");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stale drawer revision refuses before any mutation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await pinApprovalNotRequired(org.orgId);
    const billId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);

    await assert.rejects(
      returnDocumentToDraft({ documentId: billId, orgId: org.orgId, actorId: actors.submitterId, reason: "mistake in the batch", expectedUpdatedAt: "1" }),
      (error: unknown) => error instanceof ReturnToDraftError && error.status === 409 && /changed after you opened it/.test(error.message),
    );
    assert.equal(await docStatus(org.orgId, billId), "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a concurrent post and return converge to exactly one outcome", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await pinApprovalNotRequired(org.orgId);
    const billId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);

    // The post side mirrors the posting precondition (approved-only flip);
    // the row lock serializes the two writers, so exactly one can win.
    const posting = db.execute<{ id: string }>(sql`
      update documents set status = 'posted', updated_at = now()
       where id = ${billId} and org_id = ${org.orgId} and status = 'approved'
      returning id`);
    const returning = returnDocumentToDraft({
      documentId: billId,
      orgId: org.orgId,
      actorId: actors.approver1Id,
      reason: "racing a same-moment post",
    });
    const [posted, returnedOutcome] = await Promise.allSettled([posting, returning]);

    const postWon = posted.status === "fulfilled" && posted.value.rows.length === 1;
    const returnWon = returnedOutcome.status === "fulfilled";
    assert.ok(postWon !== returnWon, "exactly one of the post and the return commits");
    if (postWon) {
      assert.match(String((returnedOutcome as PromiseRejectedResult).reason?.message ?? returnedOutcome), /already posted/);
      assert.equal(await docStatus(org.orgId, billId), "posted");
    } else {
      assert.equal((posted as PromiseFulfilledResult<{ rows: unknown[] }>).value.rows.length, 0);
      assert.equal(await docStatus(org.orgId, billId), "draft");
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
