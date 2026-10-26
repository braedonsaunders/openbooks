import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../money/money.ts";
import {
  cashSuggestions,
  changeDue,
  expectedDrawerCash,
  priceCart,
  proratedReturnUnits,
  totalDenominationCount,
} from "./cart.ts";
import { PosError } from "./errors.ts";

const u = (value: string) => toUnits(value);

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof PosError, `expected a register refusal, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected a refusal");
}

test("an order discount is prorated by largest remainder and sums exactly to the discount", () => {
  const cart = priceCart(
    [
      { quantity: "1", unitPrice: "1.00" },
      { quantity: "1", unitPrice: "1.00" },
      { quantity: "1", unitPrice: "1.00" },
    ],
    { kind: "amount", value: "1.00" },
    2,
  );
  assert.deepEqual(
    cart.lines.map((line) => line.orderDiscountUnits),
    [u("0.34"), u("0.33"), u("0.33")],
  );
  assert.equal(cart.orderDiscountUnits, u("1.00"));
  assert.equal(cart.netUnits, u("2.00"));
  assert.equal(
    cart.lines.reduce((total, line) => total + line.netUnits, 0n),
    cart.netUnits,
  );
});

test("an order discount weights lines by their discounted amount and never exceeds a line", () => {
  const cart = priceCart(
    [
      { quantity: "2", unitPrice: "10.00", discount: { kind: "percent", value: "50" } },
      { quantity: "1", unitPrice: "0.01" },
    ],
    { kind: "amount", value: "50.00" },
    2,
  );
  // The order discount is capped at the 10.01 the discounted lines are worth.
  assert.equal(cart.orderDiscountUnits, u("10.01"));
  assert.deepEqual(
    cart.lines.map((line) => line.netUnits),
    [0n, 0n],
  );
  for (const line of cart.lines)
    assert.ok(line.orderDiscountUnits <= line.grossUnits - line.lineDiscountUnits);
});

test("quantity times price rounds once to the currency minor unit", () => {
  const cart = priceCart([{ quantity: "0.735", unitPrice: "12.00" }], null, 2);
  assert.equal(cart.lines[0]!.grossUnits, u("8.82"));
  const precise = priceCart([{ quantity: "3", unitPrice: "0.3333" }], null, 2);
  assert.equal(precise.lines[0]!.grossUnits, u("1.00"));
});

test("a percent line discount rounds to cents and an amount discount is capped at the line", () => {
  const cart = priceCart(
    [
      { quantity: "1", unitPrice: "9.99", discount: { kind: "percent", value: "15" } },
      { quantity: "1", unitPrice: "5.00", discount: { kind: "amount", value: "7.00" } },
    ],
    null,
    2,
  );
  assert.equal(cart.lines[0]!.lineDiscountUnits, u("1.50"));
  assert.equal(cart.lines[1]!.lineDiscountUnits, u("5.00"));
  assert.equal(cart.lines[1]!.netUnits, 0n);
});

test("a zero-decimal currency prorates whole units only", () => {
  const cart = priceCart(
    [
      { quantity: "1", unitPrice: "100" },
      { quantity: "1", unitPrice: "100" },
      { quantity: "1", unitPrice: "100" },
    ],
    { kind: "percent", value: "10" },
    0,
  );
  assert.equal(cart.orderDiscountUnits, u("30"));
  for (const line of cart.lines) assert.equal(line.orderDiscountUnits % u("1"), 0n);
  assert.equal(
    refusalCode(() =>
      priceCart([{ quantity: "1", unitPrice: "100" }], { kind: "amount", value: "0.50" }, 0),
    ),
    "invalid_input",
  );
});

test("malformed quantities, prices and discounts are refused rather than coerced", () => {
  assert.equal(
    refusalCode(() => priceCart([{ quantity: "0", unitPrice: "1.00" }], null, 2)),
    "invalid_input",
  );
  assert.equal(
    refusalCode(() => priceCart([{ quantity: "1,5", unitPrice: "1.00" }], null, 2)),
    "invalid_input",
  );
  assert.equal(
    refusalCode(() => priceCart([{ quantity: "1", unitPrice: "-1.00" }], null, 2)),
    "invalid_input",
  );
  assert.equal(
    refusalCode(() =>
      priceCart(
        [{ quantity: "1", unitPrice: "1.00", discount: { kind: "percent", value: "120" } }],
        null,
        2,
      ),
    ),
    "invalid_input",
  );
  assert.equal(
    refusalCode(() =>
      priceCart(
        [{ quantity: "1", unitPrice: "1.00", discount: { kind: "amount", value: "0.005" } }],
        null,
        2,
      ),
    ),
    "invalid_input",
  );
});

test("change is owed only when the cash covers the amount due", () => {
  assert.equal(changeDue(u("17.35"), u("20.00")), u("2.65"));
  assert.equal(changeDue(u("17.35"), u("17.35")), 0n);
  assert.equal(changeDue(u("17.35"), u("17.34")), null);
});

test("cash suggestions start at the exact amount and step up through round figures", () => {
  assert.deepEqual(cashSuggestions(u("17.35"), 2), [u("17.35"), u("18"), u("20"), u("50")]);
  assert.deepEqual(cashSuggestions(u("20"), 2), [u("20"), u("50"), u("100")]);
});

test("a drawer count totals the register's denominations and refuses anything else", () => {
  const allowed = ["20", "10", "5", "1", "0.25", "0.10", "0.05"];
  const counted = totalDenominationCount(
    [
      { value: "20", count: 3 },
      { value: "0.25", count: 7 },
      { value: "0.05", count: 0 },
    ],
    allowed,
    2,
  );
  assert.equal(counted.totalUnits, u("61.75"));
  assert.equal(
    refusalCode(() => totalDenominationCount([{ value: "50", count: 1 }], allowed, 2)),
    "count_invalid",
  );
  assert.equal(
    refusalCode(() =>
      totalDenominationCount(
        [
          { value: "20", count: 1 },
          { value: "20.00", count: 2 },
        ],
        allowed,
        2,
      ),
    ),
    "count_invalid",
  );
  assert.equal(
    refusalCode(() => totalDenominationCount([{ value: "20", count: -1 }], allowed, 2)),
    "count_invalid",
  );
  assert.equal(
    refusalCode(() => totalDenominationCount([{ value: "20", count: 1.5 }], allowed, 2)),
    "count_invalid",
  );
  // Without configured denominations the count is a single entered total.
  assert.equal(
    totalDenominationCount([{ value: "143.20", count: 1 }], [], 2).totalUnits,
    u("143.20"),
  );
});

test("expected drawer cash is float plus cash sales minus cash refunds plus pay-ins minus pay-outs", () => {
  assert.equal(
    expectedDrawerCash({
      openingFloatUnits: u("200"),
      saleCashUnits: u("512.40"),
      refundCashUnits: u("12.40"),
      payInUnits: u("50"),
      payOutUnits: u("25.10"),
    }),
    u("724.90"),
  );
});

test("a partial return prorates the original amount and a full return is exact", () => {
  assert.equal(proratedReturnUnits(u("10.00"), "3", "3", 2), u("10.00"));
  assert.equal(proratedReturnUnits(u("10.00"), "3", "1", 2), u("3.33"));
  assert.equal(proratedReturnUnits(u("10.00"), "3", "2", 2), u("6.67"));
  assert.equal(proratedReturnUnits(u("-10.00"), "3", "1", 2), u("-3.33"));
  assert.equal(
    refusalCode(() => proratedReturnUnits(u("10.00"), "3", "4", 2)),
    "refund_exceeds_sale",
  );
});
