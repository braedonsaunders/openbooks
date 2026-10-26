import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedCapture } from "@openbooks/engine/payables/ap-capture";
import { captureAttentionKeys, captureFieldOrder, nextAttentionKey } from "./attention";

const FORM: NormalizedCapture = {
  vendorName: "Acme",
  vendorTaxId: null,
  invoiceNumber: "INV-1",
  invoiceDate: "2026-10-01",
  dueDate: null,
  purchaseOrderNumber: null,
  currency: "USD",
  subtotal: "100.00",
  taxTotal: "0.00",
  total: "100.00",
  memo: null,
  lines: [
    {
      description: "Freight",
      productCode: null,
      quantity: "1",
      unit: null,
      unitPrice: "100.00",
      amount: "100.00",
      taxAmount: "0.00",
      accountId: "acct-1",
      itemId: null,
      purchaseOrderLineId: null,
      confidence: null,
    },
  ],
};

test("a complete, confident capture needs no attention", () => {
  const keys = captureAttentionKeys({
    form: FORM,
    vendorId: "v1",
    issues: [],
    evidence: [{ fieldKey: "invoiceNumber", lineIndex: null, confidence: "0.99" }],
    threshold: "0.9000",
  });
  assert.deepEqual([...keys], []);
});

test("empty required fields, named issues and low confidence each mark their field", () => {
  const keys = captureAttentionKeys({
    form: { ...FORM, invoiceNumber: "", lines: [{ ...FORM.lines[0]!, accountId: null }] },
    vendorId: "",
    issues: [
      { code: "total_mismatch", severity: "blocking", expected: "100.00", actual: "90.00" },
      { code: "po_price_variance", severity: "blocking", lineIndex: 0 },
    ],
    evidence: [
      { fieldKey: "invoiceDate", lineIndex: null, confidence: "0.40" },
      { fieldKey: "lines.amount", lineIndex: 0, confidence: "0.50" },
      { fieldKey: "dueDate", lineIndex: null, confidence: null },
    ],
    threshold: "0.9000",
  });
  assert.deepEqual(
    captureFieldOrder(1).filter((key) => keys.has(key)),
    [
      "vendor",
      "invoiceNumber",
      "invoiceDate",
      "line:0:account",
      "line:0:unitPrice",
      "line:0:amount",
      "total",
    ],
  );
});

test("Enter cycles through unconfirmed attention fields in form order and wraps", () => {
  const order = captureFieldOrder(1);
  const attention = new Set(["vendor", "invoiceDate", "total"]);
  assert.equal(nextAttentionKey(order, attention, new Set(), null), "vendor");
  assert.equal(nextAttentionKey(order, attention, new Set(["vendor"]), "vendor"), "invoiceDate");
  assert.equal(
    nextAttentionKey(order, attention, new Set(["vendor", "invoiceDate"]), "invoiceDate"),
    "total",
  );
  assert.equal(
    nextAttentionKey(order, attention, new Set(["invoiceDate"]), "total"),
    "vendor",
    "it wraps to an earlier unconfirmed field",
  );
  assert.equal(
    nextAttentionKey(order, attention, new Set(["vendor", "invoiceDate", "total"]), "total"),
    null,
  );
});
