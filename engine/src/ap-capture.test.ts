import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  captureContentMatchesMime,
  extractAzureInvoice,
  normalizeAzureInvoice,
  normalizeCapturedDecimal,
  validateNormalizedCapture,
  validatePurchaseOrderQuantities,
  type NormalizedCapture,
} from "./ap-capture.ts";
import { db } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import {
  billableRemainderUnits,
  CaptureMaterializationError,
  materializeCapture,
  matchPurchaseOrderLine,
  purchaseOrderBilledQuantityDelta,
} from "./ap-capture-service.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("upload signature validation accepts supported formats and rejects mislabeled content", () => {
  assert.equal(captureContentMatchesMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf"), true);
  assert.equal(captureContentMatchesMime(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"), true);
  assert.equal(captureContentMatchesMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
  assert.equal(captureContentMatchesMime(new Uint8Array([0x49, 0x49, 0x2a, 0x00]), "image/tiff"), true);
  assert.equal(captureContentMatchesMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "image/png"), false);
});

test("normalizeCapturedDecimal handles localized and signed OCR amounts exactly", () => {
  assert.equal(normalizeCapturedDecimal("$1,234.56"), "1234.5600");
  assert.equal(normalizeCapturedDecimal("1.234,56 EUR"), "1234.5600");
  assert.equal(normalizeCapturedDecimal("(45.10)"), "-45.1000");
  assert.equal(normalizeCapturedDecimal("1.25E2"), "125.0000");
  assert.throws(() => normalizeCapturedDecimal("1.00001"), /precision/);
});

const raw = {
  status: "succeeded",
  analyzeResult: {
    documents: [{
      confidence: 0.97,
      fields: {
        VendorName: { type: "string", content: "Northwind Supplies", valueString: "Northwind Supplies", confidence: 0.99, boundingRegions: [{ pageNumber: 1, polygon: [1, 1, 3, 1, 3, 2, 1, 2] }] },
        InvoiceId: { type: "string", content: "INV-1042", valueString: "INV-1042", confidence: 0.98 },
        InvoiceDate: { type: "date", content: "2026-07-01", valueDate: "2026-07-01", confidence: 0.99 },
        CurrencyCode: { type: "string", valueString: "CAD", confidence: 0.99 },
        SubTotal: { type: "currency", valueCurrency: { amount: 10, currencyCode: "CAD" }, confidence: 0.97 },
        TotalTax: { type: "currency", valueCurrency: { amount: 1.3, currencyCode: "CAD" }, confidence: 0.96 },
        InvoiceTotal: { type: "currency", valueCurrency: { amount: 11.3, currencyCode: "CAD" }, confidence: 0.98 },
        Items: { valueArray: [{ valueObject: {
          Description: { valueString: "Shop supplies", confidence: 0.98 },
          Quantity: { valueNumber: 2, confidence: 0.98 },
          UnitPrice: { valueCurrency: { amount: 5 }, confidence: 0.98 },
          Amount: { valueCurrency: { amount: 10 }, confidence: 0.98 },
          Tax: { valueCurrency: { amount: 1.3 }, confidence: 0.95 },
        } }] },
      },
    }],
    pages: [{ pageNumber: 1, width: 8.5, height: 11 }],
  },
};

test("Azure normalization preserves line evidence and exact invoice math", () => {
  const result = normalizeAzureInvoice(raw);
  assert.equal(result.normalized.total, "11.3000");
  assert.equal(result.normalized.lines[0]!.amount, "10.0000");
  assert.equal(result.overallConfidence, "0.9700");
  assert.ok(result.evidence.some((field) => field.fieldKey === "lines.amount" && field.lineIndex === 0));
  assert.deepEqual(result.evidence.find((field) => field.fieldKey === "vendorName")?.polygon, {
    points: [1, 1, 3, 1, 3, 2, 1, 2], width: 8.5, height: 11,
  });
  assert.deepEqual(validateNormalizedCapture(result.normalized), []);
});

test("validation blocks silent total and line math errors", () => {
  const result = normalizeAzureInvoice(raw).normalized;
  result.lines[0]!.amount = "9.9900";
  result.total = "999.0000";
  const codes = validateNormalizedCapture(result).map((issue) => issue.code);
  assert.ok(codes.includes("line_math_mismatch"));
  assert.ok(codes.includes("subtotal_mismatch"));
  assert.ok(codes.includes("total_mismatch"));
});

test("validation rejects impossible dates, currencies and numeric overflow", () => {
  const result = normalizeAzureInvoice(raw).normalized;
  result.invoiceDate = "2026-02-30";
  result.currency = "Canadian dollars";
  result.lines[0]!.amount = "1000000000000000.0000";
  const codes = validateNormalizedCapture(result).map((issue) => issue.code);
  assert.ok(codes.includes("invalid_date"));
  assert.ok(codes.includes("invalid_currency"));
  assert.ok(codes.includes("amount_out_of_range"));
});

test("Azure adapter submits bytes and polls the provider operation", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (request, init) => {
    const url = String(request);
    calls.push(url);
    if (init?.method === "POST") {
      assert.equal(init.headers && new Headers(init.headers).get("Content-Type"), "application/pdf");
      return new Response(null, { status: 202, headers: { "operation-location": "https://demo.cognitiveservices.azure.com/result/1" } });
    }
    return Response.json(raw);
  };
  const result = await extractAzureInvoice({
    endpoint: "https://demo.cognitiveservices.azure.com",
    apiKey: "secret",
    contentType: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70]),
    fetchImpl: fakeFetch,
  });
  assert.equal(result.normalized.invoiceNumber, "INV-1042");
  assert.match(calls[0]!, /documentintelligence\/documentModels\/prebuilt-invoice:analyze/);
  assert.equal(calls.length, 2);
});

