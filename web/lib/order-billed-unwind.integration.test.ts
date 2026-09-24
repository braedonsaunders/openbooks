import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
}});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
import type { ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
const { convertOrder } = await import("./order-cycle.ts");
const { requestDocumentVoid } = await import("@openbooks/engine/src/ledger/document-void.ts");
const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { materializeCapture } = await import("@openbooks/engine/src/payables/ap-capture-service.ts");

async function seedOrder(
  org: ScratchOrg,
  actorId: string,
  kind: "quote" | "sales_order",
  number: string,
  quantity = "10",
): Promise<string> {
  const id = randomUUID();
  const amount = String(Number(quantity) * 100);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${id}, ${org.orgId}, ${kind}, ${number}, ${org.customerId},
      ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', ${amount}, '0', ${amount},
      ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity,
       quantity_billed, quantity_fulfilled, unit_price, amount,
       tax_input_amount, tax_amount, created_by, updated_by)
    values (
      ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, ${quantity},
      '0', '0', '100', ${amount}, ${amount}, '0', ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${id} and org_id = ${org.orgId}
  `);
  return id;
}

// Seeding helpers run under withBypassContext at their call sites: importing
// ./order-cycle.ts pulls in the web request-org resolver, which denies every
// unscoped query under pooled RLS (bare setup dies with 42501). convertOrder
// and requestDocumentVoid scope their own transactions internally and run
// bare; the remaining engine calls (post, delete, materialize) rely on ambient
// scope like the sibling order-convert-income suite, so they run under bypass.
// Reads run in the scratch org's scope.
async function billedOf(orgId: string, documentId: string): Promise<string> {
  return withOrgContext(orgId, async () => {
    const r = (await db.execute<{ quantity_billed: string }>(sql`
      select quantity_billed::text from document_lines
       where org_id = ${orgId} and document_id = ${documentId}
       order by line_number limit 1`));
    return r.rows[0]!.quantity_billed;
  });
}

async function approveAndPostInvoice(org: ScratchOrg, actorId: string, invoiceId: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  });
}

test("voiding a converted invoice restores the sales order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
    const soId = await withBypassContext(() => seedOrder(org, actorId, "sales_order", "SO-BILLED-VOID-1"));
    const converted = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
    assert.equal(await billedOf(org.orgId, soId), "10.00000000");
    await approveAndPostInvoice(org, actorId, converted.id);
    const voided = await requestDocumentVoid({
      documentId: converted.id, orgId: org.orgId, actorId,
      reason: "Void a mistakenly converted invoice", reversalDate: org.date, source: "api",
    });
    assert.equal(voided.status, "voided");
    assert.equal(await billedOf(org.orgId, soId), "0.00000000");
    const again = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
    assert.ok(again.id);
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

test("deleting a draft converted invoice restores the sales order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
    const soId = await withBypassContext(() => seedOrder(org, actorId, "sales_order", "SO-BILLED-DELETE-1"));
    const converted = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
    assert.equal(await billedOf(org.orgId, soId), "10.00000000");
    await withBypassContext(() => deleteDocument(converted.id, actorId, org.orgId, { reason: "Discard a mistakenly converted draft" }));
    assert.equal(await billedOf(org.orgId, soId), "0.00000000");
    const again = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
    assert.ok(again.id);
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

async function seedServicePO(
  org: ScratchOrg,
  actorId: string,
  number: string,
  quantity = "10",
): Promise<{ poId: string; lineId: string }> {
  const amount = String(Number(quantity) * 100);
  const poId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${poId}, ${org.orgId}, 'purchase_order', ${number}, ${org.vendorId},
      ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', ${amount}, '0', ${amount},
      ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, quantity,
       quantity_billed, quantity_fulfilled, unit_price, amount,
       tax_input_amount, tax_amount, created_by, updated_by)
    values (
      ${lineId}, ${org.orgId}, ${poId}, 1, ${org.accounts.adjustment}, ${quantity},
      '0', '0', '100', ${amount}, ${amount}, '0', ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${poId} and org_id = ${org.orgId}
  `);
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, created_by, updated_by)
    values (${org.orgId}, ${org.vendorId}, ${actorId}, ${actorId})
  `);
  return { poId, lineId };
}

async function seedCaptureItem(
  org: ScratchOrg,
  actorId: string,
  input: {
    kind: "vendor_bill" | "vendor_credit";
    poId: string;
    poLineId: string;
    quantity: string;
    invoiceNumber: string;
  },
): Promise<string> {
  const amount = String(Number(input.quantity) * 100);
  const folderId = randomUUID();
  await db.execute(sql`
    insert into folders (id, org_id, name, created_by, updated_by)
    values (${folderId}, ${org.orgId}, 'AP capture', ${actorId}, ${actorId})
  `);
  const fileId = randomUUID();
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes, created_by, updated_by)
    values (${fileId}, ${org.orgId}, ${folderId}, 'capture.pdf', 'application/pdf', 10, ${actorId}, ${actorId})
  `);
  const itemId = randomUUID();
  const normalized = {
    vendorName: "Acme Vendor",
    vendorTaxId: null,
    invoiceNumber: input.invoiceNumber,
    invoiceDate: org.date,
    dueDate: null,
    purchaseOrderNumber: null,
    currency: "CAD",
    subtotal: amount,
    taxTotal: "0",
    total: amount,
    memo: null,
    lines: [{
      description: "Services",
      productCode: null,
      quantity: input.quantity,
      unit: null,
      unitPrice: "100",
      amount,
      taxAmount: "0",
      accountId: org.accounts.adjustment,
      itemId: null,
      purchaseOrderLineId: input.poLineId,
      confidence: null,
    }],
  };
  await db.execute(sql`
    insert into ap_capture_items
      (id, org_id, file_id, status, original_filename, content_hash, document_kind,
       normalized, vendor_candidate_id, purchase_order_id, created_by, updated_by)
    values (${itemId}, ${org.orgId}, ${fileId}, 'ready', 'capture.pdf',
      ${randomUUID().replace(/-/g, "")}, ${input.kind}, ${JSON.stringify(normalized)}::jsonb,
      ${org.vendorId}, ${input.poId}, ${actorId}, ${actorId})
  `);
  return itemId;
}

