import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { ErpNextSource, erpNextReconcilableAccountType } from "./erpnext-source.ts";
import type { ErpNextClient } from "../connectors/erpnext.ts";

/**
 * Settlement-link currency fixtures (fleet 4, from the vendor's published
 * contract): Payment Entry `references[].allocated_amount` is denominated in
 * the invoice's account currency (ERPNext docs: "Allocate the invoice in its
 * account currency"), so every invoice-backed link states that currency. The
 * per-reference `exchange_rate` converts the ALLOCATION's currency to company
 * currency (frappe/erpnext `payment_entry.py` `get_reference_details()`: an
 * invoice reference's rate is the invoice's own `conversion_rate`, fallback
 * `get_exchange_rate(party_account_currency, company_currency, ...)`; and
 * `calculate_base_allocated_amount_for_reference()` books
 * `exchange_gain_loss = allocated × header_rate − allocated × d.exchange_rate`).
 * The rate is stated only when the invoice's transaction and party-account
 * currencies are both known and EQUAL (the documented normal case — otherwise
 * the rate's FROM may not match the allocation's currency); anything else
 * stays unstated and foreign links resolve through the books' own line rates
 * or refuse loudly. Journal Entry advances stay unstated (no single currency).
 */
const payment = {
  name: "PE-1",
  payment_type: "Receive",
  party_type: "Customer",
  party: "C1",
  posting_date: "2026-01-15",
  docstatus: 1,
  paid_from: "Debtors - X",
  paid_to: "Bank - X",
  base_paid_amount: 500,
  base_received_amount: 500,
  references: [
    { reference_doctype: "Sales Invoice", reference_name: "SI-1", allocated_amount: 500 },
    { reference_doctype: "Journal Entry", reference_name: "JE-1", allocated_amount: 50 },
  ],
};

function source(): ErpNextSource {
  const client = {
    listAll: async (doctype: string, fields: string[]) => {
      if (doctype === "Payment Entry") {
        // Windowed document heads carry `modified`; the submitted-payments
        // sweep asks for bare `name`s. Both see the one recorded payment.
        return fields.includes("modified")
          ? [{ name: "PE-1", modified: "2026-01-15 10:00:00" }]
          : [{ name: "PE-1" }];
      }
      if (doctype === "Sales Invoice" && fields.includes("currency")) {
        return [{ name: "SI-1", currency: "USD", party_account_currency: "USD" }];
      }
      return [];
    },
    getDoc: async () => payment,
  } as unknown as ErpNextClient;
  const source = new ErpNextSource(
    { url: "https://example.invalid", apiKey: "test", apiSecret: "test" },
    { baseCurrency: "USD" },
  );
  Object.defineProperty(source, "client", { value: client });
  return source;
}

const ctx = {
  accountByRef: new Map([
    ["Debtors - X", { id: "ob-debtors", number: "1100", name: "Debtors", type: "asset_receivable" }],
    ["Bank - X", { id: "ob-bank", number: "1000", name: "Bank", type: "asset_bank" }],
  ]),
  partyByRef: new Map(),
} as unknown as NativeContext;

test("payment-entry links state the invoice account currency with no producer rate", async () => {
  const changes = await source().nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    { paymentRef: "PE-1", appliedRef: "SI-1", amount: "500.00", currency: "USD", rate: null },
    { paymentRef: "PE-1", appliedRef: "JE-1", amount: "50.00", currency: "", rate: null },
  ]);
});

/** Foreign-currency routes: the invoice's transaction and party-account
 * currencies are both EUR, so the reference rate's FROM matches the
 * allocation's currency and the rate is stated. */