test("Azure adapter rejects non-provider endpoints before making a request", async () => {
  await assert.rejects(
    extractAzureInvoice({
      endpoint: "https://127.0.0.1",
      apiKey: "secret",
      contentType: "application/pdf",
      bytes: new Uint8Array(),
      fetchImpl: async () => { throw new Error("must not run"); },
    }),
    /not an Azure Document Intelligence endpoint/,
  );
});

test("PO matching enforces both ordered and received quantities exactly", () => {
  assert.deepEqual(validatePurchaseOrderQuantities({
    invoiceQuantity: "2.0000", orderedQuantity: "10.0000", billedQuantity: "8.5000",
    fulfilledQuantity: "9.0000", requiresReceipt: true,
  }), [
    { code: "po_quantity_exceeded", expected: "1.5000", actual: "2.0000" },
    { code: "receipt_quantity_shortfall", expected: "0.5000", actual: "2.0000" },
  ]);
  assert.deepEqual(validatePurchaseOrderQuantities({
    invoiceQuantity: "0.3333", orderedQuantity: "1.0000", billedQuantity: "0.3333",
    fulfilledQuantity: "0.6666", requiresReceipt: true,
  }), []);
  assert.deepEqual(validatePurchaseOrderQuantities({
    invoiceQuantity: "1.0000", orderedQuantity: "1.0000", billedQuantity: "0.0000",
    fulfilledQuantity: "0.0000", requiresReceipt: false,
  }), []);
});

const stockPoLine = {
  invoiceQuantity: "6.0000",
  orderedQuantity: "10.0000",
  billedQuantity: "0.0000",
  fulfilledQuantity: "6.0000",
  poUnitPrice: "10.0000",
  itemId: "item-1",
  itemKind: "inventory",
};

test("PO match refuses an off-price capture the quantity and receipt legs would pass", () => {
  // Quantities clear both legs (6 ≤ 10 ordered, 6 ≤ 6 received), but +50% on
  // unit price is far outside tolerance and must block, not ride through.
  const codes = matchPurchaseOrderLine({ ...stockPoLine, invoiceUnitPrice: "15.0000" })
    .map((matchIssue) => matchIssue.code);
  assert.ok(codes.includes("po_price_variance"));
  const variance = matchPurchaseOrderLine({ ...stockPoLine, invoiceUnitPrice: "15.0000" })
    .find((matchIssue) => matchIssue.code === "po_price_variance");
  assert.deepEqual(variance, { code: "po_price_variance", expected: "10.0000", actual: "15.0000" });
  // The receipt leg cannot be routed around on either channel: an unreceived
  // stock line bills nothing, even with ordered quantity remaining.
  assert.deepEqual(
    matchPurchaseOrderLine({ ...stockPoLine, invoiceUnitPrice: "10.0000", fulfilledQuantity: "0.0000" })
      .map((matchIssue) => matchIssue.code),
    ["receipt_quantity_shortfall"],
  );
  assert.equal(billableRemainderUnits({
    orderedQuantity: "10.0000", billedQuantity: "0.0000", fulfilledQuantity: "0.0000",
    itemId: "item-1", itemKind: "inventory",
  }), 0n);
});