async function approveAndPostBill(org: ScratchOrg, billId: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
    await postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  });
}

test("voiding a converted sales order restores the quote billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
    const quoteId = await withBypassContext(() => seedOrder(org, actorId, "quote", "QUOTE-BILLED-VOID-1", "5"));
    const converted = await convertOrder(org.orgId, actorId, quoteId, "sales_order");
    assert.equal(await billedOf(org.orgId, quoteId), "5.00000000");
    const voided = await requestDocumentVoid({
      documentId: converted.id, orgId: org.orgId, actorId,
      reason: "Cancel a mistakenly converted order", reversalDate: org.date, source: "api",
    });
    assert.equal(voided.status, "voided");
    assert.equal(await billedOf(org.orgId, quoteId), "0.00000000");
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

test("deleting a draft captured bill restores the purchase order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
    const { poId, lineId } = await withBypassContext(() => seedServicePO(org, actorId, "PO-BILLED-DELETE-1"));
    const itemId = await withBypassContext(() => seedCaptureItem(org, actorId, {
      kind: "vendor_bill", poId, poLineId: lineId, quantity: "10", invoiceNumber: "AP-DELETE-1",
    }));
    const materialized = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: itemId, actorId, allowedSubsidiaryIds: null }));
    assert.equal(await billedOf(org.orgId, poId), "10.00000000");
    await withBypassContext(() => deleteDocument(materialized.documentId, actorId, org.orgId, { reason: "Discard a mistakenly captured draft" }));
    assert.equal(await billedOf(org.orgId, poId), "0.00000000");
    const released = await withOrgContext(org.orgId, async () => (await db.execute<{ status: string; document_id: string | null }>(sql`
      select status, document_id from ap_capture_items where id = ${itemId} and org_id = ${org.orgId}`)).rows[0]!);
    assert.equal(released.status, "needs_review");
    assert.equal(released.document_id, null);
    const again = await convertOrder(org.orgId, actorId, poId, "vendor_bill");
    assert.ok(again.id, "the received remainder is billable again");
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

test("voiding a captured bill restores the purchase order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
    const { poId, lineId } = await withBypassContext(() => seedServicePO(org, actorId, "PO-BILLED-VOID-1"));
    const itemId = await withBypassContext(() => seedCaptureItem(org, actorId, {
      kind: "vendor_bill", poId, poLineId: lineId, quantity: "10", invoiceNumber: "AP-VOID-1",
    }));
    const materialized = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: itemId, actorId, allowedSubsidiaryIds: null }));
    await approveAndPostBill(org, materialized.documentId);
    const voided = await requestDocumentVoid({
      documentId: materialized.documentId, orgId: org.orgId, actorId,
      reason: "Void a mistakenly captured bill", reversalDate: org.date, source: "api",
    });
    assert.equal(voided.status, "voided");
    assert.equal(await billedOf(org.orgId, poId), "0.00000000");
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

test("voiding a captured vendor credit re-consumes the purchase order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
    const { poId, lineId: poLineId } = await withBypassContext(() => seedServicePO(org, actorId, "PO-BILLED-CREDIT-1"));
    const billItem = await withBypassContext(() => seedCaptureItem(org, actorId, {
      kind: "vendor_bill", poId, poLineId, quantity: "10", invoiceNumber: "AP-CREDIT-BILL-1",
    }));
    const bill = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: billItem, actorId, allowedSubsidiaryIds: null }));
    await approveAndPostBill(org, bill.documentId);
    assert.equal(await billedOf(org.orgId, poId), "10.00000000");
    const creditItem = await withBypassContext(() => seedCaptureItem(org, actorId, {
      kind: "vendor_credit", poId, poLineId, quantity: "4", invoiceNumber: "AP-CREDIT-1",
    }));
    const credit = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: creditItem, actorId, allowedSubsidiaryIds: null }));
    assert.equal(await billedOf(org.orgId, poId), "6.00000000");
    await approveAndPostBill(org, credit.documentId);
    const voided = await requestDocumentVoid({
      documentId: credit.documentId, orgId: org.orgId, actorId,
      reason: "Void a mistakenly captured credit", reversalDate: org.date, source: "api",
    });
    assert.equal(voided.status, "voided");
    assert.equal(await billedOf(org.orgId, poId), "10.00000000");
    // The unwind must not open headroom for a second billing of the same units.
    await assert.rejects(
      convertOrder(org.orgId, actorId, poId, "vendor_bill"),
      /fully converted|do not cover|already/,
    );
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

