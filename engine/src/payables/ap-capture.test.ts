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
  type CaptureIssue,
  type NormalizedCapture,
} from "./ap-capture.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  billableRemainderUnits,
  CaptureMaterializationError,
  lineRequiresReceipt,
  materializeCapture,
  matchPurchaseOrderLine,
  processCaptureItem,
  purchaseOrderBilledQuantityDelta,
} from "./ap-capture-service.ts";
import { sealSecret } from "../platform/secrets.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

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

test("normalizeCapturedDecimal refuses ambiguous comma text instead of guessing", () => {
  // "1,234" is two readings (1234 grouped vs 1.234 decimal comma), never one
  // canonical answer: refusing by name beats storing a number nobody typed.
  assert.equal(normalizeCapturedDecimal("1,234"), null);
  assert.equal(normalizeCapturedDecimal("(1,234)"), null);
  assert.equal(normalizeCapturedDecimal("12,"), null);
  // The unambiguous localized readings are preserved, not removed: a lone
  // comma with a one-or-two-digit tail is the decimal-comma locales' money,
  // commas around dots keep the last-separator rule, and pure grouping strips.
  assert.equal(normalizeCapturedDecimal("12,34"), "12.3400");
  assert.equal(normalizeCapturedDecimal("0,50"), "0.5000");
  assert.equal(normalizeCapturedDecimal("1,234,567"), "1234567.0000");
  // A single dot is plain canonical decimal, not an ambiguous shape.
  assert.equal(normalizeCapturedDecimal("1.234"), "1.2340");
});

