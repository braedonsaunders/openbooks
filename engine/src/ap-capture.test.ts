import assert from "node:assert/strict";
import test from "node:test";
import {
  captureContentMatchesMime,
  extractAzureInvoice,
  normalizeAzureInvoice,
  normalizeCapturedDecimal,
  validateNormalizedCapture,
  validatePurchaseOrderQuantities,
} from "./ap-capture.ts";
import { billableRemainderUnits, matchPurchaseOrderLine } from "./ap-capture-service.ts";

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
