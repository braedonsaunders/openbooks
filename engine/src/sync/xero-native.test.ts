import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { buildNativeFromXero } from "./xero-native.ts";

function context(): NativeContext {
  return {
    orgId: "org",
    refKey: "xeroId",
    baseCurrency: "CAD",
    control: { ar: "ar-id", ap: "ap-id", bank: "bank-id" },
    accountByRef: new Map([
      ["sales", { id: "sales-id", number: "4000", name: "Sales", type: "income" }],
      ["expense", { id: "expense-id", number: "5000", name: "Expense", type: "expense" }],
    ]),
    accountRefById: new Map(),
    partyByRef: new Map(),
    deptByRef: new Map(),
    projectByRef: new Map(),
    itemByRef: new Map(),
    subsidiaryByRef: new Map(),
    segmentValueByRef: new Map(),
    rootSubsidiaryId: "sub",
    taxByRate: new Map(),
    taxCodeByRef: new Map([
      ["OUTPUT", "tax-output-id"],
      ["INPUT", "tax-input-id"],
    ]),
    periodByRef: new Map(),
    periodFor: () => "period",
  };
}

const accountIdByCode = new Map([
  ["4000", "sales"],
  ["5000", "expense"],
]);

test("Xero invoices keep mixed tax types on their own detail-line carriers", () => {
  const built = buildNativeFromXero(
    context(),
    "Invoice",
    {
      InvoiceID: "invoice-1",
      Type: "ACCREC",
      Status: "AUTHORISED",
      DateString: "2026-08-27",
      LineItems: [
        { AccountCode: "4000", LineAmount: 100, TaxType: "OUTPUT", TaxAmount: 10 },
        { AccountCode: "5000", LineAmount: 50, TaxType: "INPUT", TaxAmount: 5 },
      ],
    },
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.deepEqual(
    built.lines.map((line) => ({ taxAmount: line.taxAmount, taxCodeId: line.taxCodeId, taxOverridden: line.taxOverridden })),
    [
      { taxAmount: "10.0000", taxCodeId: "tax-output-id", taxOverridden: true },
      { taxAmount: "5.0000", taxCodeId: "tax-input-id", taxOverridden: true },
    ],
  );
});

test("Xero invoices still aggregate repeated lines for one tax type", () => {
  const built = buildNativeFromXero(
    context(),
    "Invoice",
    {
      InvoiceID: "invoice-2",
      Type: "ACCREC",
      Status: "AUTHORISED",
      DateString: "2026-08-27",
      LineItems: [
        { AccountCode: "4000", LineAmount: 100, TaxType: "OUTPUT", TaxAmount: 10 },
        { AccountCode: "5000", LineAmount: 50, TaxType: "OUTPUT", TaxAmount: 2 },
      ],
    },
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.deepEqual(
    built.lines.map((line) => ({ taxAmount: line.taxAmount, taxCodeId: line.taxCodeId })),
    [
      { taxAmount: "12.0000", taxCodeId: "tax-output-id" },
      { taxAmount: "0", taxCodeId: null },
    ],
  );
});

test("Xero bank transactions propagate the header reconciled marker", () => {
  const codes = new Map([
    ["4000", "sales"],
    ["200", "bank"],
  ]);
  const built = buildNativeFromXero(
    {
      ...context(),
      accountByRef: new Map([
        ["sales", { id: "sales-id", number: "4000", name: "Sales", type: "income" }],
        ["bank", { id: "bank-id", number: "200", name: "Bank", type: "asset_bank" }],
      ]),
    },
    "BankTransaction",
    {
      BankTransactionID: "bt-1",
      Type: "RECEIVE",
      Status: "AUTHORISED",
      DateString: "2026-08-27",
      IsReconciled: true,
      BankAccount: { AccountID: "bank" },
      LineItems: [{ AccountCode: "4000", LineAmount: 100 }],
    },
    { accountIdByCode: codes },
  );
  assert.ok(!("skip" in built));
  // Xero states reconciliation per bank transaction, not per line: every leg
  // shares the header state (the engine stamps only reconcilable accounts),
  // dated at the bank transaction date (Xero states no clear date).
  for (const line of built.lines) {
    assert.equal(line.sourceCleared, true);
    assert.equal(line.sourceClearedDate, "2026-08-27");
  }
});

test("Xero tax keeps its sign when one tax type spans a reduction line", () => {
  // +100 with 10 tax and −20 with −2 tax must net to 8 tax, not 12:
  // abs()'ing the tax overstated AR and the tax control.
  const built = buildNativeFromXero(
    context(),
    "Invoice",
    {
      InvoiceID: "invoice-sign",
      Type: "ACCREC",
      Status: "AUTHORISED",
      DateString: "2026-08-27",
      LineItems: [
        { AccountCode: "4000", LineAmount: 100, TaxType: "OUTPUT", TaxAmount: 10 },
        { AccountCode: "4000", LineAmount: -20, TaxType: "OUTPUT", TaxAmount: -2 },
      ],
    },
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.equal(built.lines[0]!.taxAmount, "8.0000");
  assert.equal(built.lines[0]!.taxOverridden, true);
});

test("Xero credit-note tax stays negative on negative lines", () => {
  const built = buildNativeFromXero(
    context(),
    "CreditNote",
    {
      CreditNoteID: "cn-sign",
      Type: "ACCRECCREDIT",
      Status: "AUTHORISED",
      DateString: "2026-08-27",
      LineItems: [
        { AccountCode: "4000", LineAmount: -100, TaxType: "OUTPUT", TaxAmount: -10 },
      ],
    },
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.equal(built.lines[0]!.taxAmount, "-10.0000");
});

function paymentContext(): NativeContext {
  return {
    ...context(),
    accountByRef: new Map([
      ["sales", { id: "sales-id", number: "4000", name: "Sales", type: "income" }],
      ["bankacct", { id: "bank-id", number: "090", name: "Bank", type: "asset_bank" }],
    ]),
  };
}

function payDoc(over: Record<string, unknown>) {
  return {
    PaymentID: "pay-1",
    Status: "AUTHORISED",
    DateString: "2026-08-27",
    Account: { AccountID: "bankacct" },
    Amount: 50,
    ...over,
  };
}

test("Xero customer refund against a credit note posts to AR, not AP", () => {
  const built = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({ CreditNote: { CreditNoteID: "cn-1", Type: "ACCRECCREDIT" }, PaymentType: "ARCREDITPAYMENT" }),
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.equal(built.kind, "customer_payment");
});

test("Xero receipt against a receive-prepayment posts to AR", () => {
  const built = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({ Prepayment: { PrepaymentID: "pre-1", Type: "RECEIVE-PREPAYMENT" }, PaymentType: "ARPREPAYMENTPAYMENT" }),
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.equal(built.kind, "customer_payment");
});

test("Xero payment against a spend-overpayment posts to AP", () => {
  const built = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({ Overpayment: { OverpaymentID: "over-1", Type: "SPEND-OVERPAYMENT" }, PaymentType: "APOVERPAYMENTPAYMENT" }),
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.equal(built.kind, "vendor_payment");
});

test("Xero invoice payments keep their ACCREC/ACCPAY side", () => {
  const ar = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({ Invoice: { InvoiceID: "inv-1", Type: "ACCREC" }, PaymentType: "ACCRECPAYMENT" }),
    { accountIdByCode },
  );
  const ap = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({ Invoice: { InvoiceID: "inv-2", Type: "ACCPAY" }, PaymentType: "ACCPAYPAYMENT" }),
    { accountIdByCode },
  );

  assert.ok(!("skip" in ar) && !("skip" in ap));
  assert.equal(ar.kind, "customer_payment");
  assert.equal(ap.kind, "vendor_payment");
});

test("Xero payment with an untyped target falls back to the PaymentType family", () => {
  const built = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({ Invoice: { InvoiceID: "inv-9" }, PaymentType: "ACCRECPAYMENT" }),
    { accountIdByCode },
  );

  assert.ok(!("skip" in built));
  assert.equal(built.kind, "customer_payment");
});

test("Xero payment with an unknown target type refuses by name", () => {
  const built = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({ Overpayment: { OverpaymentID: "over-9", Type: "FUTURE-OVERPAYMENT" }, PaymentType: "FUTURE-PAYMENT" }),
    { accountIdByCode },
  );

  assert.ok("skip" in built);
  assert.match(built.skip, /FUTURE-OVERPAYMENT/);
  assert.match(built.skip, /FUTURE-PAYMENT/);
});

