import assert from "node:assert/strict";
import test from "node:test";
import {
  BUYER_KIND,
  comparePairedDocuments,
  pairSideOf,
  SELLER_KIND,
  type PairedDocumentSummary,
} from "./pairing-compare.ts";

function doc(overrides: Partial<PairedDocumentSummary> = {}): PairedDocumentSummary {
  return {
    documentId: "d",
    documentNumber: "INV-1",
    status: "posted",
    currency: "USD",
    total: "1000.0000",
    quantities: { item: "10.00000000" },
    ...overrides,
  };
}

test("each sales kind pairs with exactly one purchase kind", () => {
  assert.deepEqual(pairSideOf("sales_order"), { pairKind: "order", side: "seller" });
  assert.deepEqual(pairSideOf("purchase_order"), { pairKind: "order", side: "buyer" });
  assert.deepEqual(pairSideOf("customer_invoice"), { pairKind: "invoice", side: "seller" });
  assert.deepEqual(pairSideOf("vendor_bill"), { pairKind: "invoice", side: "buyer" });
  assert.deepEqual(pairSideOf("customer_credit"), { pairKind: "credit", side: "seller" });
  assert.deepEqual(pairSideOf("vendor_credit"), { pairKind: "credit", side: "buyer" });
  assert.equal(pairSideOf("journal"), null);
  for (const kind of Object.keys(SELLER_KIND) as (keyof typeof SELLER_KIND)[]) {
    assert.equal(pairSideOf(BUYER_KIND[kind])?.pairKind, pairSideOf(SELLER_KIND[kind])?.pairKind);
  }
});

test("agreeing documents in the same lifecycle are in sync", () => {
  assert.deepEqual(comparePairedDocuments(doc(), doc({ documentId: "b" })), {
    state: "in_sync",
    mismatches: [],
  });
});

test("a posted side against a draft side awaits its counterpart rather than mismatching", () => {
  const result = comparePairedDocuments(doc(), doc({ status: "draft" }));
  assert.equal(result.state, "awaiting_counterpart");
  assert.deepEqual(result.mismatches, []);
});

test("amount, currency, quantity and voided sides are named mismatches", () => {
  const amount = comparePairedDocuments(doc(), doc({ total: "990.0000" }));
  assert.equal(amount.state, "mismatched");
  assert.deepEqual(amount.mismatches, [
    { kind: "amount", seller: "1000.0000", buyer: "990.0000", difference: "10.0000" },
  ]);

  const currency = comparePairedDocuments(doc(), doc({ currency: "CAD" }));
  assert.deepEqual(currency.mismatches, [{ kind: "currency", seller: "USD", buyer: "CAD" }]);

  const quantity = comparePairedDocuments(doc(), doc({ quantities: { item: "9", extra: "1" } }));
  assert.deepEqual(quantity.mismatches, [
    { kind: "quantity", itemId: "extra", seller: "0", buyer: "1" },
    { kind: "quantity", itemId: "item", seller: "10.00000000", buyer: "9" },
  ]);

  const voided = comparePairedDocuments(doc(), doc({ status: "voided" }));
  assert.equal(voided.state, "mismatched");
  assert.deepEqual(voided.mismatches, [{ kind: "voided", side: "buyer" }]);
});

test("quantities compare at their full eight-decimal precision", () => {
  const result = comparePairedDocuments(
    doc({ quantities: { item: "1.00000001" } }),
    doc({ quantities: { item: "1" } }),
  );
  assert.equal(result.state, "mismatched");
  assert.equal(result.mismatches[0]?.kind, "quantity");
});

test("a negative difference keeps its sign", () => {
  const result = comparePairedDocuments(doc({ total: "990.0000" }), doc());
  assert.deepEqual(result.mismatches, [
    { kind: "amount", seller: "990.0000", buyer: "1000.0000", difference: "-10.0000" },
  ]);
});
