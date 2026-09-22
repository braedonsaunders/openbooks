import assert from "node:assert/strict";
import test from "node:test";
import {
  parseChargebeeSettlement,
  parseRecurlySettlement,
  parseStripeBalanceTransactions,
  PspSettlementError,
  summarizeSettlement,
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
  [
    "Chargebee line-item amount",
    {
      id: "cb_line",
      currency_code: "USD",
      line_items: [{ id: "line_1", amount: 1_250.5 }],
    },
  ],
  [
    "Chargebee credits applied",
    { id: "cb_credit", currency_code: "USD", total: 1_250, credits_applied: 25.5 },
  ],
  [
    "Chargebee amount paid",
    { id: "cb_paid", currency_code: "USD", total: 1_250, amount_paid: 1_224.5 },
  ],
  [
    "Chargebee amount adjusted",
    { id: "cb_adjusted", currency_code: "USD", total: 1_250, amount_adjusted: 0.5 },
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

for (const total of [
  1_250.5,
  Number.MAX_SAFE_INTEGER + 1,
  Number.POSITIVE_INFINITY,
  Number.NaN,
]) {
  test(`Chargebee total rejects non-exact numeric input ${String(total)} when line items are present`, () => {
    assert.throws(
      () =>
        parseChargebeeSettlement(
          {
            id: "cb_total_with_lines",
            currency_code: "USD",
            total,
            line_items: [{ id: "line_1", amount: 1_250 }],
          },
          "2026-07-01",
        ),
      (error) =>
        error instanceof PspSettlementError &&
        error.message ===
          "Chargebee total must be a safe integer in provider minor units",
    );
  });
}

test("Stripe zero-decimal payouts convert as whole major units, not cents", () => {
  const parsed = parseStripeBalanceTransactions(
    [{ id: "txn_jpy", type: "charge", amount: 5000, fee: 100, net: 4900, currency: "jpy" }],
    "po_jpy",
    "2026-07-01",
  );

  assert.equal(parsed.currency, "JPY");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "5000.0000" },
      { kind: "fee", amount: "100.0000" },
    ],
  );
});

test("Stripe trims row currency before scaling so padded JPY stays major units", () => {
  const parsed = parseStripeBalanceTransactions(
    [{ id: "txn_pad", type: "charge", amount: 5000, currency: " jpy " }],
    "po_pad",
    "2026-07-01",
  );

  assert.equal(parsed.currency, "JPY");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [{ kind: "charge", amount: "5000.0000" }],
  );
});