function foreignSource(references: unknown[]): ErpNextSource {
  const payment = {
    name: "PE-EUR",
    payment_type: "Receive",
    party_type: "Customer",
    party: "C1",
    posting_date: "2026-01-15",
    docstatus: 1,
    paid_from: "Debtors - X",
    paid_to: "Bank - X",
    base_paid_amount: 1150,
    base_received_amount: 1150,
    references,
  };
  const client = {
    listAll: async (doctype: string, fields: string[]) => {
      if (doctype === "Payment Entry") {
        return fields.includes("modified")
          ? [{ name: "PE-EUR", modified: "2026-01-15 10:00:00" }]
          : [{ name: "PE-EUR" }];
      }
      if (doctype === "Sales Invoice" && fields.includes("currency")) {
        return [{ name: "SI-EUR", currency: "EUR", party_account_currency: "EUR" }];
      }
      if (doctype === "Sales Invoice" && fields.includes("modified")) {
        return [];
      }
      return [];
    },
    getDoc: async () => payment,
  } as unknown as ErpNextClient;
  const source = new ErpNextSource(
    { url: "https://example.invalid", apiKey: "test", apiSecret: "test" },
    { baseCurrency: "USD" },
  );
  Object.defineProperty(source, "client", { value: client });
  return source;
}

test("a foreign reference states the invoice exchange rate", async () => {
  const src = foreignSource([
    { reference_doctype: "Sales Invoice", reference_name: "SI-EUR", allocated_amount: 1000, exchange_rate: 1.15 },
  ]);
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    { paymentRef: "PE-EUR", appliedRef: "SI-EUR", amount: "1000.00", currency: "EUR", rate: "1.15" },
  ]);
});

test("a zero reference rate states no rate", async () => {
  const src = foreignSource([
    { reference_doctype: "Sales Invoice", reference_name: "SI-EUR", allocated_amount: 1000, exchange_rate: 0 },
  ]);
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    { paymentRef: "PE-EUR", appliedRef: "SI-EUR", amount: "1000.00", currency: "EUR", rate: null },
  ]);
});

test("a misaligned reference currency states no rate", async () => {
  const payment = {
    name: "PE-X",
    payment_type: "Receive",
    party_type: "Customer",
    party: "C1",
    posting_date: "2026-01-15",
    docstatus: 1,
    paid_from: "Debtors - X",
    paid_to: "Bank - X",
    base_paid_amount: 1000,
    base_received_amount: 1000,
    references: [
      { reference_doctype: "Sales Invoice", reference_name: "SI-X", allocated_amount: 1000, exchange_rate: 1.15 },
    ],
  };
  const client = {
    listAll: async (doctype: string, fields: string[]) => {
      if (doctype === "Payment Entry") {
        return fields.includes("modified")
          ? [{ name: "PE-X", modified: "2026-01-15 10:00:00" }]
          : [{ name: "PE-X" }];
      }
      if (doctype === "Sales Invoice" && fields.includes("currency")) {
        // Exotic multi-currency-against-one-account shape: the allocation is
        // priced in the USD account while the invoice rate converts from EUR,
        // so the rate's FROM does not match and nothing is stated.
        return [{ name: "SI-X", currency: "EUR", party_account_currency: "USD" }];
      }
      if (doctype === "Sales Invoice" && fields.includes("modified")) {
        return [];
      }
      return [];
    },
    getDoc: async () => payment,
  } as unknown as ErpNextClient;
  const src = new ErpNextSource(
    { url: "https://example.invalid", apiKey: "test", apiSecret: "test" },
    { baseCurrency: "USD" },
  );
  Object.defineProperty(src, "client", { value: client });
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    { paymentRef: "PE-X", appliedRef: "SI-X", amount: "1000.00", currency: "USD", rate: null },
  ]);
});

test("only ERPNext bank and cash accounts inherit the reconcilable flag", () => {
  assert.equal(erpNextReconcilableAccountType("Bank"), true);
  assert.equal(erpNextReconcilableAccountType("Cash"), true);
  assert.equal(erpNextReconcilableAccountType("Receivable"), false);
  assert.equal(erpNextReconcilableAccountType("Payable"), false);
  assert.equal(erpNextReconcilableAccountType("Tax"), false);
  assert.equal(erpNextReconcilableAccountType(null), false);
});
