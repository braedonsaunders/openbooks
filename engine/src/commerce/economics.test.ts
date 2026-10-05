import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateAcrossLines,
  attributeRefundLines,
  channelLineGrossMinor,
  marginPercentText,
  type RefundLineInput,
} from "./economics.ts";

const LINES = [
  { key: "line:0", gross: 5000n, itemId: "item-tee", sku: "TEE-RED-M", promotionCode: "SAVE10", qtyWeight: 200000000n },
  { key: "line:1", gross: 1200n, itemId: "item-mug", sku: "MUG-WHITE", promotionCode: null, qtyWeight: 100000000n },
  { key: "ship:0", gross: 600n, itemId: null, sku: null, promotionCode: null, qtyWeight: 600n },
];

test("line gross rounds half-up on fractional quantities", () => {
  assert.equal(channelLineGrossMinor(100n, "1.5"), 150n);
  assert.equal(channelLineGrossMinor(100n, "2"), 200n);
  // Unreadable quantities never refuse the recompute; they weigh one unit.
  assert.equal(channelLineGrossMinor(100n, "many"), 100n);
});

test("allocation sums exactly to the source total", () => {
  const rows = allocateAcrossLines(-450n, LINES, (line, amount) => ({
    lineKey: line?.key ?? "order",
    component: "shipping_label",
    sourceKind: "label",
    sourceRef: "label:1:CAD",
    currency: "CAD",
    amountMinor: amount,
    itemId: line?.itemId ?? null,
    sku: line?.sku ?? null,
    promotionCode: line?.promotionCode ?? null,
    estimated: false,
  }));
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((sum, row) => sum + row.amountMinor, 0n), -450n);
});

test("a zero-weight total books to the order row instead of dividing", () => {
  const rows = allocateAcrossLines(-50n, [], (line, amount) => ({
    lineKey: line?.key ?? "order",
    component: "processor_fee",
    sourceKind: "estimate",
    sourceRef: "rate:channel",
    currency: "CAD",
    amountMinor: amount,
    itemId: null,
    sku: null,
    promotionCode: null,
    estimated: true,
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.lineKey, "order");
  assert.equal(rows[0]!.amountMinor, -50n);
});

test("refunds attribute to the returned lines and fees earn back positive", () => {
  const inputs: RefundLineInput[] = [
    { docLineId: "rl-1", itemId: "item-tee", amountMinor: -2500n, isRestockingFee: false },
    { docLineId: "rl-2", itemId: "item-mug", amountMinor: -1200n, isRestockingFee: false },
    { docLineId: "rl-fee", itemId: null, amountMinor: -500n, isRestockingFee: true },
  ];
  const attributed = attributeRefundLines(inputs, LINES);
  const returns = attributed.filter((row) => row.component === "returns");
  assert.equal(returns.reduce((sum, row) => sum + row.amountMinor, 0n), -3700n);
  assert.ok(returns.every((row) => row.lineKey === "line:0" || row.lineKey === "line:1"));
  const fees = attributed.filter((row) => row.component === "restocking_fee");
  // The 500 fee credit earns back as positive margin across returned lines.
  assert.equal(fees.reduce((sum, row) => sum + row.amountMinor, 0n), 500n);
  assert.ok(fees.every((row) => row.amountMinor > 0n));
});

test("an unattributable refund still moves the margin at order level", () => {
  const inputs: RefundLineInput[] = [
    { docLineId: "rl-x", itemId: "item-gone", amountMinor: -999n, isRestockingFee: false },
  ];
  const attributed = attributeRefundLines(inputs, LINES);
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0]!.lineKey, "order");
  assert.equal(attributed[0]!.amountMinor, -999n);
});

test("margin percent derives from stored sums with 4dp precision", () => {
  assert.equal(marginPercentText(4950n, 6300n), "78.5714");
  assert.equal(marginPercentText(0n, 6300n), "0.0000");
  assert.equal(marginPercentText(4950n, 0n), null);
  assert.equal(marginPercentText(-100n, 6300n), "-1.5873");
});
