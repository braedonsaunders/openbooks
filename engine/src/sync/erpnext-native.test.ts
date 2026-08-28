import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../money.ts";
import type { NativeContext } from "./native.ts";
import { buildErpInvoice, type ErpInvoice } from "./erpnext-native.ts";

function context(): NativeContext {
  return {
    orgId: "org",
    refKey: "erpId",
    baseCurrency: "CAD",
    control: { ar: "ar-id", ap: "ap-id", bank: "bank-id" },
    accountByRef: new Map([
      ["Sales", { id: "sales-id", number: "4000", name: "Sales", type: "income" }],
      ["AR", { id: "ar-id", number: "1100", name: "Accounts Receivable", type: "asset_receivable" }],
    ]),
    accountRefById: new Map(),
    partyByRef: new Map([["C:Customer", "customer-id"]]),
    deptByRef: new Map(),
    projectByRef: new Map(),
    itemByRef: new Map(),
    subsidiaryByRef: new Map(),
    segmentValueByRef: new Map(),
    rootSubsidiaryId: "sub-root",
    taxByRate: new Map(),
    taxCodeByRef: new Map([
      ["GST Account", "gst-code-id"],
      ["PST Account", "pst-code-id"],
    ]),
    periodByRef: new Map(),
    periodFor: () => undefined,
  };
}

test("ERPNext invoices retain each tax account as its own tax-code carrier", () => {
  const invoice: ErpInvoice = {
    name: "SINV-100",
    customer: "Customer",
    posting_date: "2026-08-28",
    is_return: 0,
    docstatus: 1,
    debit_to: "AR",
    items: [{ income_account: "Sales", base_net_amount: 100 }],
    taxes: [
      { account_head: "GST Account", base_tax_amount: 5 },
      { account_head: "PST Account", base_tax_amount: 8 },
      // Repeated account heads aggregate without losing the account identity.
      { account_head: "GST Account", base_tax_amount: 2 },
    ],
  };

  const built = buildErpInvoice(context(), invoice);
  assert.ok(!("skip" in built));
  assert.deepEqual(
    built.lines.map((line) => ({
      lineNumber: line.lineNumber,
      amount: line.amount,
      taxAmount: line.taxAmount,
      taxCodeId: line.taxCodeId,
    })),
    [
      { lineNumber: 1, amount: "100.0000", taxAmount: "7.0000", taxCodeId: "gst-code-id" },
      { lineNumber: 2, amount: "0.0000", taxAmount: "8.0000", taxCodeId: "pst-code-id" },
    ],
  );
  assert.equal(
    built.lines.reduce((sum, line) => sum + toUnits(line.taxAmount), 0n),
    toUnits("15"),
  );
});

test("ERPNext invoices fail closed when a non-zero tax account is unmapped", () => {
  const invoice: ErpInvoice = {
    name: "SINV-101",
    customer: "Customer",
    posting_date: "2026-08-28",
    is_return: 0,
    docstatus: 1,
    items: [{ income_account: "Sales", base_net_amount: 100 }],
    taxes: [{ account_head: "Unknown Tax Account", base_tax_amount: 5 }],
  };

  assert.deepEqual(buildErpInvoice(context(), invoice), {
    skip: "unmapped tax code Unknown Tax Account",
  });
});