test("PO match accepts captures within the price tolerance unchanged", () => {
  assert.deepEqual(matchPurchaseOrderLine({ ...stockPoLine, invoiceUnitPrice: "10.1500" }), []);
  assert.deepEqual(matchPurchaseOrderLine({ ...stockPoLine, invoiceUnitPrice: "10.2000" }), []);
});

test("PO capture billing deltas move in the document's commercial direction", () => {
  assert.equal(purchaseOrderBilledQuantityDelta("vendor_bill", "2.1250"), "2.1250");
  assert.equal(purchaseOrderBilledQuantityDelta("vendor_credit", "2.1250"), "-2.1250");
  assert.throws(
    () => purchaseOrderBilledQuantityDelta("vendor_credit", "0.0000"),
    /quantity must be positive/,
  );
});

test("PO vendor credits release billed quantity and reject over-credit", () => {
  assert.deepEqual(
    matchPurchaseOrderLine({
      ...stockPoLine,
      billedQuantity: "6.0000",
      fulfilledQuantity: "6.0000",
      invoiceUnitPrice: "10.0000",
      documentKind: "vendor_credit",
    }),
    [],
  );
  assert.deepEqual(
    matchPurchaseOrderLine({
      ...stockPoLine,
      billedQuantity: "1.0000",
      fulfilledQuantity: "6.0000",
      invoiceUnitPrice: "10.0000",
      documentKind: "vendor_credit",
    }).map((matchIssue) => matchIssue.code),
    ["po_quantity_exceeded"],
  );
});

function captureNormalized(
  invoiceNumber: string,
  quantity: string,
  purchaseOrderLineId: string,
  accountId: string,
): NormalizedCapture {
  const amount = fromUnits((toUnits(quantity) * toUnits("10.0000")) / 10_000n);
  return {
    vendorName: "Acme Vendor",
    vendorTaxId: null,
    invoiceNumber,
    invoiceDate: "2026-07-15",
    dueDate: null,
    purchaseOrderNumber: null,
    currency: "CAD",
    subtotal: amount,
    taxTotal: "0.0000",
    total: amount,
    memo: null,
    lines: [{
      description: "Regression line",
      productCode: null,
      quantity,
      unit: "ea",
      unitPrice: "10.0000",
      amount,
      taxAmount: "0.0000",
      accountId,
      itemId: null,
      purchaseOrderLineId,
      confidence: "1.0000",
    }],
  };
}

