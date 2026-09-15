import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { ErpNextSource } from "./erpnext-source.ts";
import type { ErpNextClient } from "../erpnext.ts";

/**
 * Settlement-link currency fixtures (wave 3): Payment Entry
 * `references[].allocated_amount` is denominated in the invoice's account
 * currency (ERPNext docs: "Allocate the invoice in its account currency"),
 * so every invoice-backed link states that currency. The per-reference
 * `exchange_rate` direction is unproven against a live tenant, so no producer
 * rate is stated — foreign links resolve through the books' own line rates
 * and refuse loudly on any mismatch. References the map cannot price
 * ( Journal Entry advances and the like) stay unstated for the same reason.
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
