import assert from "node:assert/strict";
import test from "node:test";
import {
  parseChargebeeSettlement,
  parseStripeBalanceTransactions,
  PspSettlementError,
} from "./psp-settlement.ts";

const stripeRow = {
  id: "txn_1",
  type: "charge",
  amount: 1_250,
  fee: -36,
  net: 1_214,
  currency: "usd",
};

test("Stripe minor-unit amounts convert exactly without changing fee magnitude", () => {
  const parsed = parseStripeBalanceTransactions(
    [stripeRow],
    "po_1",
    "2026-07-01",
  );

  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "12.5000" },
      { kind: "fee", amount: "0.3600" },
    ],
  );
});

for (const [field, row] of [
  ["Stripe amount", { ...stripeRow, amount: 1_250.5 }],
  ["Stripe fee", { ...stripeRow, fee: 36.5 }],
  ["Stripe net amount", { ...stripeRow, net: 1_213.5 }],
] as const) {
  test(`${field} rejects fractional provider minor units`, () => {
    assert.throws(
      () =>
        parseStripeBalanceTransactions(
          [row],
          "po_fractional",
          "2026-07-01",
        ),
      (error) =>
        error instanceof PspSettlementError &&
        error.message === `${field} must be a safe integer in provider minor units`,
    );
  });
}

for (const amount of [
  Number.MAX_SAFE_INTEGER + 1,
  Number.POSITIVE_INFINITY,
  Number.NaN,
]) {
  test(`Stripe amount rejects non-exact numeric input ${String(amount)}`, () => {
    assert.throws(
      () =>
        parseStripeBalanceTransactions(
          [{ ...stripeRow, amount }],
          "po_inexact",
          "2026-07-01",
        ),
      PspSettlementError,
    );
  });
}

const invalidChargebeeAmounts: [
  string,
  Parameters<typeof parseChargebeeSettlement>[0],
][] = [
  ["Chargebee total", { id: "cb_total", total: 1_250.5 }],
  [
    "Chargebee line-item amount",
    {
      id: "cb_line",
      line_items: [{ id: "line_1", amount: 1_250.5 }],
    },
  ],
  [
    "Chargebee credits applied",
    { id: "cb_credit", total: 1_250, credits_applied: 25.5 },
  ],
  [
    "Chargebee amount paid",
    { id: "cb_paid", total: 1_250, amount_paid: 1_224.5 },
  ],
  [
    "Chargebee amount adjusted",
    { id: "cb_adjusted", total: 1_250, amount_adjusted: 0.5 },
  ],
];

for (const [field, payload] of invalidChargebeeAmounts) {
  test(`${field} rejects fractional provider minor units`, () => {
    assert.throws(
      () => parseChargebeeSettlement(payload, "2026-07-01"),
      (error) =>
        error instanceof PspSettlementError &&
        error.message === `${field} must be a safe integer in provider minor units`,
    );
  });
}

test("Chargebee converts exact minor-unit totals and credits", () => {
  const parsed = parseChargebeeSettlement(
    { id: "cb_exact", total: 1_250, credits_applied: -25 },
    "2026-07-01",
  );

  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "12.5000" },
      { kind: "refund", amount: "0.2500" },
    ],
  );
});
