import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePaypalSettlementCsv,
  parsePaypalTransactions,
  parseShopifyPaymentsPayout,
  parseSquarePayout,
  PspSettlementError,
  summarizeSettlement,
} from "./psp-settlement.ts";

const shopifyPayout = {
  id: "gid://shopify/ShopifyPaymentsPayout/1",
  currency: "USD",
  issuedAt: "2026-07-10",
};

const shopifyTransactions = [
  {
    id: "bt_charge_1",
    type: "charge",
    amount: "100.00",
    fee: "2.90",
    currency: "USD",
    sourceOrderId: "1001",
  },
  { id: "bt_refund_1", type: "refund", amount: "25.00", currency: "USD", sourceOrderId: "1002" },
  { id: "bt_dispute_1", type: "dispute", amount: "40.00", currency: "USD", sourceOrderId: "1003" },
  { id: "bt_reserve_1", type: "reserve", amount: "5.00", currency: "USD" },
  { id: "bt_payout_1", type: "payout", amount: "-27.10", currency: "USD" },
];

test("Shopify Payments payout maps balance types and reconciles to the payout movement", () => {
  const parsed = parseShopifyPaymentsPayout(shopifyPayout, shopifyTransactions, "2026-07-10");
  assert.equal(parsed.provider, "shopify_payments");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "100.0000" },
      { kind: "fee", amount: "2.9000" },
      { kind: "refund", amount: "25.0000" },
      { kind: "dispute", amount: "40.0000" },
      { kind: "adjustment", amount: "5.0000" },
    ],
  );
  // Net = 100 − 2.90 − 25 − 40 − 5 = 27.10, the payout movement.
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "27.1000");
});

test("Shopify Payments payout movement mismatch refuses naming the payout", () => {
  assert.throws(
    () =>
      parseShopifyPaymentsPayout(shopifyPayout, [
        { id: "bt_charge_1", type: "charge", amount: "100.00", currency: "USD" },
        { id: "bt_payout_1", type: "payout", amount: "99.00", currency: "USD" },
      ]),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("gid://shopify/ShopifyPaymentsPayout/1 does not reconcile"),
  );
});

test("Shopify Payments unknown balance type refuses by name", () => {
  assert.throws(
    () =>
      parseShopifyPaymentsPayout(shopifyPayout, [
        { id: "bt_x", type: "mystery_hold", amount: "10.00", currency: "USD" },
      ]),
    (error) => error instanceof PspSettlementError && error.message.includes('"mystery_hold"'),
  );
});

test("Shopify Payments over-precise amount refuses naming the row", () => {
  assert.throws(
    () =>
      parseShopifyPaymentsPayout(shopifyPayout, [
        { id: "bt_x", type: "charge", amount: "10.00001", currency: "USD" },
      ]),
    (error) => error instanceof PspSettlementError && error.message.includes("row 1"),
  );
});

test("Shopify Payments per-transaction exchange rate rides the line meta", () => {
  const parsed = parseShopifyPaymentsPayout(
    { id: "po_fx", currency: "EUR" },
    [
      {
        id: "bt_fx",
        type: "charge",
        amount: "100.00",
        currency: "EUR",
        exchange_rate: "1.0864000000",
      },
    ],
    "2026-07-10",
  );
  assert.equal(parsed.lines[0]!.meta?.exchangeRate, "1.0864000000");
});

const paypalTransactions = {
  reference: "STL-2026-07",
  transactions: [
    {
      transaction_info: {
        transaction_id: "8RU123",
        transaction_event_code: "T0000",
        transaction_initiated_date: "2026-07-05T10:00:00Z",
        transaction_amount: { currency_code: "USD", value: "100.00" },
        fee_amount: { currency_code: "USD", value: "2.90" },
      },
    },
    {
      transaction_info: {
        transaction_id: "8RU124",
        transaction_event_code: "T1106",
        transaction_amount: { currency_code: "USD", value: "25.00" },
      },
    },
    {
      transaction_info: {
        transaction_id: "8RU125",
        transaction_event_code: "T2101",
        transaction_amount: { currency_code: "USD", value: "40.00" },
      },
    },
    {
      transaction_info: {
        transaction_id: "8RU126",
        transaction_event_code: "T0200",
        transaction_amount: { currency_code: "USD", value: "30.00" },
      },
    },
  ],
};

