import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { DynamicsSource } from "./dynamics-source.ts";
import type { DynamicsClient } from "../connectors/dynamics.ts";

/**
 * Settlement-link currency fixtures (fleet 4, from the vendor's published
 * Business Central v2.0 API reference on Microsoft Learn):
 * - `salesInvoice`, §Properties: `remainingAmount` "The amount including VAT"
 *   sits among the document totals, with `currencyCode` "The default currency
 *   code for the sales invoice". No LCY-denominated property exists on the
 *   resource, so `remainingAmount` is denominated in the invoice's
 *   `currencyCode` (blank = LCY = the company base).
 * - `purchaseInvoice`, §Properties: exposes NO `remainingAmount` property (the
 *   table runs discountAppliedBeforeTax → totals → status), so the adapter
 *   reconstructs purchase settlement ONLY from evidenced journal applications
 *   and never invents it from a missing field. Purchase open-item truth is
 *   status-driven: Paid → 0, otherwise total − journal-applied (capped at 0).
 * - `customerPayment` / `vendorPayment`, §Properties: expose NO currency
 *   property, so standalone journal amounts state the connection base with no
 *   producer rate. `applyVendorEntry`, §Properties: carries `remainingAmount`
 *   but NO applied-amount, currency or rate property — no settlement-rate
 *   field exists on applied-entry detail (and the customerPayment navigation
 *   table lists no apply-entries navigation: customer-side applications ride
 *   the invoice object only). None of the five resources exposes an FX-rate
 *   property, so no producer rate is ever stated — foreign links resolve
 *   through the books' own line rates and refuse loudly on any mismatch.
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

/** Purchase-side routes: the v2.0 purchaseInvoice resource carries no
 * `remainingAmount`, so the mock omits it exactly as the wire does. */
function purchaseSource(routes: {
  purchaseInvoices?: unknown[];
  vendorPayments?: unknown[];
}): DynamicsSource {
  const client = {
    list: async (path: string) => {
      if (path === "accounts") return [];
      if (path === "generalLedgerEntries") return [];
      if (path === "purchaseInvoices") return routes.purchaseInvoices ?? [];
      if (path === "vendorPayments") return routes.vendorPayments ?? [];
      return [];
    },
  } as unknown as DynamicsClient;
  return new DynamicsSource(client, { orgId: "org", baseCurrency: "USD" });
}

const billLines = [
  { lineType: "Account", accountId: "GL-101", amountExcludingTax: 100, totalTaxAmount: 0 },
];

test("a purchase invoice without remainingAmount reconstructs no settlement", async () => {
  const src = purchaseSource({
    purchaseInvoices: [
      {
        id: "bill1",
        number: "BILL-1",
        invoiceDate: "2026-01-15",
        status: "Open",
        vendorId: "v1",
        purchaseInvoiceLines: billLines,
      },
    ],
  });
  const changes = await src.nativeChanges(null, ctx);
  assert.equal(changes.documents.length, 1);
  assert.equal(changes.documents[0]?.kind, "vendor_bill");
  assert.deepEqual(changes.applications, []);
});

test("a blank invoice currency states the base with no rate", async () => {
  const client = {
    list: async (path: string) => {
      if (path === "accounts") return [];
      if (path === "generalLedgerEntries") return [];
      if (path === "salesInvoices") {
        return [
          {
            id: "inv1",
            number: "INV-1",
            invoiceDate: "2026-01-15",
            status: "Open",
            customerId: "c1",
            remainingAmount: 60,
            salesInvoiceLines: [
              { lineType: "Account", accountId: "GL-101", amountExcludingTax: 100, totalTaxAmount: 0 },
            ],
          },
        ];
      }
      return [];
    },
  } as unknown as DynamicsClient;
  const changes = await new DynamicsSource(client, { orgId: "org", baseCurrency: "USD" }).nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    {
      paymentRef: "salesInvoicePayment:inv1",
      appliedRef: "salesInvoice:inv1",
      amount: "40.00",
      currency: "USD",
      rate: null,
    },
  ]);
});

test("purchase open-item truth nets journal applications off the bill total", async () => {
  const src = purchaseSource({
    purchaseInvoices: [
      { id: "open1", status: "Open", totalAmountIncludingTax: 100 },
      { id: "paid1", status: "Paid", totalAmountIncludingTax: 100 },
      { id: "over1", status: "Open", totalAmountIncludingTax: 100 },
    ],
    vendorPayments: [
      { id: "pay1", appliesToInvoiceId: "open1", amount: 40 },
      { id: "pay2", appliesToInvoiceId: "over1", amount: 120 },
    ],
  });
  assert.deepEqual(await src.openItems(), [
    { ref: "purchaseInvoice:open1", unpaid: "60.00" },
    { ref: "purchaseInvoice:paid1", unpaid: "0.00" },
    { ref: "purchaseInvoice:over1", unpaid: "0.00" },
  ]);
});
