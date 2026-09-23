import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { NormalizedCapture } from "./ap-capture.ts";
import { materializeCapture } from "./ap-capture-service.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * A PO-matched capture materializes the order's bill: the draft inherits the
 * purchase order's subsidiary and currency, and a capture currency that
 * conflicts with the order's refuses by name. Without an order, a
 * single-entity org keeps the root default while a multi-entity org refuses
 * instead of silently booking to root.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

function normalized(invoiceNumber: string, accountId: string, currency: string | null): NormalizedCapture {
  return {
    vendorName: "Acme Vendor",
    vendorTaxId: null,
    invoiceNumber,
    invoiceDate: "2026-07-15",
    dueDate: null,
    purchaseOrderNumber: null,
    currency,
    subtotal: "10.0000",
    taxTotal: "0.0000",
    total: "10.0000",
    memo: null,
    lines: [{
      description: "PO inheritance line",
      productCode: null,
      quantity: "1.0000",
      unit: "ea",
      unitPrice: "10.0000",
      amount: "10.0000",
      taxAmount: "0.0000",
      accountId,
      itemId: null,
      purchaseOrderLineId: null,
      confidence: "1.0000",
    }],
  };
}

async function seedVendorAndFile(org: ScratchOrg): Promise<string> {
  const fileId = randomUUID();
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})`);
  await db.execute(sql`
    insert into folders (id, org_id, name) values (${randomUUID()}, ${org.orgId}, 'AP PO inheritance')`);
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (${fileId}, ${org.orgId}, (select id from folders where org_id = ${org.orgId} limit 1),
            'po-invoice.pdf', 'application/pdf', 4)`);
  return fileId;
}

async function addSubsidiary(orgId: string, rootId: string, name: string, currency: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${rootId}, ${name}, ${currency}, 'DE', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function insertApprovedPo(org: ScratchOrg, subsidiaryId: string, currency: string, documentNumber: string): Promise<string> {
  const poId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, subsidiary_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (${poId}, ${org.orgId}, 'purchase_order', 'draft', ${documentNumber},
            ${org.vendorId}, ${subsidiaryId}, ${org.date}, ${currency}, 100, 0, 100, null)`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${poId} and org_id = ${org.orgId}`);
  return poId;
}

async function insertCapture(
  org: ScratchOrg,
  fileId: string,
  invoiceNumber: string,
  currency: string | null,
  purchaseOrderId: string | null,
): Promise<string> {
  const captureId = randomUUID();
  await db.execute(sql`
    insert into ap_capture_items
      (id, org_id, file_id, status, original_filename, content_hash,
       document_kind, normalized, validation_issues, vendor_candidate_id, purchase_order_id,
       created_by, updated_by)
    values (${captureId}, ${org.orgId}, ${fileId}, 'needs_review', ${invoiceNumber + ".pdf"},
            ${`poinherit-${randomUUID().replaceAll("-", "")}`}, 'vendor_bill',
            ${JSON.stringify(normalized(invoiceNumber, org.accounts.cogs, currency))}::jsonb,
            '[]'::jsonb, ${org.vendorId}, ${purchaseOrderId},
            null, null)`);
  return captureId;
}

async function billOf(orgId: string, documentId: string): Promise<{ subsidiaryId: string | null; currency: string }> {
  const rows = (await db.execute<{ subsidiaryId: string | null; currency: string }>(sql`
    select subsidiary_id as "subsidiaryId", currency from documents
     where id = ${documentId} and org_id = ${orgId}`)).rows;
  return { subsidiaryId: rows[0]!.subsidiaryId, currency: rows[0]!.currency };
}

test("a null-currency capture matched to a EUR order books the bill in the order entity and currency", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fileId = await seedVendorAndFile(org);
    const euId = await addSubsidiary(org.orgId, org.subsidiaryId, "EU Sales", "EUR");
    const poId = await insertApprovedPo(org, euId, "EUR", "PO-EU-1");
    const captureId = await insertCapture(org, fileId, `PO-EU-INV-${randomUUID().slice(0, 8)}`, null, poId);
    const { documentId } = await materializeCapture({ orgId: org.orgId, captureItemId: captureId, actorId: null });
    assert.deepEqual(await billOf(org.orgId, documentId), { subsidiaryId: euId, currency: "EUR" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a capture currency that conflicts with the order currency refuses by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fileId = await seedVendorAndFile(org);
    const euId = await addSubsidiary(org.orgId, org.subsidiaryId, "EU Sales", "EUR");
    const poId = await insertApprovedPo(org, euId, "EUR", "PO-EU-2");
    const captureId = await insertCapture(org, fileId, `PO-EU-INV-${randomUUID().slice(0, 8)}`, "CAD", poId);
    await assert.rejects(
      materializeCapture({ orgId: org.orgId, captureItemId: captureId, actorId: null }),
      /does not match purchase order currency EUR/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unmatched capture in a single-entity org keeps the root default", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fileId = await seedVendorAndFile(org);
    const captureId = await insertCapture(org, fileId, `PO-ROOT-INV-${randomUUID().slice(0, 8)}`, "CAD", null);
    const { documentId } = await materializeCapture({ orgId: org.orgId, captureItemId: captureId, actorId: null });
    assert.deepEqual(await billOf(org.orgId, documentId), { subsidiaryId: org.subsidiaryId, currency: "CAD" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unmatched capture in a multi-entity org refuses instead of defaulting to root", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fileId = await seedVendorAndFile(org);
    await addSubsidiary(org.orgId, org.subsidiaryId, "EU Sales", "EUR");
    const captureId = await insertCapture(org, fileId, `PO-MULTI-INV-${randomUUID().slice(0, 8)}`, "CAD", null);
    await assert.rejects(
      materializeCapture({ orgId: org.orgId, captureItemId: captureId, actorId: null }),
      /Cannot determine the billing entity.*match it to a purchase order/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
