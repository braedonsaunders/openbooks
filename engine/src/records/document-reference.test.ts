import assert from "node:assert/strict";
import test from "node:test";
import { isReferenceDuplicateKind, normalizeDocumentReference } from "./document-reference.ts";

test("vendor references compare without case, spacing or punctuation", () => {
  const forms = ["INV-0042", "inv 0042", "#Inv0042", " INV/0042 ", "inv.00.42"];
  for (const form of forms) assert.equal(normalizeDocumentReference(form), "inv0042");
  // Leading zeros are significant: 42 and 0042 are different invoice numbers.
  assert.notEqual(normalizeDocumentReference("INV-42"), normalizeDocumentReference("INV-0042"));
});

test("a reference with nothing identifying left matches nothing", () => {
  for (const blank of [null, undefined, "", "   ", "#", "--/--"]) {
    assert.equal(normalizeDocumentReference(blank), null);
  }
});

test("bills and vendor credits match by reference; customer invoices do not", () => {
  assert.equal(isReferenceDuplicateKind("vendor_bill"), true);
  assert.equal(isReferenceDuplicateKind("vendor_credit"), true);
  assert.equal(isReferenceDuplicateKind("customer_invoice"), false);
});

test("international references retain their identifying letters and digits", () => {
  assert.equal(normalizeDocumentReference("発票-１２３"), "発票１２３");
  assert.equal(normalizeDocumentReference("事实-42"), "事实42");
  assert.notEqual(normalizeDocumentReference("发票-42"), normalizeDocumentReference("事实-42"));
});