test("PayPal T-code families map to settlement kinds with fee legs", () => {
  const parsed = parsePaypalTransactions(paypalTransactions, "2026-07-06");
  assert.equal(parsed.provider, "paypal");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "100.0000" },
      { kind: "fee", amount: "2.9000" },
      { kind: "refund", amount: "25.0000" },
      { kind: "dispute", amount: "40.0000" },
      { kind: "transfer", amount: "30.0000" },
    ],
  );
  assert.equal(parsed.settlementDate, "2026-07-06");
});

test("PayPal unknown event code refuses naming the code", () => {
  assert.throws(
    () =>
      parsePaypalTransactions({
        reference: "STL-X",
        transactions: [
          {
            transaction_info: {
              transaction_id: "8RU999",
              transaction_event_code: "T9900",
              transaction_amount: { currency_code: "USD", value: "1.00" },
            },
          },
        ],
      }),
    (error) => error instanceof PspSettlementError && error.message.includes('"T9900"'),
  );
});

const paypalCsv = [
  "Transaction ID,Transaction Event Code,Gross Transaction Amount,Gross Transaction Currency,Fee Amount,Transaction Debit or Credit,Transaction Completed Date",
  "8RU123,T0000,100.00,USD,2.90,Credit,07/05/2026",
  '"8RU,124",T1106,25.00,USD,,Debit,07/06/2026',
  "8RU125,T2101,40.00,USD,,Debit,07/07/2026",
].join("\r\n");

test("PayPal settlement CSV parses quoted ids and carries debit/credit evidence", () => {
  const parsed = parsePaypalSettlementCsv(paypalCsv, "STL-CSV-1", "2026-07-07");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount, externalRef }) => ({ kind, amount, externalRef })),
    [
      { kind: "charge", amount: "100.0000", externalRef: "8RU123" },
      { kind: "fee", amount: "2.9000", externalRef: "8RU123_fee" },
      { kind: "refund", amount: "25.0000", externalRef: "8RU,124" },
      { kind: "dispute", amount: "40.0000", externalRef: "8RU125" },
    ],
  );
  assert.equal(parsed.lines[0]!.meta?.paypalDebitOrCredit, "Credit");
});

test("PayPal settlement CSV without the amount column refuses naming it", () => {
  assert.throws(
    () => parsePaypalSettlementCsv("Transaction ID,Transaction Event Code\r\n1,T0000\r\n", "STL-X"),
    (error) =>
      error instanceof PspSettlementError && error.message.includes("Gross Transaction Amount"),
  );
});

const squareMoney = (amount: number | string, currency = "USD") => ({ amount, currency });

const squarePayout = {
  id: "po_2Y8kq3",
  status: "PAID",
  location_id: "LQ9W3K1",
  created_at: "2026-08-23T04:00:00Z",
  arrival_date: "2026-08-24",
  amount_money: squareMoney(10401),
};

const squareEntries = [
  {
    id: "pe_charge_1",
    payout_id: "po_2Y8kq3",
    type: "CHARGE",
    gross_amount_money: squareMoney(10000),
    fee_amount_money: squareMoney(-290),
    net_amount_money: squareMoney(9710),
    type_charge_details: { payment_id: "pay_Hk3s9Q" },
  },
  {
    id: "pe_charge_2",
    payout_id: "po_2Y8kq3",
    type: "CHARGE",
    gross_amount_money: squareMoney(2500),
    fee_amount_money: squareMoney(-103),
    net_amount_money: squareMoney(2397),
    type_charge_details: { payment_id: "pay_Lm7t2R" },
  },
  {
    id: "pe_refund_1",
    payout_id: "po_2Y8kq3",
    type: "REFUND",
    gross_amount_money: squareMoney(-1500),
    fee_amount_money: squareMoney(44),
    net_amount_money: squareMoney(-1456),
    type_refund_details: { payment_id: "pay_Hk3s9Q" },
  },
  {
    id: "pe_adjustment_debit",
    payout_id: "po_2Y8kq3",
    type: "ADJUSTMENT",
    gross_amount_money: squareMoney(-500),
    fee_amount_money: null,
    net_amount_money: squareMoney(-500),
  },
  {
    id: "pe_adjustment_credit",
    payout_id: "po_2Y8kq3",
    type: "RELEASE_ADJUSTMENT",
    gross_amount_money: squareMoney(250),
    fee_amount_money: null,
    net_amount_money: squareMoney(250),
  },
  {
    id: "pe_dispute_open",
    payout_id: "po_2Y8kq3",
    type: "OPEN_DISPUTE",
    gross_amount_money: squareMoney(-4000),
    net_amount_money: squareMoney(-4000),
    type_dispute_details: { dispute_id: "dp_9A1" },
  },
  {
    id: "pe_dispute_close",
    payout_id: "po_2Y8kq3",
    type: "CLOSE_DISPUTE",
    gross_amount_money: squareMoney(4000),
    net_amount_money: squareMoney(4000),
    type_dispute_details: { dispute_id: "dp_9A1" },
  },
];

