import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import {
  CaptureScopeDeniedError,
  materializeCapture,
  processCaptureItem,
} from "./ap-capture-service.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * The OCR worker acts as the uploader: a purchase-order match outside the
 * uploader's subsidiary scope must stay in review for a supervisor whose
 * scope covers the order, never auto-create another entity's vendor bill
 * (and never fail the capture, which would bury it). Manual materialize of
 * an out-of-scope match refuses with the uniform not-found shape.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function hiddenEntity(orgId: string, rootId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${rootId}, 'Hidden entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function seedHiddenVendor(org: ScratchOrg, subsidiaryId: string): Promise<string> {
  const vendor = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${vendor}, ${org.orgId}, 'vendor', 'Hidden Vendor', ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
    values (${org.orgId}, ${vendor}, ${org.accounts.ap}, ${org.accounts.cogs})`);
  return vendor;
}

async function seedHiddenPo(org: ScratchOrg, vendor: string, subsidiaryId: string, documentNumber: string): Promise<string> {
  const poId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, subsidiary_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (${poId}, ${org.orgId}, 'purchase_order', 'draft', ${documentNumber},
            ${vendor}, ${subsidiaryId}, ${org.date}, 'CAD', 100, 0, 100, null)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit_price, amount, tax_input_amount,
       quantity_billed, quantity_fulfilled, custom, extra_dims)
    values (${randomUUID()}, ${org.orgId}, ${poId}, 1, ${org.items.service}, ${org.accounts.cogs}, 'PO service line',
            1, 10, 10, 0, 0, 0, '{}'::jsonb, '{}'::jsonb)`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${poId} and org_id = ${org.orgId}`);
  return poId;
}

async function billCount(orgId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents where org_id = ${orgId} and kind = 'vendor_bill'`)).rows[0]!.n;
}

async function poBilled(orgId: string, poId: string): Promise<string> {
  return (await db.execute<{ quantity_billed: string }>(sql`
    select quantity_billed::text as quantity_billed from document_lines
     where org_id = ${orgId} and document_id = ${poId}`)).rows[0]!.quantity_billed;
}

const ZERO_QTY = "0.00000000";

