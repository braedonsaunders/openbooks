import assert from "node:assert/strict";
import test from "node:test";
import { quoteFromRate, sumComponentTax } from "./tax-rate-providers.ts";
import { summarizeSettlement, parseStripeBalanceTransactions, parseRecurlySettlement } from "./psp-settlement.ts";
import { assertTracking } from "./inventory.ts";
import { InventoryError } from "./inventory.ts";
import { prorate } from "./subscription-billing.ts";

test("quoteFromRate builds component evidence", () => {
  const q = quoteFromRate("100.0000", 13, "CA-ON", "HST");
  assert.equal(q.taxAmount, "13.0000");
  assert.equal(q.components[0]!.ratePercent, "13.0000");
  assert.equal(sumComponentTax(q.components), "13.0000");
});

test("summarizeSettlement rolls charges fees refunds fx", () => {
  const s = summarizeSettlement([
    { kind: "charge", amount: "100.0000" },
    { kind: "charge", amount: "50.0000" },
    { kind: "fee", amount: "4.5000" },
    { kind: "refund", amount: "10.0000" },
    { kind: "fx_adjustment", amount: "0.2500" },
  ]);
  assert.equal(s.grossAmount, "150.0000");
  assert.equal(s.feeAmount, "4.5000");
  assert.equal(s.refundAmount, "10.0000");
  assert.equal(s.netAmount, "135.7500");
});

test("parseStripeBalanceTransactions converts cents", () => {
  const p = parseStripeBalanceTransactions(
    [{ id: "txn_1", type: "charge", amount: 1250, fee: 36, currency: "usd", description: "Invoice" }],
    "po_1",
    "2026-07-01",
  );
  assert.equal(p.provider, "stripe");
  assert.equal(p.externalRef, "po_1");
  assert.ok(p.lines.some((l) => l.kind === "charge"));
  assert.ok(p.lines.some((l) => l.kind === "fee"));
});

test("parseRecurlySettlement maps lines", () => {
  const p = parseRecurlySettlement({
    id: "r_1",
    closed_at: "2026-06-15T00:00:00Z",
    currency: "USD",
    lines: [
      { type: "charge", amount: "99.00", id: "l1" },
      { type: "fee", amount: "2.90", id: "l2" },
    ],
  });
  assert.equal(p.lines.length, 2);
  assert.equal(summarizeSettlement(p.lines).feeAmount, "2.9000");
});

test("assertTracking enforces lot and serial", () => {
  assert.throws(() => assertTracking({ tracking: "lot" }, { quantity: "1" }, "receipt"), InventoryError);
  assert.throws(() => assertTracking({ tracking: "serial" }, { quantity: "2", serialId: "x" }, "issue"), InventoryError);
  assert.doesNotThrow(() => assertTracking({ tracking: "lot" }, { quantity: "5", lotId: "l1" }, "receipt"));
  assert.doesNotThrow(() => assertTracking({ tracking: "none" }, { quantity: "5" }, "receipt"));
});

test("prorate remains exact for subscription plan change", () => {
  assert.equal(prorate("310.0000", "2026-01-01", "2026-02-01", "2026-01-16"), "160.0000");
});