test("Stripe rejects a malformed row currency instead of converting as cents", () => {
  assert.throws(
    () =>
      parseStripeBalanceTransactions(
        [{ ...stripeRow, currency: "US" }],
        "po_bad_ccy",
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message === "Stripe transaction currency must be a three-letter currency code",
  );
});

test("Stripe rows without an explicit currency are rejected, never defaulted", () => {
  assert.throws(
    () =>
      parseStripeBalanceTransactions(
        [{ ...stripeRow, currency: undefined as unknown as string }],
        "po_no_ccy",
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message === "Stripe transaction currency is required",
  );
});

test("Stripe rows of different currencies cannot settle as one batch", () => {
  assert.throws(
    () =>
      parseStripeBalanceTransactions(
        [stripeRow, { ...stripeRow, id: "txn_2", currency: "jpy", amount: 5000, fee: 100, net: 4900 }],
        "po_mixed",
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message === "mixed-currency Stripe transactions (USD, JPY) cannot settle as one batch",
  );
});

test("Stripe payout with no transactions is rejected before any batch exists", () => {
  assert.throws(
    () => parseStripeBalanceTransactions([], "po_empty", "2026-07-01"),
    (error) =>
      error instanceof PspSettlementError &&
      error.message === "settlement batch has no evidence lines",
  );
});

// F-t06-004: a transaction without `type` reached `r.type.includes(...)` and
// threw `TypeError: Cannot read properties of undefined (reading 'includes')`,
// which the route surfaced as a 500 with no schema help. A missing type is a
// client-shape refusal (422), naming the row so the payload can be repaired.
for (const [label, row] of [
  ["missing", { id: "ch_t06_1", amount: 250000, currency: "USD", fee: 7250, net: 242750 }],
  ["empty", { id: "ch_t06_1", type: "", amount: 250000, currency: "USD", fee: 7250, net: 242750 }],
  ["non-string", { id: "ch_t06_1", type: 7, amount: 250000, currency: "USD", fee: 7250, net: 242750 }],
] as const) {
  test(`Stripe transaction with ${label} type is refused with a row-naming 422, never a TypeError (F-t06-004)`, () => {
    assert.throws(
      () =>
        parseStripeBalanceTransactions(
          [row] as unknown as Parameters<typeof parseStripeBalanceTransactions>[0],
          "T06-PAYOUT-01",
          "2026-09-13",
        ),
      (error) =>
        error instanceof PspSettlementError &&
        /Stripe transaction type is required \(row 1/.test(error.message),
    );
  });
}

test("Stripe three-decimal payouts convert as fils, not cents", () => {
  // 1000 fils = BHD 1.0000; two-decimal conversion would book 10.0000 (10x).
  const parsed = parseStripeBalanceTransactions(
    [{ ...stripeRow, currency: "bhd", amount: 1000, fee: 10, net: 990 }],
    "po_bhd",
    "2026-07-01",
  );

  assert.equal(parsed.currency, "BHD");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "1.0000" },
      { kind: "fee", amount: "0.0100" },
    ],
  );
});

test("Chargebee total rejects three-decimal minor units instead of converting at the wrong scale", () => {
  // No verified Chargebee three-decimal contract exists, so Chargebee stays
  // fail-closed while Stripe converts (see test above).
  assert.throws(
    () =>
      parseChargebeeSettlement(
        { id: "cb_bhd", currency_code: "BHD", total: 1000 },
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message ===
        "Chargebee total currency BHD uses three-decimal minor units and requires explicit conversion evidence",
  );
});

test("Chargebee zero-decimal totals convert as whole major units, not cents", () => {
  const parsed = parseChargebeeSettlement(
    { id: "cb_jpy", currency_code: "JPY", total: 5000 },
    "2026-07-01",
  );

  assert.equal(parsed.currency, "JPY");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [{ kind: "charge", amount: "5000.0000" }],
  );
});

test("Chargebee keeps Stripe zero-decimal currencies at smallest-unit scale", () => {
  // VND and CLP are zero-decimal in Stripe but NOT in Chargebee's contract
  // (JPY, KRW, XAF, XOF only), so they still convert as cents.
  for (const code of ["VND", "CLP"]) {
    const parsed = parseChargebeeSettlement(
      { id: `cb_${code.toLowerCase()}`, currency_code: code, total: 5000 },
      "2026-07-01",
    );
    assert.equal(parsed.currency, code);
    assert.deepEqual(
      parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
      [{ kind: "charge", amount: "50.0000" }],
    );
  }
});

test("Chargebee XAF totals convert as whole major units, not cents", () => {
  const parsed = parseChargebeeSettlement(
    { id: "cb_xaf", currency_code: "XAF", total: 5000 },
    "2026-07-01",
  );

  assert.equal(parsed.currency, "XAF");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [{ kind: "charge", amount: "5000.0000" }],
  );
});

