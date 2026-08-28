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
