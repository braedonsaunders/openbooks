import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "@openbooks/engine/testing/fixtures";
import { submitAndReleaseIfUngated, submitForApproval } from "@openbooks/engine/flows/module";
import { decideGate } from "@openbooks/engine/testing/flows/gates";
import { computeLineTaxes } from "@openbooks/engine/tax/tax";
import { loadTaxProfileConfig, persistLineTaxComponents } from "@openbooks/engine/tax/persist";
import { amendPurchaseOrder, PurchaseOrderAmendError } from "./purchase-order-amend.ts";

/**
 * Purchase-order amendment: an approved order with received or billed lines
 * amends quantity/price through a reasoned, audited service — quantities
 * never fall below received or billed evidence, the revision bumps, and the
 * amended order re-approves through the native Flow release.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function docState(orgId: string, id: string) {
  const rows = await db.execute<{ status: string; total: string; revision: string }>(
    sql`
    select status, total::text as total, revision_seq::text as revision
      from documents where id = ${id} and org_id = ${orgId}`,
    "objects",
  );
  return rows[0]!;
}

async function lineState(orgId: string, orderId: string) {
  const rows = await db.execute<{
    quantity: string;
    unitPrice: string;
    amount: string;
    taxInputAmount: string;
    taxAmount: string;
  }>(
    sql`
    select quantity::text as quantity, unit_price::text as "unitPrice", amount::text as amount,
           tax_input_amount::text as "taxInputAmount", tax_amount::text as "taxAmount"
      from document_lines where org_id = ${orgId} and document_id = ${orderId}`,
    "objects",
  );
  return rows[0]!;
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
    requestId: string | null;
  }>(
    sql`
    select action, changes, request_id as "requestId" from audit_log
     where org_id = ${orgId} and table_name = 'documents' and row_id = ${id}
     order by at desc, id desc limit 1`,
    "objects",
  );
  return rows[0]!;
}

async function reopenAdvanceRestore(
  orgId: string,
  orderId: string,
  column: "quantity_fulfilled" | "quantity_billed",
  value: string,
) {
  await db.execute(
    sql`update documents set status = 'draft' where id = ${orderId} and org_id = ${orgId}`,
  );
  await db.execute(
    sql`update document_lines set ${sql.raw(column)} = ${value} where org_id = ${orgId} and document_id = ${orderId}`,
  );
  await db.execute(
    sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${orgId}`,
  );
}

async function seedApprovedPurchaseOrder(
  orgId: string,
  actorId: string,
): Promise<{ orderId: string; lineId: string }> {
  const orderId = await seedDraftDocument(orgId, { kind: "purchase_order", createdBy: actorId });
  const account = (
    await db.execute<{ id: string }>(
      sql`
    select id from accounts where org_id = ${orgId} order by number limit 1`,
      "objects",
    )
  )[0]!.id;
  const inserted = (
    await db.execute<{ id: string }>(
      sql`
    insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
    values (${orgId}, ${orderId}, 1, ${account}, 'Bulk grain', '3040', '10', '30400')
    returning id`,
      "objects",
    )
  )[0]!.id;
  const released = await submitAndReleaseIfUngated("purchase_order", orderId, actorId);
  assert.equal(released.autoApproved, true);
  return { orderId, lineId: inserted };
}

test(
  "an over-shipment amends the ordered quantity up with reason, audit, and revision bump",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const { orderId, lineId } = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);
      const before = await docState(org.orgId, orderId);

      const reason = "vendor over-shipped 304 lb and the warehouse accepted it";
      const result = await amendPurchaseOrder({
        orderId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason,
        expectedUpdatedAt: before.revision,
        lines: [{ lineId, quantity: "3344" }],
      });
      assert.deepEqual(result, { status: "approved", gated: false, runId: null });

      const line = await lineState(org.orgId, orderId);
      assert.equal(line.quantity, "3344.00000000");
      assert.equal(line.amount, "33440.0000");
      const after = await docState(org.orgId, orderId);
      assert.equal(after.status, "approved");
      assert.equal(after.total, "33440.0000");
      assert.notEqual(after.revision, before.revision);

      const audit = await latestDocumentAudit(org.orgId, orderId);
      assert.equal(audit.action, "update");
      assert.equal(audit.requestId, "purchase-orders.amend");
      assert.equal(audit.changes.reason, reason);
      assert.equal(audit.changes.before.document.status, "approved");
      assert.equal(audit.changes.after.document.status, "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an amendment below the received quantity refuses with the applied remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const { orderId, lineId } = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);
      await reopenAdvanceRestore(org.orgId, orderId, "quantity_fulfilled", "304");

      await assert.rejects(
        amendPurchaseOrder({
          orderId,
          orgId: org.orgId,
          actorId: actors.submitterId,
          reason: "trying to cut below the receipt",
          lines: [{ lineId, quantity: "300" }],
        }),
        (error: unknown) =>
          error instanceof PurchaseOrderAmendError &&
          error.code === "applied" &&
          /below the received or billed quantity/.test(error.message),
      );
      assert.equal((await docState(org.orgId, orderId)).status, "approved");
      assert.equal((await lineState(org.orgId, orderId)).quantity, "3040.00000000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an amendment below the billed quantity refuses with the applied remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const { orderId, lineId } = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);
      await reopenAdvanceRestore(org.orgId, orderId, "quantity_billed", "100");

      await assert.rejects(
        amendPurchaseOrder({
          orderId,
          orgId: org.orgId,
          actorId: actors.submitterId,
          reason: "trying to cut below the bill",
          lines: [{ lineId, quantity: "50" }],
        }),
        (error: unknown) => error instanceof PurchaseOrderAmendError && error.code === "applied",
      );
      assert.equal((await lineState(org.orgId, orderId)).quantity, "3040.00000000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a unit-price change re-prices the line and header totals", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const { orderId, lineId } = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);

    const result = await amendPurchaseOrder({
      orderId,
      orgId: org.orgId,
      actorId: actors.submitterId,
      reason: "vendor confirmed a price rise before shipment",
      lines: [{ lineId, unitPrice: "11" }],
    });
    assert.equal(result.status, "approved");
    const line = await lineState(org.orgId, orderId);
    assert.equal(line.unitPrice, "11.00000000");
    assert.equal(line.amount, "33440.0000");
    assert.equal((await docState(org.orgId, orderId)).total, "33440.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "taxed amendments rebuild tax evidence and enforce the exact cancelled quantity floor",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const { orderId, lineId } = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);
      const taxCodeId = randomUUID();
      await db.execute(sql`insert into tax_codes (id, org_id, code, name, applies_to, is_active, collected_account_id, paid_account_id)
      values (${taxCodeId}, ${org.orgId}, 'AMEND-PURCHASE-TAX', 'Amendment purchase tax', 'purchases', true, ${org.accounts.taxOutput}, ${org.accounts.taxInput})`);
      await db.execute(sql`insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from)
      values (${org.orgId}, ${taxCodeId}, '10', '2020-01-01')`);

      const tax = computeLineTaxes(
        "1000",
        await loadTaxProfileConfig(org.orgId, { taxCodeId, taxGroupId: null }, org.date),
      );
      await db.execute(
        sql`update documents set status = 'draft' where id = ${orderId} and org_id = ${org.orgId}`,
      );
      await db.execute(sql`update document_lines
      set quantity = '100', quantity_fulfilled = '40', quantity_cancelled = '30', unit_price = '10',
          amount = ${tax.netAmount}, tax_code_id = ${taxCodeId}, tax_input_amount = ${tax.inputAmount}, tax_amount = ${tax.taxTotal}
      where id = ${lineId} and org_id = ${org.orgId}`);
      await persistLineTaxComponents(org.orgId, lineId, tax.components, actors.submitterId);
      await db.execute(
        sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${org.orgId}`,
      );

      await assert.rejects(
        amendPurchaseOrder({
          orderId,
          orgId: org.orgId,
          actorId: actors.submitterId,
          reason: "reduce below received and cancelled units",
          lines: [{ lineId, quantity: "69.99999999" }],
        }),
        (error: unknown) =>
          error instanceof PurchaseOrderAmendError &&
          error.code === "applied" &&
          /at least 70\.0000/.test(error.message),
      );

      const result = await amendPurchaseOrder({
        orderId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "accept the exact remaining purchase quantity",
        lines: [{ lineId, quantity: "70.00000001", unitPrice: "10.00000001" }],
      });
      assert.equal(result.status, "approved");
      const line = await lineState(org.orgId, orderId);
      assert.equal(line.quantity, "70.00000001");
      assert.equal(line.unitPrice, "10.00000001");
      assert.equal(line.amount, "700.0000");
      assert.equal(line.taxInputAmount, "700.0000");
      assert.equal(line.taxAmount, "70.0000");
      const components = await db.execute<{ sequence: number; taxAmount: string }>(
        sql`
      select sequence, tax_amount::text as "taxAmount" from document_line_tax_components
       where org_id = ${org.orgId} and document_line_id = ${lineId} order by sequence`,
        "objects",
      );
      assert.deepEqual(components, [{ sequence: 1, taxAmount: "70.0000" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an amendment with no effective change refuses before any write", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const { orderId, lineId } = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);
    const before = await docState(org.orgId, orderId);

    await assert.rejects(
      amendPurchaseOrder({
        orderId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "accidental resubmission of the same values",
        expectedUpdatedAt: before.revision,
        lines: [{ lineId, quantity: "3040", unitPrice: "10" }],
      }),
      (error: unknown) => error instanceof PurchaseOrderAmendError && error.code === "no-changes",
    );
    assert.equal((await docState(org.orgId, orderId)).revision, before.revision);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stale drawer revision refuses before any mutation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const { orderId, lineId } = await seedApprovedPurchaseOrder(org.orgId, actors.submitterId);

    await assert.rejects(
      amendPurchaseOrder({
        orderId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "amending from a stale drawer view",
        expectedUpdatedAt: "1",
        lines: [{ lineId, quantity: "3344" }],
      }),
      (error: unknown) =>
        error instanceof PurchaseOrderAmendError &&
        error.status === 409 &&
        /changed after you opened it/.test(error.message),
    );
    assert.equal((await lineState(org.orgId, orderId)).quantity, "3040.00000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a short reason refuses before any database work", async () => {
  await assert.rejects(
    amendPurchaseOrder({
      orderId: "00000000-0000-0000-0000-000000000000",
      orgId: "00000000-0000-0000-0000-000000000000",
      actorId: null,
      reason: "no",
      lines: [{ lineId: "00000000-0000-0000-0000-000000000000", quantity: "1" }],
    }),
    (error: unknown) =>
      error instanceof PurchaseOrderAmendError && /between 5 and 500/.test(error.message),
  );
});

test(
  "a flow-governed order amends into pending_approval with a new run",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
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
      const gates = await db.execute<{ id: string }>(
        sql`
      select id from flow_gates where subject_id = ${orderId} and org_id = ${org.orgId}`,
        "objects",
      );
      await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: actors.approver1Id });
      assert.equal((await docState(org.orgId, orderId)).status, "approved");

      const account = (
        await db.execute<{ id: string }>(
          sql`
      select id from accounts where org_id = ${org.orgId} order by number limit 1`,
          "objects",
        )
      )[0]!.id;
      // Approval predates the line (the flow test seeds a bare draft): reopen,
      // add the line the amendment will change, and restore.
      await db.execute(
        sql`update documents set status = 'draft' where id = ${orderId} and org_id = ${org.orgId}`,
      );
      const lineId = (
        await db.execute<{ id: string }>(
          sql`
      insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
      values (${org.orgId}, ${orderId}, 1, ${account}, 'Bulk grain', '3040', '10', '30400')
      returning id`,
          "objects",
        )
      )[0]!.id;
      await db.execute(
        sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${org.orgId}`,
      );

      const result = await amendPurchaseOrder({
        orderId,
        orgId: org.orgId,
        actorId: actors.submitterId,
        reason: "vendor over-shipped and the warehouse accepted it",
        lines: [{ lineId, quantity: "3344" }],
      });
      assert.equal(result.status, "pending_approval");
      assert.equal(result.gated, true);
      assert.ok(
        result.runId && result.runId !== first.runId,
        "amendment resubmits into a fresh run",
      );
      assert.equal((await docState(org.orgId, orderId)).status, "pending_approval");

      const audit = await latestDocumentAudit(org.orgId, orderId);
      assert.equal(audit.changes.after.document.status, "pending_approval");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
