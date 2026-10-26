import { test } from "node:test";
import assert from "node:assert/strict";
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
import { decideGate } from "./gates.ts";
import {
  returnDocumentToDraft,
  ReturnToDraftError,
  submitAndReleaseIfUngated,
  submitForApproval,
} from "./submit.ts";

/**
 * Return to draft for purchase orders: an approved, never-received and
 * never-billed order corrects through edit and re-approval through the same
 * native document-lifecycle service the document drawer uses — no fork.
 * Received or billed lines refuse with the applied remedy (amend the
 * remaining quantities, or void the receipt first) so a redraft can never
 * strand stock or money already moving against the order.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedReturnActors(orgId: string) {
  const actors = await seedFlowActors(orgId);
  await grantScratchPermissions(orgId, actors.approver1Id, ["purchase_orders.create"]);
  return actors;
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

/** A draft purchase order with one stocked-quantity line, approved when ungated. */
async function seedApprovedPurchaseOrder(orgId: string, actorId: string): Promise<string> {
  const orderId = await seedDraftDocument(orgId, { kind: "purchase_order", createdBy: actorId });
  const account = (
    await db.execute<{ id: string }>(
      sql`
    select id from accounts where org_id = ${orgId} order by number limit 1`,
      "objects",
    )
  )[0]!.id;
  await db.execute(sql`
    insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
    values (${orgId}, ${orderId}, 1, ${account}, 'Seeded line', '3040', '10', '30400')`);
  const released = await submitAndReleaseIfUngated("purchase_order", orderId, actorId);
  assert.equal(released.autoApproved, true);
  assert.equal(await docStatus(orgId, orderId), "approved");
  return orderId;
}

test(
  "an untouched approved purchase order returns to draft and re-approves",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
      const orderId = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);

      const reason = "vendor confirmed the wrong ship date on every line";
      const returned = await returnDocumentToDraft({
        documentId: orderId,
        orgId: org.orgId,
        actorId: actors.approver1Id,
        reason,
      });
      assert.deepEqual(returned, { status: "draft", supersededRunIds: [], cancelledRunIds: [] });
      assert.equal(await docStatus(org.orgId, orderId), "draft");

      const audit = await latestDocumentAudit(org.orgId, orderId);
      assert.equal(audit.action, "update");
      assert.equal(audit.changes.reason, reason);
      assert.equal(audit.changes.before.document.status, "approved");
      assert.equal(audit.changes.after.document.status, "draft");

      const rereleased = await submitAndReleaseIfUngated(
        "purchase_order",
        orderId,
        actors.submitterId,
      );
      assert.equal(rereleased.autoApproved, true);
      assert.equal(await docStatus(org.orgId, orderId), "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a purchase order with received lines refuses with the applied remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
      const orderId = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);
      // A posted receipt's advance on the line: approved lines are
      // storage-immutable, so the receipt reopens, advances, and restores.
      await db.execute(sql`
      update documents set status = 'draft'
       where id = ${orderId} and org_id = ${org.orgId}`);
      await db.execute(sql`
      update document_lines set quantity_fulfilled = '304'
       where org_id = ${org.orgId} and document_id = ${orderId}`);
      await db.execute(sql`
      update documents set status = 'approved'
       where id = ${orderId} and org_id = ${org.orgId}`);

      await assert.rejects(
        returnDocumentToDraft({
          documentId: orderId,
          orgId: org.orgId,
          actorId: actors.approver1Id,
          reason: "wrong ship date",
        }),
        (error: unknown) =>
          error instanceof ReturnToDraftError &&
          error.code === "applied" &&
          /received or billed lines/.test(error.message) &&
          /amend the order/.test(error.message),
      );
      assert.equal(await docStatus(org.orgId, orderId), "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a purchase order with billed lines refuses with the applied remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
      const orderId = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);
      // A bill matched against the line: approved lines are
      // storage-immutable, so the billing conversion reopens and restores.
      await db.execute(sql`
      update documents set status = 'draft'
       where id = ${orderId} and org_id = ${org.orgId}`);
      await db.execute(sql`
      update document_lines set quantity_billed = '100'
       where org_id = ${org.orgId} and document_id = ${orderId}`);
      await db.execute(sql`
      update documents set status = 'approved'
       where id = ${orderId} and org_id = ${org.orgId}`);

      await assert.rejects(
        returnDocumentToDraft({
          documentId: orderId,
          orgId: org.orgId,
          actorId: actors.approver1Id,
          reason: "wrong ship date",
        }),
        (error: unknown) =>
          error instanceof ReturnToDraftError &&
          error.code === "applied" &&
          /received or billed lines/.test(error.message),
      );
      assert.equal(await docStatus(org.orgId, orderId), "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a flow-governed purchase order resubmits into a new run after return",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedReturnActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "purchase_order",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const orderId = await seedDraftDocument(org.orgId, {
        kind: "purchase_order",
        createdBy: actors.submitterId,
      });

      const first = await submitForApproval("purchase_order", orderId, actors.submitterId);
      assert.equal(first.gated, true);
      const firstRunId = first.runId!;
      const gates = await db.execute<{ id: string }>(
        sql`
      select id from flow_gates where subject_id = ${orderId} and org_id = ${org.orgId}`,
        "objects",
      );
      await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: actors.approver1Id });
      assert.equal(await docStatus(org.orgId, orderId), "approved");

      const returned = await returnDocumentToDraft({
        documentId: orderId,
        orgId: org.orgId,
        actorId: actors.approver1Id,
        reason: "wrong ship date on every line",
      });
      assert.deepEqual(returned.supersededRunIds, [firstRunId]);

      const second = await submitForApproval("purchase_order", orderId, actors.submitterId);
      assert.equal(second.gated, true);
      assert.ok(second.runId && second.runId !== firstRunId, "resubmission opens a fresh run");
      assert.equal(await docStatus(org.orgId, orderId), "pending_approval");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