test(
  "AP capture advances and releases PO billed quantity transactionally",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = null;
    const poId = randomUUID();
    const poLineId = randomUUID();
    const folderId = randomUUID();
    const fileId = randomUUID();
    try {
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
        values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})
      `);
      await db.execute(sql`
        insert into folders (id, org_id, name)
        values (${folderId}, ${org.orgId}, 'AP capture regression')
      `);
      await db.execute(sql`
        insert into files (id, org_id, folder_id, name, content_type, size_bytes)
        values (${fileId}, ${org.orgId}, ${folderId}, 'capture.pdf', 'application/pdf', 4)
      `);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, party_id, subsidiary_id,
           document_date, currency, subtotal, tax_total, total, created_by)
        values (${poId}, ${org.orgId}, 'purchase_order', 'draft', 'PO-CAPTURE-REG',
                ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, 'CAD', 100, 0, 100, ${actorId})
      `);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description,
           quantity, unit, unit_price, amount, tax_amount, is_billable,
           quantity_fulfilled, quantity_billed, custom, extra_dims)
        values (${poLineId}, ${org.orgId}, ${poId}, 1, null, ${org.accounts.cogs},
                'PO regression line', 10, 'ea', 10, 100, 0, false, 0, 4, '{}'::jsonb, '{}'::jsonb)
      `);
      await db.execute(sql`
        update documents set status = 'approved', updated_at = now()
         where id = ${poId} and org_id = ${org.orgId}
      `);

      async function insertCapture(
        documentKind: "vendor_bill" | "vendor_credit",
        invoiceNumber: string,
        quantity: string,
      ): Promise<string> {
        const captureId = randomUUID();
        const normalized = captureNormalized(invoiceNumber, quantity, poLineId, org.accounts.cogs);
        await db.execute(sql`
          insert into ap_capture_items
            (id, org_id, file_id, status, original_filename, content_hash,
             document_kind, normalized, validation_issues, vendor_candidate_id, purchase_order_id,
             created_by, updated_by)
          values (${captureId}, ${org.orgId}, ${fileId}, 'ready', ${invoiceNumber + '.pdf'},
                  ${randomUUID().replaceAll('-', '').padEnd(64, '0')}, ${documentKind},
                  ${JSON.stringify(normalized)}::jsonb, '[]'::jsonb, ${org.vendorId}, ${poId},
                  ${actorId}, ${actorId})
        `);
        return captureId;
      }

      const billId = await insertCapture("vendor_bill", "BILL-CAPTURE-REG", "2.1250");
      const bill = await materializeCapture({ orgId: org.orgId, captureItemId: billId, actorId });
      assert.ok(bill.documentId);
      let billed = (await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed;
      assert.equal(billed, "6.1250", "a positive vendor bill increases PO billed quantity");

      const replay = await materializeCapture({ orgId: org.orgId, captureItemId: billId, actorId });
      assert.equal(replay.documentId, bill.documentId, "replaying a materialized capture is idempotent");
      billed = (await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed;
      assert.equal(billed, "6.1250");

      const creditId = await insertCapture("vendor_credit", "CREDIT-CAPTURE-REG", "2.1250");
      const credit = await materializeCapture({ orgId: org.orgId, captureItemId: creditId, actorId });
      assert.ok(credit.documentId);
      billed = (await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed;
      assert.equal(billed, "4.0000", "a positive vendor credit decreases PO billed quantity");

      const overCreditId = await insertCapture("vendor_credit", "CREDIT-CAPTURE-OVER", "4.0001");
      await assert.rejects(
        materializeCapture({ orgId: org.orgId, captureItemId: overCreditId, actorId }),
        (error: unknown) => error instanceof CaptureMaterializationError && /insufficient billed quantity/.test(error.message),
      );
      billed = (await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed;
      assert.equal(billed, "4.0000", "an over-credit cannot underflow the PO billed balance");

      const racingBillA = await insertCapture("vendor_bill", "BILL-CAPTURE-RACE-A", "4.0000");
      const racingBillB = await insertCapture("vendor_bill", "BILL-CAPTURE-RACE-B", "4.0000");
      const raced = await Promise.allSettled([
        materializeCapture({ orgId: org.orgId, captureItemId: racingBillA, actorId }),
        materializeCapture({ orgId: org.orgId, captureItemId: racingBillB, actorId }),
      ]);
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
      billed = (await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed;
      assert.equal(billed, "8.0000", "the locked PO line admits only one concurrent bill");
    } finally {
      // Capture evidence is intentionally append-only in production. Remove
      // this disposable fixture's events through a transaction-local trigger
      // disable before the generic scratch wipe reaches its source files.
      await db.transaction(async (tx) => {
        await tx.execute(sql`alter table public.ap_capture_events disable trigger ap_capture_events_append_only`);
        await tx.execute(sql`delete from ap_capture_events where org_id = ${org.orgId}`);
        await tx.execute(sql`alter table public.ap_capture_events enable trigger ap_capture_events_append_only`);
        await tx.execute(sql`delete from ap_capture_items where org_id = ${org.orgId}`);
      });
      await dropScratchOrg(org.orgId);
    }
  },
);