test("manual materialize of an out-of-scope purchase order refuses and writes nothing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Restricted uploader", "reviewer");
    const hidden = await hiddenEntity(org.orgId, org.subsidiaryId);
    const vendor = await seedHiddenVendor(org, hidden);
    const fileId = randomUUID();
    await db.execute(sql`insert into folders (id, org_id, name) values (${randomUUID()}, ${org.orgId}, 'AP scope proof')`);
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, (select id from folders where org_id = ${org.orgId} limit 1),
              'scope.pdf', 'application/pdf', 4)`);
    const poId = await seedHiddenPo(org, vendor, hidden, "PO-HID-1");
    const captureId = randomUUID();
    await db.execute(sql`
      insert into ap_capture_items
        (id, org_id, file_id, status, original_filename, content_hash,
         document_kind, normalized, validation_issues, vendor_candidate_id, purchase_order_id,
         created_by, updated_by)
      values (${captureId}, ${org.orgId}, ${fileId}, 'needs_review', 'scope.pdf',
              ${`scope-${randomUUID().replaceAll("-", "")}`}, 'vendor_bill',
              ${JSON.stringify({
                vendorName: "Hidden Vendor", vendorTaxId: null, invoiceNumber: `SCOPE-1-${randomUUID().slice(0, 8)}`,
                invoiceDate: "2026-07-15", dueDate: null, purchaseOrderNumber: "PO-HID-1", currency: "CAD",
                subtotal: "10.0000", taxTotal: "0.0000", total: "10.0000", memo: null,
                lines: [{ description: "PO service line", productCode: null, quantity: "1.0000", unit: "ea",
                           unitPrice: "10.0000", amount: "10.0000", taxAmount: "0.0000",
                           accountId: org.accounts.cogs, itemId: null, purchaseOrderLineId: null, confidence: "1.0000" }],
              })}::jsonb,
              '[]'::jsonb, ${vendor}, ${poId}, ${actor}, ${actor})`);
    const scopeA = new Set([org.subsidiaryId]);
    await assert.rejects(
      materializeCapture({ orgId: org.orgId, captureItemId: captureId, actorId: actor, allowedSubsidiaryIds: scopeA }),
      (error: unknown) => error instanceof CaptureScopeDeniedError && error.message === "Capture item not found",
    );
    assert.equal(await billCount(org.orgId), 0, "a refused materialize creates no vendor bill");
    assert.equal(await poBilled(org.orgId, poId), ZERO_QTY, "a refused materialize advances no billed quantity");
    const left = (await db.execute<{ status: string; document_id: string | null }>(sql`
      select status, document_id from ap_capture_items where id = ${captureId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(left.status, "needs_review");
    assert.equal(left.document_id, null);
    // An unrestricted caller still materializes the same item.
    const { documentId } = await materializeCapture({
      orgId: org.orgId, captureItemId: captureId, actorId: actor, allowedSubsidiaryIds: null,
    });
    assert.ok(documentId);
    assert.equal(await billCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("auto-materialize leaves an out-of-scope purchase-order match in review", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Restricted uploader", "reviewer");
    const hidden = await hiddenEntity(org.orgId, org.subsidiaryId);
    const vendor = await seedHiddenVendor(org, hidden);
    const endpoint = "https://ob-capture-scope.cognitiveservices.azure.com";
    const money = (content: string) => ({ type: "currency", content, confidence: 0.99 });
    const payloadFor = (invoiceNumber: string, poNumber: string) => ({
      status: "succeeded",
      analyzeResult: {
        documents: [{
          confidence: 0.97,
          fields: {
            VendorName: { type: "string", content: "Hidden Vendor", valueString: "Hidden Vendor", confidence: 0.99 },
            InvoiceId: { type: "string", content: invoiceNumber, valueString: invoiceNumber, confidence: 0.98 },
            InvoiceDate: { type: "date", content: "2026-07-15", valueDate: "2026-07-15", confidence: 0.99 },
            PurchaseOrder: { type: "string", content: poNumber, valueString: poNumber, confidence: 0.99 },
            CurrencyCode: { type: "string", valueString: "CAD", confidence: 0.99 },
            SubTotal: money("10"),
            TotalTax: money("0"),
            InvoiceTotal: money("10"),
            Items: { valueArray: [{ valueObject: {
              Description: { valueString: "PO service line", confidence: 0.98 },
              Quantity: money("1"),
              UnitPrice: money("10.0000"),
              Amount: money("10.0000"),
              Tax: money("0.0000"),
            } }] },
          },
        }],
        pages: [],
      },
    });
    const stubFetchFor = (payload: unknown) => (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(null, { status: 202, headers: { "operation-location": `${endpoint}/result/1` } });
      }
      assert.ok(String(input).startsWith(endpoint), "polling stays on the provider host");
      return Response.json(payload);
    }) as typeof fetch;
    const stubLookup = async () => ["20.50.100.1"];
    await db.execute(sql`insert into folders (id, org_id, name) values (${randomUUID()}, ${org.orgId}, 'AP scope auto')`);
    await db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
        'ai', coalesce(settings->'ai', '{}'::jsonb) || ${JSON.stringify({
          enabled: true,
          documentCapture: {
            enabled: true, endpoint, model: "prebuilt-invoice", confidenceThreshold: "0.9000",
            autoCreatePoMatchedDrafts: true, keyEncrypted: sealSecret("db-proof-key"),
          },
        })}::jsonb)
       where id = ${org.orgId}`);
    const poem = await seedHiddenPo(org, vendor, hidden, "PO-HID-AUTO");
    const queueCapture = async () => {
      const fileId = randomUUID();
      const versionId = randomUUID();
      const captureId = randomUUID();
      await db.execute(sql`
        insert into files (id, org_id, folder_id, name, content_type, size_bytes)
        values (${fileId}, ${org.orgId}, (select id from folders where org_id = ${org.orgId} limit 1),
                'auto.pdf', 'application/pdf', 4)`);
      await db.execute(sql`
        insert into file_versions (id, file_id, version_number, size_bytes, content_type)
        values (${versionId}, ${fileId}, 1, 4, 'application/pdf')`);
      await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${Buffer.from("%PDF")})`);
      await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${org.orgId}`);
      await db.execute(sql`
        insert into ap_capture_items
          (id, org_id, file_id, status, original_filename, content_hash,
           document_kind, normalized, validation_issues, created_by, updated_by)
        values (${captureId}, ${org.orgId}, ${fileId}, 'queued', 'auto.pdf',
                ${`auto-${randomUUID().replaceAll("-", "")}`}, 'vendor_bill',
                '{}'::jsonb, '[]'::jsonb, ${actor}, ${actor})`);
      return captureId;
    };
    const scopeA = new Set([org.subsidiaryId]);
    const invoiceA = `AUTO-SCOPE-${randomUUID().slice(0, 8)}`;
    const captureA = await queueCapture();
    await processCaptureItem({
      orgId: org.orgId, captureItemId: captureA, actorId: actor,
      allowedSubsidiaryIds: scopeA, fetchImpl: stubFetchFor(payloadFor(invoiceA, "PO-HID-AUTO")), lookup: stubLookup,
    });
    const held = (await db.execute<{ status: string; document_id: string | null; validation_issues: Array<{ code: string; severity: string }> }>(sql`
      select status, document_id, validation_issues from ap_capture_items
       where id = ${captureA} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(held.status, "needs_review", "an out-of-scope match stays in review, not failed");
    assert.equal(held.document_id, null, "an out-of-scope match creates no draft bill");
    assert.ok(
      held.validation_issues.some((issue) => issue.code === "purchase_order_out_of_scope" && issue.severity === "blocking"),
      "the hold names the out-of-scope purchase order",
    );
    const blocked = (await db.execute(sql`
      select 1 from ap_capture_events
       where org_id = ${org.orgId} and capture_item_id = ${captureA} and event_kind = 'auto_materialize_blocked'`)).rows;
    assert.equal(blocked.length, 1, "the hold is recorded as capture evidence");
    assert.equal(await billCount(org.orgId), 0, "an out-of-scope auto-match advances no billed quantity");
    assert.equal(await poBilled(org.orgId, poem), ZERO_QTY);
    // The same match under an unrestricted scope auto-materializes.
    const invoiceB = `AUTO-FREE-${randomUUID().slice(0, 8)}`;
    const captureB = await queueCapture();
    await processCaptureItem({
      orgId: org.orgId, captureItemId: captureB, actorId: actor,
      allowedSubsidiaryIds: null, fetchImpl: stubFetchFor(payloadFor(invoiceB, "PO-HID-AUTO")), lookup: stubLookup,
    });
    const freed = (await db.execute<{ status: string; document_id: string | null }>(sql`
      select status, document_id from ap_capture_items where id = ${captureB} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(freed.status, "materialized");
    assert.ok(freed.document_id);
    assert.equal(await billCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
