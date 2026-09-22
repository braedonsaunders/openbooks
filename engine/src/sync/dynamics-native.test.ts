import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeFromBC } from "./dynamics-native.ts";
import type { NativeContext } from "./native.ts";

function context(): NativeContext {
  return {
    orgId: "org",
    refKey: "bcId",
    baseCurrency: "CAD",
    control: { ar: "ar-id", ap: "ap-id", bank: "bank-id" },
    accountByRef: new Map([
      ["sales-a", { id: "sales-a-id", number: "4000", name: "Sales A", type: "income" }],
      ["sales-b", { id: "sales-b-id", number: "4010", name: "Sales B", type: "income" }],
    ]),
    accountRefById: new Map(),
    partyByRef: new Map([["customer-1", "customer-id"]]),
    deptByRef: new Map(),
    projectByRef: new Map(),
    itemByRef: new Map(),
    subsidiaryByRef: new Map(),
    segmentValueByRef: new Map(),
    rootSubsidiaryId: "root",
    taxByRate: new Map(),
    taxCodeByRef: new Map([
      ["tax-a", "tax-a-id"],
      ["tax-b", "tax-b-id"],
    ]),
    periodByRef: new Map(),
    periodFor: () => undefined,
  };
}

test("Dynamics invoices keep tax amounts and codes on their matching detail lines", () => {
  const built = buildNativeFromBC(
    context(),
    "salesInvoice",
    {
      id: "invoice-1",
      number: "INV-1",
      invoiceDate: "2026-08-27",
      customerId: "customer-1",
      lines: [
        { lineType: "Account", accountId: "sales-a", amountExcludingTax: 100, totalTaxAmount: 13, taxCode: "tax-a" },
        { lineType: "Account", accountId: "sales-b", amountExcludingTax: 50, totalTaxAmount: 5, taxCode: "tax-b" },
      ],
    },
    { itemSalesAccount: new Map(), itemPurchaseAccount: new Map() },
  );

  assert.ok(!("skip" in built));
  // F-t12-004: the invoice list showed "salesInvoice:<uuid>" because the
  // adapter never set documentNumber, so the writer fell back to sourceRef.
  assert.equal(built.documentNumber, "INV-1");
  assert.deepEqual(
    built.lines.map((line) => ({
      accountId: line.accountId,
      amount: line.amount,
      taxAmount: line.taxAmount,
      taxCodeId: line.taxCodeId,
      taxOverridden: line.taxOverridden,
    })),
    [
      { accountId: "sales-a-id", amount: "100.0000", taxAmount: "13.0000", taxCodeId: "tax-a-id", taxOverridden: true },
      { accountId: "sales-b-id", amount: "50.0000", taxAmount: "5.0000", taxCodeId: "tax-b-id", taxOverridden: true },
    ],
  );
});

test("Dynamics foreign invoice carries its currency and dated rate, amounts unconverted", () => {
  const built = buildNativeFromBC(
    context(),
    "salesInvoice",
    {
      id: "invoice-fx",
      number: "INV-FX",
      invoiceDate: "2026-08-27",
      customerId: "customer-1",
      currencyCode: "eur",
      lines: [
        { lineType: "Account", accountId: "sales-a", amountExcludingTax: 1000, totalTaxAmount: 200, taxCode: "tax-a" },
      ],
    },
    {
      itemSalesAccount: new Map(),
      itemPurchaseAccount: new Map(),
      fxRateFor: (code, date) => (code === "EUR" && date === "2026-08-27" ? "1.5" : null),
    },
  );

  assert.ok(!("skip" in built));
  // €1,000 at 1.5 must post as €1,000 @ 1.5 — never as $1,000 at face value.
  assert.equal(built.currency, "EUR");
  assert.equal(built.fxRate, "1.5");
  assert.equal(built.lines[0]!.amount, "1000.0000");
  assert.equal(built.lines[0]!.taxAmount, "200.0000");
});

test("Dynamics foreign invoice without a dated rate refuses with the remedy", () => {
  const built = buildNativeFromBC(
    context(),
    "salesInvoice",
    {
      id: "invoice-norate",
      number: "INV-NORATE",
      invoiceDate: "2026-08-27",
      customerId: "customer-1",
      currencyCode: "EUR",
      lines: [
        { lineType: "Account", accountId: "sales-a", amountExcludingTax: 1000, totalTaxAmount: 200, taxCode: "tax-a" },
      ],
    },
    { itemSalesAccount: new Map(), itemPurchaseAccount: new Map() },
  );

  assert.ok("skip" in built);
  assert.match(built.skip, /EUR/);
  assert.match(built.skip, /currencyExchangeRates/);
});

test("Dynamics tax keeps its sign when one tax code spans a reduction line", () => {
  // +100 with 10 tax and −20 with −2 tax must net to 8 tax, not 12:
  // abs()'ing the tax overstated AR and the tax control.
  const built = buildNativeFromBC(
    context(),
    "salesInvoice",
    {
      id: "invoice-sign",
      number: "INV-SIGN",
      invoiceDate: "2026-08-27",
      customerId: "customer-1",
      lines: [
        { lineType: "Account", accountId: "sales-a", amountExcludingTax: 100, totalTaxAmount: 10, taxCode: "tax-a" },
        { lineType: "Account", accountId: "sales-b", amountExcludingTax: -20, totalTaxAmount: -2, taxCode: "tax-a" },
      ],
    },
    { itemSalesAccount: new Map(), itemPurchaseAccount: new Map() },
  );

  assert.ok(!("skip" in built));
  assert.equal(built.lines[0]!.taxAmount, "8.0000");
  assert.equal(built.lines[0]!.taxOverridden, true);
});
