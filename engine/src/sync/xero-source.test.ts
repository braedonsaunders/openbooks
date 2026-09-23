import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { XeroSource, xeroCoverageMonths, xeroReconcilableAccount } from "./xero-source.ts";
import type { XeroClient } from "../connectors/xero.ts";

const ctx = { baseCurrency: "NZD" } as NativeContext;

/**
 * Settlement-link currency fixtures (wave 3): Xero payment and allocation
 * amounts are denominated in the INVOICE's currency (they must not exceed
 * the invoice outstanding), so every link states the invoice's CurrencyCode
 * with the producer's own rate — never a home-converted guess.
 *
 * Settlement-link sign rule (fleet 4, from the vendor's published Accounting
 * API contract, XeroAPI/xero-openapi `xero_accounting.yaml`): the shared
 * `components/schemas/Allocation` (`Amount`: "the amount being applied to the
 * invoice") serves CreditNote, Prepayment AND Overpayment allocations, and
 * `components/schemas/Payment` (`Amount`: "The amount of the payment. Must be
 * less than or equal to the outstanding amount owing on the invoice", with a
 * `PaymentType` enum covering ACCRECPAYMENT and ACCPAYPAYMENT) — every
 * application leg is an UNSIGNED magnitude on both the sales and the purchase
 * side. The adapter normalizes with abs() and skips only zero/missing legs.
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

test("coverage months span the full migration horizon, not a fixed window", () => {
  const months = xeroCoverageMonths("2024-03", new Date(Date.UTC(2026, 8, 22)));
  assert.equal(months[0], "2024-03");
  assert.equal(months[months.length - 1], "2026-09");
  assert.equal(months.length, 31);
  assert.ok(months.includes("2025-01"));

  const yearTurn = xeroCoverageMonths("2025-11", new Date(Date.UTC(2026, 0, 15)));
  assert.deepEqual(yearTurn, ["2025-11", "2025-12", "2026-01"]);

  assert.throws(() => xeroCoverageMonths("2024-3", new Date()), /invalid earliest/);
  assert.throws(() => xeroCoverageMonths("1900-01", new Date()), /exceeds 240 months/);
});

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

test("a signed allocation amount settles as an unsigned magnitude", async () => {
  const src = source({
    invoices: [{ InvoiceID: "INV-1", CurrencyCode: "USD", CurrencyRate: 1.5 }],
    credits: [
      {
        CreditNoteID: "C-1",
        Status: "AUTHORISED",
        CurrencyCode: "USD",
        CurrencyRate: 1.5,
        Allocations: [{ Amount: -40, Invoice: { InvoiceID: "INV-1" } }],
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

test("a bill-side payment settles as an unsigned magnitude", async () => {
  const src = source({
    invoices: [{ InvoiceID: "BILL-1", Type: "ACCPAY", CurrencyCode: "USD", CurrencyRate: 1.5 }],
    payments: [
      {
        PaymentID: "P-1",
        Status: "AUTHORISED",
        Invoice: { InvoiceID: "BILL-1", Type: "ACCPAY" },
        Amount: 100,
        CurrencyRate: 1.5,
      },
    ],
  });
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    {
      paymentRef: "Payment:P-1",
      appliedRef: "Invoice:BILL-1",
      amount: "100",
      currency: "USD",
      rate: "1.5",
    },
  ]);
});

test("a signed payment amount settles as an unsigned magnitude", async () => {
  const src = source({
    invoices: [{ InvoiceID: "INV-1", CurrencyCode: "USD", CurrencyRate: 1.5 }],
    payments: [
      {
        PaymentID: "P-1",
        Status: "AUTHORISED",
        Invoice: { InvoiceID: "INV-1" },
        Amount: -100,
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

test("a refund payment links to the credit note it settles", async () => {
  const src = source({
    payments: [
      {
        PaymentID: "P-2",
        Status: "AUTHORISED",
        CreditNote: { CreditNoteID: "C-2", Type: "ACCRECCREDIT" },
        PaymentType: "ARCREDITPAYMENT",
        Amount: 50,
        CurrencyRate: 1.5,
      },
    ],
    credits: [
      {
        CreditNoteID: "C-2",
        Status: "AUTHORISED",
        CurrencyCode: "USD",
        CurrencyRate: 1.5,
        Allocations: [],
      },
    ],
  });
  const changes = await src.nativeChanges(null, ctx);
  // The refund states the credit's currency at the payment's rate — the same
  // shape as an invoice receipt link, so the credit closes in the subledger.
  assert.deepEqual(changes.applications, [
    {
      paymentRef: "Payment:P-2",
      appliedRef: "CreditNote:C-2",
      amount: "50",
      currency: "USD",
      rate: "1.5",
    },
  ]);
});

test("a payment against an unimported prepayment links to nothing resolvable", async () => {
  // Prepayment/Overpayment target documents are not pulled (no endpoint), so
  // the payment posts standalone and no link is emitted — a link to a ref
  // that can never resolve would only inflate the reconciler's skipped count.
  const src = source({
    payments: [
      {
        PaymentID: "P-3",
        Status: "AUTHORISED",
        Prepayment: { PrepaymentID: "PRE-1", Type: "RECEIVE-PREPAYMENT" },
        PaymentType: "ARPREPAYMENTPAYMENT",
        Amount: 70,
        CurrencyRate: 1.5,
      },
    ],
  });
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, []);
});

test("only Xero bank accounts inherit the reconcilable flag", () => {
  assert.equal(xeroReconcilableAccount("BANK"), true);
  assert.equal(xeroReconcilableAccount("CURRENT"), false);
  assert.equal(xeroReconcilableAccount("SALES"), false);
  assert.equal(xeroReconcilableAccount("OVERPAYMENTS"), false);
});