test("normalizeCapturedDecimal refuses multi-dot text instead of guessing the last dot", () => {
  // "1.234.567" is dot-grouping (one-point-two million) in DE/IT/ES and a
  // misread decimal elsewhere: two readings, never a guess. The old
  // last-dot-is-the-point rule turned the grouped reading into 1234.567 — a
  // 1000x understated total that looked plausible in review. Refusing keeps
  // the raw text on the draft as `supplied`, so the reviewer types what the
  // document actually said.
  assert.equal(normalizeCapturedDecimal("1.234.567"), null);
  assert.equal(normalizeCapturedDecimal("12.34.56"), null);
  assert.equal(normalizeCapturedDecimal("2026.01.15"), null);
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

function ambiguousRawPayload(): Parameters<typeof normalizeAzureInvoice>[0] {
  // Same header/line shapes as `raw`, but every money reading arrives as raw
  // OCR text with no typed provider number — nothing may disambiguate it.
  const header = (content: string) => ({ type: "currency", content, confidence: 0.9 });
  const line = (content: string) => ({ type: "string", content, confidence: 0.9 });
  return {
    status: "succeeded",
    analyzeResult: {
      documents: [{
        confidence: 0.97,
        fields: {
          VendorName: { type: "string", content: "Northwind Supplies", valueString: "Northwind Supplies", confidence: 0.99 },
          InvoiceId: { type: "string", content: "INV-1042", valueString: "INV-1042", confidence: 0.98 },
          InvoiceDate: { type: "date", content: "2026-07-01", valueDate: "2026-07-01", confidence: 0.99 },
          CurrencyCode: { type: "string", valueString: "CAD", confidence: 0.99 },
          SubTotal: header("10"),
          TotalTax: header("1,234"),
          InvoiceTotal: header("1,234"),
          Items: { valueArray: [{ valueObject: {
            Description: { valueString: "Shop supplies", confidence: 0.98 },
            Quantity: line("1,234"),
            UnitPrice: line("1,234"),
            Amount: line("1,234"),
            Tax: line("1,234"),
          } }, { valueObject: {
            // Typed provider numbers disambiguate and stay canonical.
            Description: { valueString: "Typed control", confidence: 0.98 },
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
}

test("ambiguous OCR amounts never become guessed money, defaults, or throws", () => {
  const result = normalizeAzureInvoice(ambiguousRawPayload());
  // Refused header money is preserved as raw text, never guessed or nulled
  // into a silent default.
  assert.equal(result.normalized.taxTotal, "1,234");
  assert.equal(result.normalized.total, "1,234");
  assert.equal(result.normalized.subtotal, "10.0000");
  const ambiguous = result.normalized.lines[0]!;
  assert.equal(ambiguous.quantity, "1,234");
  assert.equal(ambiguous.unitPrice, "1,234");
  assert.equal(ambiguous.amount, "1,234");
  assert.equal(ambiguous.taxAmount, "1,234");
  // Typed provider numbers on the control line stay canonical.
  const typed = result.normalized.lines[1]!;
  assert.equal(typed.quantity, "2.0000");
  assert.equal(typed.unitPrice, "5.0000");
  assert.equal(typed.amount, "10.0000");
  assert.equal(typed.taxAmount, "1.3000");
  // Validation names the refusal instead of throwing or passing silently.
  const issues = validateNormalizedCapture(result.normalized);
  const blocking = issues.filter((issue) => issue.severity === "blocking");
  assert.ok(blocking.length >= 6, `expected header + line refusals, got ${JSON.stringify(issues)}`);
  assert.ok(blocking.every((issue) => issue.code === "invalid_amount"));
  assert.ok(blocking.some((issue) => issue.field === "total" && issue.actual === "1,234"));
  assert.ok(blocking.some((issue) => issue.field === "taxTotal" && issue.actual === "1,234"));
  for (const key of ["quantity", "unitPrice", "amount", "taxAmount"] as const) {
    const refusal = blocking.find((issue) => issue.lineIndex === 0 && issue.field === key);
    assert.ok(refusal, `missing line refusal for ${key}`);
    assert.match(refusal.message ?? "", /could mean 1234 \(thousands separator\) or 1\.234 \(decimal comma\)/);
    assert.match(refusal.message ?? "", /retype it in plain digits/);
  }
});

test("truly missing capture amounts keep their long-standing defaults", () => {
  const missing = normalizeAzureInvoice(raw);
  // The shared fixture supplies typed numbers; drop the quantity entirely on
  // a copy to prove absence (not refusal) still takes the legacy defaults.
  const payload = structuredClone(raw);
  const lineFields = payload.analyzeResult.documents![0]!.fields!.Items!.valueArray![0]!.valueObject!;
  delete (lineFields as Record<string, unknown>).Quantity;
  delete (lineFields as Record<string, unknown>).Tax;
  const result = normalizeAzureInvoice(payload);
  assert.equal(result.normalized.lines[0]!.quantity, "1.0000");
  assert.equal(result.normalized.lines[0]!.taxAmount, "0.0000");
  assert.deepEqual(validateNormalizedCapture(missing.normalized), []);
});

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
      let billed = normalizeCapturedDecimal((await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed);
      assert.equal(billed, "6.1250", "a positive vendor bill increases PO billed quantity");

      const replay = await materializeCapture({ orgId: org.orgId, captureItemId: billId, actorId });
      assert.equal(replay.documentId, bill.documentId, "replaying a materialized capture is idempotent");
      billed = normalizeCapturedDecimal((await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed);
      assert.equal(billed, "6.1250");

      const creditId = await insertCapture("vendor_credit", "CREDIT-CAPTURE-REG", "2.1250");
      const credit = await materializeCapture({ orgId: org.orgId, captureItemId: creditId, actorId });
      assert.ok(credit.documentId);
      billed = normalizeCapturedDecimal((await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed);
      assert.equal(billed, "4.0000", "a positive vendor credit decreases PO billed quantity");

      const overCreditId = await insertCapture("vendor_credit", "CREDIT-CAPTURE-OVER", "4.0001");
      await assert.rejects(
        materializeCapture({ orgId: org.orgId, captureItemId: overCreditId, actorId }),
        (error: unknown) => error instanceof CaptureMaterializationError && /insufficient billed quantity/.test(error.message),
      );
      billed = normalizeCapturedDecimal((await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed);
      assert.equal(billed, "4.0000", "an over-credit cannot underflow the PO billed balance");

      const racingBillA = await insertCapture("vendor_bill", "BILL-CAPTURE-RACE-A", "4.0000");
      const racingBillB = await insertCapture("vendor_bill", "BILL-CAPTURE-RACE-B", "4.0000");
      const raced = await Promise.allSettled([
        materializeCapture({ orgId: org.orgId, captureItemId: racingBillA, actorId }),
        materializeCapture({ orgId: org.orgId, captureItemId: racingBillB, actorId }),
      ]);
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
      billed = normalizeCapturedDecimal((await db.execute<{ quantity_billed: string }>(sql`
        select quantity_billed::text from document_lines where id = ${poLineId}
      `)).rows[0]!.quantity_billed);
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

test(
  "concurrent materializes of one vendor invoice number admit only one draft",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const folderId = randomUUID();
    const fileA = randomUUID();
    const fileB = randomUUID();
    const invoiceNumber = "INV-DUP-RACE";
    const normalized = {
      vendorName: "Acme Vendor",
      vendorTaxId: null,
      invoiceNumber,
      invoiceDate: "2026-07-15",
      dueDate: null,
      purchaseOrderNumber: null,
      currency: "CAD",
      subtotal: "100.0000",
      taxTotal: "0.0000",
      total: "100.0000",
      memo: null,
      lines: [{
        description: "Race line",
        productCode: null,
        quantity: "10.0000",
        unit: "ea",
        unitPrice: "10.0000",
        amount: "100.0000",
        taxAmount: "0.0000",
        accountId: org.accounts.cogs,
        itemId: null,
        purchaseOrderLineId: null,
        confidence: "1.0000",
      }],
    };
    async function insertCapture(fileId: string): Promise<string> {
      const captureId = randomUUID();
      await db.execute(sql`
        insert into ap_capture_items
          (id, org_id, file_id, status, original_filename, content_hash,
           document_kind, normalized, validation_issues, vendor_candidate_id,
           created_by, updated_by)
        values (${captureId}, ${org.orgId}, ${fileId}, 'ready', ${invoiceNumber + '.pdf'},
                ${randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'vendor_bill',
                ${JSON.stringify(normalized)}::jsonb, '[]'::jsonb, ${org.vendorId},
                null, null)
      `);
      return captureId;
    }
    try {
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
        values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})
      `);
      await db.execute(sql`
        insert into folders (id, org_id, name)
        values (${folderId}, ${org.orgId}, 'AP capture race')
      `);
      for (const fileId of [fileA, fileB]) {
        await db.execute(sql`
          insert into files (id, org_id, folder_id, name, content_type, size_bytes)
          values (${fileId}, ${org.orgId}, ${folderId}, 'race.pdf', 'application/pdf', 4)
        `);
      }
      // Same vendor, same invoice number, two different source files — the
      // only thing standing between these and two draft bills for one invoice
      // is the materialize fence.
      const [itemA, itemB] = [await insertCapture(fileA), await insertCapture(fileB)];
      const raced = await Promise.allSettled([
        materializeCapture({ orgId: org.orgId, captureItemId: itemA, actorId: null }),
        materializeCapture({ orgId: org.orgId, captureItemId: itemB, actorId: null }),
      ]);
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = raced.filter((result) => result.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.match(
        String((rejected[0] as PromiseRejectedResult).reason),
        /already uses this source or vendor invoice number/,
      );
      const drafts = (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from documents
         where org_id = ${org.orgId} and kind = 'vendor_bill' and status <> 'voided'
           and party_id = ${org.vendorId}
           and regexp_replace(lower(nullif(reference_number, '')), '[^a-z0-9]', '', 'g') = 'invduprace'
      `)).rows[0]!.count;
      assert.equal(drafts, "1", "exactly one draft bill survives the race");
    } finally {
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

test(
  "processCaptureItem stores refused raw amounts with a named blocker",
  { skip: !DB },
  async () => {
    // Service storage proof with provider I/O stubbed and every other
    // boundary real: raw Azure text in, needs_review with raw evidence out.
    const org = await createScratchOrg();
    const folderId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    const captureId = randomUUID();
    const endpoint = "https://ob-capture-proof.cognitiveservices.azure.com";
    const money = (content: string) => ({ type: "currency", content, confidence: 0.9 });
    const payload = {
      status: "succeeded",
      analyzeResult: {
        documents: [{
          confidence: 0.97,
          fields: {
            VendorName: { type: "string", content: "Northwind Supplies", valueString: "Northwind Supplies", confidence: 0.99 },
            InvoiceId: { type: "string", content: "INV-AMB-PROOF", valueString: "INV-AMB-PROOF", confidence: 0.98 },
            InvoiceDate: { type: "date", content: "2026-07-01", valueDate: "2026-07-01", confidence: 0.99 },
            CurrencyCode: { type: "string", valueString: "CAD", confidence: 0.99 },
            SubTotal: money("10"),
            TotalTax: money("1,234"),
            InvoiceTotal: money("1,234"),
            Items: { valueArray: [{ valueObject: {
              Description: { valueString: "Ambiguous line", confidence: 0.98 },
              Quantity: money("1,234"),
              UnitPrice: money("5.0000"),
              Amount: money("10.0000"),
              Tax: money("0.0000"),
            } }] },
          },
        }],
        pages: [],
      },
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(null, {
          status: 202,
          headers: { "operation-location": `${endpoint}/result/1` },
        });
      }
      assert.ok(String(input).startsWith(endpoint), "polling stays on the provider host");
      return Response.json(payload);
    }) as typeof fetch;
    try {
      await db.execute(sql`
        insert into folders (id, org_id, name)
        values (${folderId}, ${org.orgId}, 'AP capture proof')
      `);
      await db.execute(sql`
        insert into files (id, org_id, folder_id, name, content_type, size_bytes)
        values (${fileId}, ${org.orgId}, ${folderId}, 'ambiguous.pdf', 'application/pdf', 4)
      `);
      await db.execute(sql`
        insert into file_versions (id, file_id, version_number, size_bytes, content_type)
        values (${versionId}, ${fileId}, 1, 4, 'application/pdf')
      `);
      await db.execute(sql`
        insert into file_blobs (version_id, bytes) values (${versionId}, ${Buffer.from("%PDF")})
      `);
      await db.execute(sql`
        update files set current_version_id = ${versionId}
         where id = ${fileId} and org_id = ${org.orgId}
      `);
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
          'ai', coalesce(settings->'ai', '{}'::jsonb) || ${JSON.stringify({
            enabled: true,
            documentCapture: {
              enabled: true,
              endpoint,
              model: "prebuilt-invoice",
              confidenceThreshold: "0.9000",
              keyEncrypted: sealSecret("db-proof-key"),
            },
          })}::jsonb)
         where id = ${org.orgId}
      `);
      await db.execute(sql`
        insert into ap_capture_items
          (id, org_id, file_id, status, original_filename, content_hash,
           document_kind, normalized, validation_issues, created_by, updated_by)
        values (${captureId}, ${org.orgId}, ${fileId}, 'queued', 'ambiguous.pdf',
                ${randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'vendor_bill',
                '{}'::jsonb, '[]'::jsonb, null, null)
      `);

      await processCaptureItem({ orgId: org.orgId, captureItemId: captureId });

      const item = (await db.execute<{
        status: string; normalized: NormalizedCapture; validation_issues: CaptureIssue[];
      }>(sql`
        select status, normalized, validation_issues from ap_capture_items
         where id = ${captureId} and org_id = ${org.orgId}
      `)).rows[0]!;
      assert.equal(item.status, "needs_review");
      assert.equal(item.normalized.total, "1,234", "refused header money stays raw in storage");
      assert.equal(item.normalized.lines[0]!.quantity, "1,234", "refused line money stays raw in storage");
      const refusal = item.validation_issues.find((issue) => issue.field === "total");
      assert.equal(refusal?.code, "invalid_amount");
      assert.equal(refusal?.severity, "blocking");
      assert.match(refusal?.message ?? "", /could mean 1234 \(thousands separator\) or 1\.234 \(decimal comma\)/);
      const lineRefusal = item.validation_issues.find(
        (issue) => issue.lineIndex === 0 && issue.field === "quantity",
      );
      assert.equal(lineRefusal?.code, "invalid_amount");
      const evidence = (await db.execute<{ raw_value: string | null; normalized_value: unknown }>(sql`
        select raw_value, normalized_value from ap_capture_fields
         where org_id = ${org.orgId} and field_key = 'total'
      `)).rows[0];
      assert.equal(evidence?.raw_value, "1,234", "raw OCR evidence is retained");
      const run = (await db.execute<{ status: string; raw_provider_payload: unknown }>(sql`
        select status, raw_provider_payload from ap_capture_runs
         where org_id = ${org.orgId} and capture_item_id = ${captureId}
      `)).rows[0]!;
      assert.equal(run.status, "succeeded");
      assert.ok(run.raw_provider_payload, "raw provider payload is retained");
    } finally {
      globalThis.fetch = previousFetch;
      // Canonical teardown owns all capture/evidence/blob cleanup, including
      // the append-only trigger handling — no test-local DDL.
      await dropScratchOrg(org.orgId);
    }
  },
);

test("PO match requires a receipt when an item-backed line has no kind", () => {
  assert.equal(lineRequiresReceipt(null), true);
  assert.deepEqual(
    matchPurchaseOrderLine({
      ...stockPoLine,
      itemKind: null,
      fulfilledQuantity: "0.0000",
      invoiceUnitPrice: "10.0000",
    }).map((matchIssue) => matchIssue.code),
    ["receipt_quantity_shortfall"],
  );
  assert.equal(billableRemainderUnits({
    orderedQuantity: "10.0000",
    billedQuantity: "0.0000",
    fulfilledQuantity: "0.0000",
    itemId: "item-1",
    itemKind: null,
  }), 0n);
  assert.equal(lineRequiresReceipt("service"), false);
});
