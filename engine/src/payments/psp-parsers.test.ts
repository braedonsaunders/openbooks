import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePaypalSettlementCsv,
  parsePaypalTransactions,
  parseShopifyPaymentsPayout,
  PspSettlementError,
  summarizeSettlement,
} from "./psp-settlement.ts";

const shopifyPayout = { id: "gid://shopify/ShopifyPaymentsPayout/1", currency: "USD", issuedAt: "2026-07-10" };

const shopifyTransactions = [
  { id: "bt_charge_1", type: "charge", amount: "100.00", fee: "2.90", currency: "USD", sourceOrderId: "1001" },
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
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes('"mystery_hold"'),
  );
});

test("Shopify Payments over-precise amount refuses naming the row", () => {
  assert.throws(
    () =>
      parseShopifyPaymentsPayout(shopifyPayout, [
        { id: "bt_x", type: "charge", amount: "10.00001", currency: "USD" },
      ]),
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes("row 1"),
  );
});

test("Shopify Payments per-transaction exchange rate rides the line meta", () => {
  const parsed = parseShopifyPaymentsPayout(
    { id: "po_fx", currency: "EUR" },
    [{ id: "bt_fx", type: "charge", amount: "100.00", currency: "EUR", exchange_rate: "1.0864000000" }],
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
    (error) =>
      error instanceof PspSettlementError &&
      error.message.includes('"T9900"'),
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
      error instanceof PspSettlementError &&
      error.message.includes("Gross Transaction Amount"),
  );
});