test("Square payout maps charges, fees, refunds, adjustments and disputes to the settlement kinds", () => {
  const parsed = parseSquarePayout(squarePayout, squareEntries, "2026-08-24");
  assert.equal(parsed.provider, "square");
  assert.equal(parsed.externalRef, "po_2Y8kq3");
  assert.equal(parsed.settlementDate, "2026-08-24");
  assert.equal(parsed.currency, "USD");
  assert.deepEqual(
    parsed.lines.map(({ kind, amount, externalRef }) => ({ kind, amount, externalRef })),
    [
      { kind: "charge", amount: "100.0000", externalRef: "pe_charge_1" },
      { kind: "fee", amount: "2.9000", externalRef: "pe_charge_1_fee" },
      { kind: "charge", amount: "25.0000", externalRef: "pe_charge_2" },
      { kind: "fee", amount: "1.0300", externalRef: "pe_charge_2_fee" },
      { kind: "refund", amount: "15.0000", externalRef: "pe_refund_1" },
      { kind: "fee", amount: "-0.4400", externalRef: "pe_refund_1_fee" },
      { kind: "adjustment", amount: "5.0000", externalRef: "pe_adjustment_debit" },
      { kind: "other", amount: "2.5000", externalRef: "pe_adjustment_credit" },
      { kind: "dispute", amount: "40.0000", externalRef: "pe_dispute_open" },
      { kind: "dispute_reversal", amount: "40.0000", externalRef: "pe_dispute_close" },
    ],
  );
  // Gross 127.50 − fees 3.49 − refunds 15 − adjustments 5 = 104.01, the payout amount.
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "104.0100");
});

test("Square line meta carries the payment and dispute identifiers", () => {
  const parsed = parseSquarePayout(squarePayout, squareEntries, "2026-08-24");
  const refund = parsed.lines.find((line) => line.externalRef === "pe_refund_1");
  const dispute = parsed.lines.find((line) => line.externalRef === "pe_dispute_open");
  assert.equal(refund?.meta?.squarePaymentId, "pay_Hk3s9Q");
  assert.equal(refund?.meta?.squareType, "REFUND");
  assert.equal(dispute?.meta?.squareDisputeId, "dp_9A1");
});

test("Square amounts convert through the currency's minor units exactly", () => {
  const parsed = parseSquarePayout(
    { id: "po_jp_1", amount_money: squareMoney(4820, "JPY"), arrival_date: "2026-08-24" },
    [
      {
        id: "pe_jp_1",
        type: "CHARGE",
        gross_amount_money: squareMoney(5000, "JPY"),
        fee_amount_money: squareMoney(-180, "JPY"),
        net_amount_money: squareMoney(4820, "JPY"),
      },
    ],
  );
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "5000.0000" },
      { kind: "fee", amount: "180.0000" },
    ],
  );
});

test("Square FEE and PAID_SERVICE_FEE entries book their whole net as fee", () => {
  const parsed = parseSquarePayout(
    { id: "po_fee_1", amount_money: squareMoney(9500), arrival_date: "2026-08-24" },
    [
      {
        id: "pe_charge_3",
        type: "CHARGE",
        gross_amount_money: squareMoney("10000"),
        net_amount_money: squareMoney("10000"),
      },
      {
        id: "pe_fee_1",
        type: "FEE",
        gross_amount_money: squareMoney(-300),
        net_amount_money: squareMoney(-300),
      },
      {
        id: "pe_service_fee_1",
        type: "PAID_SERVICE_FEE",
        gross_amount_money: squareMoney(-200),
        net_amount_money: squareMoney(-200),
      },
    ],
  );
  assert.deepEqual(
    parsed.lines.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: "charge", amount: "100.0000" },
      { kind: "fee", amount: "3.0000" },
      { kind: "fee", amount: "2.0000" },
    ],
  );
  assert.equal(summarizeSettlement(parsed.lines).netAmount, "95.0000");
});