test("Chargebee rejects a malformed explicit currency instead of defaulting", () => {
  assert.throws(
    () =>
      parseChargebeeSettlement(
        { id: "cb_bad_ccy", currency_code: "US", total: 1000 },
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message === "Chargebee currency_code must be a three-letter currency code",
  );
});

test("Chargebee refuses a missing currency instead of guessing USD", () => {
  assert.throws(
    () => parseChargebeeSettlement({ id: "cb_no_ccy", total: 5000 }, "2026-07-01"),
    (error) =>
      error instanceof PspSettlementError &&
      error.message === "Chargebee currency_code is required",
  );
});

test("Chargebee converts exact minor-unit totals and credits", () => {
  const parsed = parseChargebeeSettlement(
    { id: "cb_exact", currency_code: "USD", total: 1_250, credits_applied: -25 },
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

// Item 6A: the receipt books amount_paid and amount_adjusted posts as its own
// line. Real-shaped Chargebee payloads (unix date, minor-unit ints,
// entity-typed line items) per the provider invoice contract: amount_paid is
// cash collected (successful linked payments), amount_adjusted totals what was
// adjusted off, and total == paid + adjustments + applied credits.
test("Chargebee books amount_paid with amount_adjusted as its own line", () => {
  const parsed = parseChargebeeSettlement(
    {
      id: "cb_adj_1",
      date: 1720000000,
      currency_code: "USD",
      total: 10_000,
      amount_paid: 8_000,
      amount_adjusted: 2_000,
      adjustment_reason: "write_off",
      line_items: [
        { id: "li_plan", description: "Standard plan", amount: 9_000, entity_type: "plan" },
        { id: "li_tax", description: "Sales tax", amount: 1_000, entity_type: "tax" },
      ],
    },
    "2026-07-01",
  );

  assert.equal(parsed.provider, "chargebee");
  assert.equal(parsed.currency, "USD");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "90.0000" },
      { kind: "other", amount: "10.0000" },
      { kind: "adjustment", amount: "20.0000" },
    ],
  );
  const adjustment = parsed.lines.find((line) => line.kind === "adjustment")!;
  assert.equal(adjustment.description, "Chargebee adjustment (write_off)");
  assert.equal(adjustment.externalRef, "cb_adj_1_adjustment");
  assert.equal(adjustment.currency, "USD");
  assert.deepEqual(adjustment.meta, { chargebeeReason: "write_off" });
  // The receipt is what was collected: gross − adjustments == amount_paid.
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "80.0000");
});

test("Chargebee adjustment without a provider reason still posts its own line", () => {
  const parsed = parseChargebeeSettlement(
    {
      id: "cb_adj_noreason",
      currency_code: "USD",
      total: 10_000,
      amount_paid: 8_000,
      amount_adjusted: 2_000,
    },
    "2026-07-01",
  );

  const adjustment = parsed.lines.find((line) => line.kind === "adjustment")!;
  assert.equal(adjustment.amount, "20.0000");
  assert.equal(adjustment.description, "Chargebee adjustment");
  assert.deepEqual(adjustment.meta, {});
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "80.0000");
});

test("Chargebee partial cash payment covered by applied credits settles at amount_paid", () => {
  const parsed = parseChargebeeSettlement(
    {
      id: "cb_credits_1",
      date: 1720000000,
      currency_code: "USD",
      total: 10_000,
      amount_paid: 8_000,
      credits_applied: 2_000,
    },
    "2026-07-01",
  );

  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "100.0000" },
      { kind: "refund", amount: "20.0000" },
    ],
  );
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "80.0000");
});

