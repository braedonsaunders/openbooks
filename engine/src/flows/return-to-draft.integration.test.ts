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
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { loadDocumentEditCurrent } from "../ledger/document-service.ts";
import { applyDocumentEdit, createDocument } from "../ledger/document-write.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
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

async function seedReturnActors(orgId: string) {
  const actors = await seedFlowActors(orgId);
  await grantScratchPermissions(orgId, actors.approver1Id, ["ap.post"]);
  return actors;
}

test(
  "returning an approved document to draft rechecks native actor authority before any write",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
      const documentId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitAndReleaseIfUngated("vendor_bill", documentId, actors.submitterId);
      const auditBefore = await db.execute(
        sql`select id from audit_log where org_id=${org.orgId}`,
        "objects",
      );
      await assert.rejects(
        returnDocumentToDraft({
          orgId: org.orgId,
          documentId,
          actorId: actors.outsiderId,
          allowedSubsidiaryIds: null,
          reason: "Review the bill before another submission",
        }),
        /not found/,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents
      where org_id=${org.orgId} and id=${documentId}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
      assert.deepEqual(
        await db.execute(sql`select id from audit_log where org_id=${org.orgId}`, "objects"),
        auditBefore,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

async function nativeBill(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
): Promise<string> {
  const body = {
    partyId: org.vendorId,
    documentDate: org.date,
    lines: [{ accountId: org.accounts.cogs, amount: "100" }],
  };
  const created = await createDocument({
    orgId: org.orgId,
    userId: actorId,
    kind: "vendor_bill",
    key: randomUUID(),
    body,
    subsidiaryId: org.subsidiaryId,
    requestBody: body,
  });
  return created.id;
}

async function docStatus(orgId: string, id: string): Promise<string> {
  const rows = await db.execute<{ status: string }>(
    sql`
    select status from documents where id = ${id} and org_id = ${orgId}`,
    "objects",
  );
  return rows[0]!.status;
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

async function runStatus(orgId: string, runId: string): Promise<string> {
  const rows = await db.execute<{ status: string }>(
    sql`
    select status from flow_runs where id = ${runId} and org_id = ${orgId}`,
    "objects",
  );
  return rows[0]!.status;
}

test("a return reason is required before any database work", async () => {
  for (const reason of ["", "   ", "no", "abcd", null, undefined, 42]) {
    await assert.rejects(
      returnDocumentToDraft({
        documentId: "00000000-0000-0000-0000-000000000000",
        orgId: "00000000-0000-0000-0000-000000000000",
        actorId: null,
        reason,
      }),
      (error: unknown) =>
        error instanceof ReturnToDraftError && /between 5 and 500/.test(error.message),
    );
  }
});

test(
  "an ungated submission retains the approval performed by its native Flow",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
      const id = await nativeBill(org, actors.submitterId);
      const graph = {
        schemaVersion: 1,
        nodes: [
          {
            id: "submit",
            position: { x: 0, y: 0 },
            data: { kind: "trigger", trigger: { trigger: "on_submit" } },
          },
          {
            id: "approve",
            position: { x: 200, y: 0 },
            data: { kind: "action", action: { action: "change_status", to: "approved" } },
          },
        ],
        edges: [{ id: "submit-approve", source: "submit", target: "approve" }],
      };
      await db.execute(sql`insert into flows(org_id,name,subject_kind,enabled,graph)
      values(${org.orgId},'Automatic document approval','vendor_bill',true,${JSON.stringify(graph)}::jsonb)`);
      const result = await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId, {
        source: "script",
      });
      assert.equal(result.gated, false);
      assert.equal(result.autoApproved, true);
      assert.equal(result.flowError, null);
      assert.equal(await docStatus(org.orgId, id), "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an approved bill returns to draft with a before/after audit, edits, and re-approves",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
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
        applyDocumentEdit(
          billId,
          approvedCurrent,
          {},
          { orgId: org.orgId, userId: actors.submitterId, source: "ui", runFlows: false },
        ),
        (error: unknown) =>
          error instanceof DocumentEditError && /cannot be edited/.test(error.message),
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
  },
);

test(
  "a flow-governed bill keeps its completed run as history and resubmits into a new run",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const billId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });

      const first = await submitForApproval("vendor_bill", billId, actors.submitterId);
      assert.equal(first.gated, true);
      const firstRunId = first.runId!;
      const gates = await db.execute<{ id: string }>(
        sql`
      select id from flow_gates where subject_id = ${billId} and org_id = ${org.orgId}`,
        "objects",
      );
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
  },
);

test("non-approved documents refuse with a named remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedReturnActors(org.orgId);
    const billId = await nativeBill(org, actors.submitterId);

    await assert.rejects(
      returnDocumentToDraft({
        documentId: billId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "mistake in the batch",
      }),
      (error: unknown) =>
        error instanceof ReturnToDraftError && /already a draft/.test(error.message),
    );

    await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);
    await postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    await assert.rejects(
      returnDocumentToDraft({
        documentId: billId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "mistake in the batch",
      }),
      (error: unknown) =>
        error instanceof ReturnToDraftError && /void it or post a correction/.test(error.message),
    );

    const voidedId = await nativeBill(org, actors.submitterId);
    await submitAndReleaseIfUngated("vendor_bill", voidedId, actors.submitterId);
    await requestDocumentVoid({
      documentId: voidedId,
      orgId: org.orgId,
      actorId: actors.submitterId,
      reason: "Cancel duplicate bill before posting",
    });
    await assert.rejects(
      returnDocumentToDraft({
        documentId: voidedId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "mistake in the batch",
      }),
      (error: unknown) => error instanceof ReturnToDraftError && /terminal/.test(error.message),
    );
    assert.equal(await docStatus(org.orgId, voidedId), "voided");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stale drawer revision refuses before any mutation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedReturnActors(org.orgId);
    const billId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);

    await assert.rejects(
      returnDocumentToDraft({
        documentId: billId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "mistake in the batch",
        expectedUpdatedAt: "1",
      }),
      (error: unknown) =>
        error instanceof ReturnToDraftError &&
        error.status === 409 &&
        /changed after you opened it/.test(error.message),
    );
    assert.equal(await docStatus(org.orgId, billId), "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a concurrent post and return converge to exactly one outcome", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedReturnActors(org.orgId);
    const billId = await nativeBill(org, actors.submitterId);
    await submitAndReleaseIfUngated("vendor_bill", billId, actors.submitterId);

    const posting = postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const returning = returnDocumentToDraft({
      documentId: billId,
      orgId: org.orgId,
      actorId: actors.approver1Id,
      reason: "racing a same-moment post",
    });
    const [posted, returnedOutcome] = await Promise.allSettled([posting, returning]);

    const postWon = posted.status === "fulfilled";
    const returnWon = returnedOutcome.status === "fulfilled";
    assert.ok(postWon !== returnWon, "exactly one of the post and the return commits");
    if (postWon) {
      assert.match(
        String((returnedOutcome as PromiseRejectedResult).reason?.message ?? returnedOutcome),
        /already posted/,
      );
      assert.equal(await docStatus(org.orgId, billId), "posted");
    } else {
      assert.equal(posted.status, "rejected", "posting refuses a returned draft");
      assert.equal(await docStatus(org.orgId, billId), "draft");
    }
    const entries = await db.execute<{ id: string }>(
      sql`
      select id from journal_entries where org_id=${org.orgId} and source_document_id=${billId}`,
      "objects",
    );
    assert.equal(
      entries.length,
      postWon ? 1 : 0,
      "only the winning posting can leave accounting history",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
