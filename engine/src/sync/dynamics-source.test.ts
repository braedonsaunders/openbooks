import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { DynamicsSource } from "./dynamics-source.ts";
import type { DynamicsClient } from "../dynamics.ts";

/**
 * Settlement-link currency fixtures (wave 3): every Dynamics link amount is
 * derived from a single invoice object, so it states that invoice's
 * `currencyCode` (Microsoft Learn: "The default currency code for the sales
 * invoice"; a blank code is BC's LCY convention, i.e. the company base).
 * Business Central v2.0 exposes no settlement FX rate on these entities, so
 * no producer rate is stated — foreign links resolve through the books' own
 * line rates and refuse loudly on any mismatch.
 *
 * Published gap: (1) confirm `remainingAmount` is always document-currency on
 * multi-currency invoices; (2) confirm no settlement-rate field exists on the
 * payment application detail; (3) the denomination of standalone
 * payment-journal `amount`s is unproven — those links state the payment's own
 * `currencyCode` when present and likewise carry no rate.
 */
function source(): DynamicsSource {
  const client = {
    list: async (path: string) => {
      if (path === "salesInvoices") {
        return [
          {
            id: "inv1",
            number: "INV-1",
            invoiceDate: "2026-01-15",
            status: "Open",
            customerId: "c1",
            currencyCode: "EUR",
            remainingAmount: 60,
            salesInvoiceLines: [
              { lineType: "Account", accountId: "GL-101", amountExcludingTax: 100, totalTaxAmount: 0 },
            ],
          },
        ];
      }
      if (path === "customerPayments") {
        return [
          {
            id: "pay1",
            invoiceDate: "2026-01-20",
            status: "Open",
            customerId: "c1",
            accountId: "GL-200",
            amount: 40,
            currencyCode: "EUR",
            appliesToInvoiceId: "inv1",
          },
        ];
      }
      return [];
    },
  } as unknown as DynamicsClient;
  return new DynamicsSource(client, { orgId: "org", baseCurrency: "USD" });
}

const ctx = {
  baseCurrency: "USD",
  control: { bank: "ob-bank" },
  accountByRef: new Map([
    ["GL-101", { id: "ob-101", number: "4000", name: "Sales", type: "income" }],
    ["GL-200", { id: "ob-bank", number: "1000", name: "Bank", type: "asset_bank" }],
  ]),
  partyByRef: new Map(),
  taxCodeByRef: new Map(),
} as unknown as NativeContext;

test("invoice settlements and payment applications state the invoice currency with no rate", async () => {
  const changes = await source().nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    {
      paymentRef: "salesInvoicePayment:inv1",
      appliedRef: "salesInvoice:inv1",
      amount: "40.00",
      currency: "EUR",
      rate: null,
    },
    {
      paymentRef: "customerPayment:pay1",
      appliedRef: "salesInvoice:inv1",
      amount: "40.00",
      currency: "EUR",
      rate: null,
    },
  ]);
});