test("Chargebee total that does not foot to paid plus adjustments fails closed naming the invoice", () => {
  assert.throws(
    () =>
      parseChargebeeSettlement(
        {
          id: "cb_mismatch_1",
          currency_code: "USD",
          total: 10_000,
          amount_paid: 8_000,
          amount_adjusted: 1_000,
        },
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("cb_mismatch_1") &&
      error.message.includes("does not reconcile"),
  );
});

test("Chargebee partial payment with an outstanding due fails closed instead of booking short", () => {
  assert.throws(
    () =>
      parseChargebeeSettlement(
        {
          id: "cb_partial_1",
          currency_code: "USD",
          total: 10_000,
          amount_paid: 6_000,
        },
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("cb_partial_1") &&
      error.message.includes("40.0000") &&
      error.message.includes("still due"),
  );
});

test("Chargebee line items that drift from the provider total fail closed even when provider totals reconcile", () => {
  // total 100.00 == paid 80.00 + adjusted 20.00, but the detail sums to 90.00
  // (invoice-level discount outside this subset shape): booking the detail
  // would receipt 70.00 against 80.00 collected, so import must refuse.
  assert.throws(
    () =>
      parseChargebeeSettlement(
        {
          id: "cb_drift_1",
          currency_code: "USD",
          total: 10_000,
          amount_paid: 8_000,
          amount_adjusted: 2_000,
          line_items: [
            { id: "li_plan", description: "Standard plan", amount: 9_000, entity_type: "plan" },
          ],
        },
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("cb_drift_1") &&
      error.message.includes("books net"),
  );
});

test("Chargebee negative amount paid is refused instead of booking a negative receipt", () => {
  assert.throws(
    () =>
      parseChargebeeSettlement(
        {
          id: "cb_negpaid",
          currency_code: "USD",
          total: 5_000,
          amount_paid: -100,
        },
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      error.message === "Chargebee amount paid must not be negative",
  );
});

// Recurly never defaults a missing currency to USD: a currency-less JPY
// settlement booked as dollars would silently mislabel every amount, the
// same failure the Stripe and Chargebee parsers already refuse by name.
for (const [label, currency] of [
  ["missing", undefined],
  ["null", null],
  ["blank", ""],
  ["whitespace-only", "   "],
  ["non-string", 840],
] as const) {
  test(`Recurly refuses a ${label} currency instead of defaulting to USD`, () => {
    assert.throws(
      () =>
        parseRecurlySettlement(
          {
            id: "r_noccy",
            closed_at: "2026-06-15T00:00:00Z",
            currency: currency as unknown as string,
            charge_amount: "99.00",
          },
          "2026-06-15",
        ),
      (error) =>
        error instanceof PspSettlementError &&
        error.message ===
          "Recurly currency is required; re-import the settlement with an explicit three-letter currency code",
    );
  });
}

for (const currency of ["US", "USDD", "12", "U$D"] as const) {
  test(`Recurly refuses malformed currency ${JSON.stringify(currency)} instead of booking it`, () => {
    assert.throws(
      () =>
        parseRecurlySettlement(
          {
            id: "r_badccy",
            closed_at: "2026-06-15T00:00:00Z",
            currency,
            charge_amount: "99.00",
          },
          "2026-06-15",
        ),
      (error) =>
        error instanceof PspSettlementError &&
        error.message ===
          "Recurly currency must be a three-letter currency code; re-import the settlement with a corrected currency code",
    );
  });
}

test("Recurly books USD, CAD, and JPY with identical amount math and an explicit batch currency", () => {
  for (const code of ["USD", "CAD", "JPY"] as const) {
    const parsed = parseRecurlySettlement(
      {
        id: `r_${code.toLowerCase()}`,
        closed_at: "2026-06-15T00:00:00Z",
        currency: code,
        charge_amount: "99.00",
        refund_amount: "10.00",
        fee_amount: "2.50",
      },
      "2026-06-15",
    );
    assert.equal(parsed.currency, code);
    assert.deepEqual(
      parsed.lines.map(({ kind, amount, currency: lineCurrency }) => ({
        kind,
        amount,
        currency: lineCurrency,
      })),
      [
        { kind: "charge", amount: "99.0000", currency: code },
        { kind: "refund", amount: "10.0000", currency: code },
        { kind: "fee", amount: "2.5000", currency: code },
      ],
    );
  }
});

test("Recurly trims and uppercases currency exactly like the sibling parsers", () => {
  const parsed = parseRecurlySettlement(
    {
      id: "r_trim",
      closed_at: "2026-06-15T00:00:00Z",
      currency: " jpy ",
      lines: [{ type: "charge", amount: "5000", id: "l1" }],
    },
    "2026-06-15",
  );
  assert.equal(parsed.currency, "JPY");
  assert.equal(parsed.lines[0]?.currency, "JPY");
  assert.equal(parsed.lines[0]?.amount, "5000.0000");
});

test("Stripe dispute rows book their fee as fee expense, not as a dropped cost", () => {
  // The headline scenario: a −$100 dispute carrying the $15 dispute fee.
  // Before the fix the fee line was split out of charges only, so the bank
  // leg posted −$100 while the $15 fee expense vanished.
  const parsed = parseStripeBalanceTransactions(
    [{ id: "dp_1", type: "dispute", amount: -10_000, fee: 1_500, net: -11_500, currency: "usd" }],
    "po_dispute",
    "2026-07-01",
  );

  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "dispute", amount: "-100.0000" },
      { kind: "fee", amount: "15.0000" },
    ],
  );
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "-115.0000");
});

