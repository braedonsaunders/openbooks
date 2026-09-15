import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { XeroSource } from "./xero-source.ts";
import type { XeroClient } from "../xero.ts";

const ctx = { baseCurrency: "NZD" } as NativeContext;

/**
 * Settlement-link currency fixtures (wave 3): Xero payment and allocation
 * amounts are denominated in the INVOICE's currency (they must not exceed
 * the invoice outstanding), so every link states the invoice's CurrencyCode
 * with the producer's own rate — never a home-converted guess.
 */
function source(routes: {
  invoices?: unknown[];
  payments?: unknown[];
  credits?: unknown[];
}): XeroSource {
  const client = {
    get: async () => ({ Accounts: [] }),
    listAll: async (path: string, _key: string, ...rest: unknown[]) => {
      if (rest.length > 0) return []; // windowed document sweep
      if (path === "Invoices") return routes.invoices ?? [];
      if (path === "Payments") return routes.payments ?? [];
      if (path === "CreditNotes") return routes.credits ?? [];
      return [];
    },
  } as unknown as XeroClient;
  return new XeroSource(client, { orgId: "org", baseCurrency: "NZD" });
}

test("payment links state the invoice currency at the payment rate", async () => {
  const src = source({
    invoices: [{ InvoiceID: "INV-1", CurrencyCode: "USD", CurrencyRate: 1.5 }],
    payments: [
      {
        PaymentID: "P-1",
        Status: "AUTHORISED",
        Invoice: { InvoiceID: "INV-1" },
        Amount: 100,
        CurrencyRate: 1.5,
      },
    ],
  });
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    {
      paymentRef: "Payment:P-1",
      appliedRef: "Invoice:INV-1",
      amount: "100",
      currency: "USD",
      rate: "1.5",
    },
  ]);
});

test("allocation links state the invoice currency at the invoice rate", async () => {
  const src = source({
    invoices: [{ InvoiceID: "INV-1", CurrencyCode: "USD", CurrencyRate: 1.5 }],
    credits: [
      {
        CreditNoteID: "C-1",
        Status: "AUTHORISED",
        CurrencyCode: "USD",
        CurrencyRate: 1.5,
        Allocations: [{ Amount: 40, Invoice: { InvoiceID: "INV-1" } }],
      },
    ],
  });
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    {
      paymentRef: "CreditNote:C-1",
      appliedRef: "Invoice:INV-1",
      amount: "40",
      currency: "USD",
      rate: "1.5",
    },
  ]);
});