test("Xero payment settling two documents refuses naming both", () => {
  const built = buildNativeFromXero(
    paymentContext(),
    "Payment",
    payDoc({
      Invoice: { InvoiceID: "inv-1", Type: "ACCREC" },
      CreditNote: { CreditNoteID: "cn-1", Type: "ACCRECCREDIT" },
    }),
    { accountIdByCode },
  );

  assert.ok("skip" in built);
  assert.match(built.skip, /Invoice:inv-1/);
  assert.match(built.skip, /CreditNote:cn-1/);
});

test("Xero unreconciled bank transactions carry negative evidence", () => {
  const codes = new Map([["200", "bank"]]);
  const built = buildNativeFromXero(
    {
      ...context(),
      accountByRef: new Map([
        ["bank", { id: "bank-id", number: "200", name: "Bank", type: "asset_bank" }],
      ]),
    },
    "BankTransaction",
    {
      BankTransactionID: "bt-2",
      Type: "SPEND",
      Status: "AUTHORISED",
      DateString: "2026-08-28",
      IsReconciled: false,
      BankAccount: { AccountID: "bank" },
      LineItems: [{ AccountCode: "200", LineAmount: 50 }],
    },
    { accountIdByCode: codes },
  );
  assert.ok(!("skip" in built));
  for (const line of built.lines) {
    assert.equal(line.sourceCleared, false);
    assert.equal(line.sourceClearedDate, null);
  }
});