test("Stripe refund and adjustment rows book their fees as fee expense", () => {
  const parsed = parseStripeBalanceTransactions(
    [
      { id: "rf_1", type: "refund", amount: -5_000, fee: 100, net: -5_100, currency: "usd" },
      { id: "ad_1", type: "adjustment", amount: -2_000, fee: 50, net: -2_050, currency: "usd" },
    ],
    "po_fee_rows",
    "2026-07-01",
  );

  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "refund", amount: "-50.0000" },
      { kind: "fee", amount: "1.0000" },
      { kind: "adjustment", amount: "-20.0000" },
      { kind: "fee", amount: "0.5000" },
    ],
  );
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "-71.5000");
});

test("Stripe payout movement rows are excluded so the computed net is the payout", () => {
  const parsed = parseStripeBalanceTransactions(
    [
      { id: "ch_1", type: "charge", amount: 1_250, fee: 36, net: 1_214, currency: "usd" },
      { id: "po_1", type: "payout", amount: -1_214, fee: 0, net: -1_214, currency: "usd" },
    ],
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
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "12.1400");
});

test("Stripe payout-only export is refused instead of posting an empty batch", () => {
  assert.throws(
    () =>
      parseStripeBalanceTransactions(
        [{ id: "po_1", type: "payout", amount: -1_214, fee: 0, net: -1_214, currency: "usd" }],
        "po_only",
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      /has no evidence lines/.test(error.message),
  );
});

test("Stripe unknown balance-transaction types are refused, never booked as charges", () => {
  assert.throws(
    () =>
      parseStripeBalanceTransactions(
        [{ id: "xx_1", type: "issuing_transaction", amount: 500, fee: 0, net: 500, currency: "usd" }],
        "po_unknown",
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      /unsupported Stripe balance transaction type "issuing_transaction" \(row 1 xx_1\)/.test(error.message),
  );
});

test("Stripe row whose net does not foot to amount minus fee is refused", () => {
  assert.throws(
    () =>
      parseStripeBalanceTransactions(
        [{ id: "ch_bad", type: "charge", amount: 1_250, fee: 36, net: 1_200, currency: "usd" }],
        "po_badnet",
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      /does not foot \(row 1 ch_bad\): net 1200 != amount 1250 minus fee 36/.test(error.message),
  );
});

test("Stripe positive-amount refund is refused by total reconciliation, not misbooked", () => {
  // A +$5 "refund" would land in the magnitude-based refund bucket and book
  // −$5 while the export says +$5. The per-row check passes (it foots), so
  // only the export-total comparison can catch the mis-assignment.
  assert.throws(
    () =>
      parseStripeBalanceTransactions(
        [{ id: "rf_pos", type: "refund", amount: 500, fee: 0, net: 500, currency: "usd" }],
        "po_posrefund",
        "2026-07-01",
      ),
    (error) =>
      error instanceof PspSettlementError &&
      /does not reconcile: export nets total 5\.0000 but settlement lines net to -5\.0000/.test(error.message),
  );
});

test("Stripe positive adjustment rides the signed bucket and still reconciles", () => {
  const parsed = parseStripeBalanceTransactions(
    [{ id: "ad_pos", type: "adjustment", amount: 5_000, fee: 0, net: 5_000, currency: "usd" }],
    "po_posadj",
    "2026-07-01",
  );

  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [{ kind: "other", amount: "50.0000" }],
  );
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "50.0000");
});

test("Chargebee zero adjustment emits no adjustment line", () => {
  const parsed = parseChargebeeSettlement(
    {
      id: "cb_zeroadj",
      currency_code: "USD",
      total: 5_000,
      amount_paid: 5_000,
      amount_adjusted: 0,
    },
    "2026-07-01",
  );

  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [{ kind: "charge", amount: "50.0000" }],
  );
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "50.0000");
});