test("Square payout total that the entries do not net to refuses naming the payout", () => {
  assert.throws(
    () => parseSquarePayout({ ...squarePayout, amount_money: squareMoney(10400) }, squareEntries),
    (error) =>
      error instanceof PspSettlementError && error.message.includes("po_2Y8kq3 does not reconcile"),
  );
});

test("Square entry that does not foot refuses naming the entry", () => {
  assert.throws(
    () =>
      parseSquarePayout(squarePayout, [
        { ...squareEntries[0]!, net_amount_money: squareMoney(9700) },
      ]),
    (error) =>
      error instanceof PspSettlementError && error.message.includes("pe_charge_1 does not foot"),
  );
});

test("Square positive fee convention refuses rather than inverting the fee", () => {
  assert.throws(
    () =>
      parseSquarePayout(squarePayout, [
        {
          id: "pe_charge_positive_fee",
          type: "CHARGE",
          gross_amount_money: squareMoney(10000),
          fee_amount_money: squareMoney(290),
          net_amount_money: squareMoney(9710),
        },
      ]),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("pe_charge_positive_fee does not foot"),
  );
});

test("Square unknown entry type refuses by name", () => {
  assert.throws(
    () =>
      parseSquarePayout(squarePayout, [
        {
          id: "pe_hold_1",
          type: "RESERVE_HOLD",
          gross_amount_money: squareMoney(-900),
          net_amount_money: squareMoney(-900),
        },
      ]),
    (error) => error instanceof PspSettlementError && error.message.includes('"RESERVE_HOLD"'),
  );
});

test("Square dispute with the wrong direction refuses naming the entry type", () => {
  assert.throws(
    () =>
      parseSquarePayout(squarePayout, [
        {
          id: "pe_open_credit",
          type: "OPEN_DISPUTE",
          gross_amount_money: squareMoney(4000),
          net_amount_money: squareMoney(4000),
        },
      ]),
    (error) =>
      error instanceof PspSettlementError && error.message.includes("Square OPEN_DISPUTE entry"),
  );
});

test("Square failed and canceled payouts refuse because no funds settled", () => {
  for (const status of ["FAILED", "CANCELED"]) {
    assert.throws(
      () => parseSquarePayout({ ...squarePayout, status }, squareEntries),
      (error) => error instanceof PspSettlementError && error.message.includes("did not settle"),
    );
  }
});

test("Square entries in another currency refuse as a mixed-currency batch", () => {
  assert.throws(
    () =>
      parseSquarePayout(squarePayout, [
        {
          id: "pe_cad_1",
          type: "CHARGE",
          gross_amount_money: squareMoney(10000, "CAD"),
          net_amount_money: squareMoney(10000, "CAD"),
        },
      ]),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("mixed-currency Square transactions (USD, CAD)"),
  );
});

test("Square entry that belongs to another payout refuses", () => {
  assert.throws(
    () => parseSquarePayout(squarePayout, [{ ...squareEntries[0]!, payout_id: "po_other" }]),
    (error) =>
      error instanceof PspSettlementError && error.message.includes("belongs to payout po_other"),
  );
});

test("Square money refuses decimal and non-safe-integer amounts", () => {
  assert.throws(
    () =>
      parseSquarePayout(squarePayout, [
        { ...squareEntries[0]!, gross_amount_money: squareMoney(100.5) },
      ]),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("must be an integer amount in Square minor units"),
  );
  assert.throws(
    () =>
      parseSquarePayout(squarePayout, [
        { ...squareEntries[0]!, gross_amount_money: squareMoney(Number.MAX_SAFE_INTEGER + 2) },
      ]),
    (error) => error instanceof PspSettlementError,
  );
});

test("Square entry without an id refuses rather than booking an unidentified line", () => {
  assert.throws(
    () => parseSquarePayout(squarePayout, [{ ...squareEntries[0]!, id: null }]),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("Square payout entry id is required"),
  );
});
