import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { QboSource } from "./qbo-source.ts";
import type { QboClient } from "../connectors/qbo.ts";

const ctx = { baseCurrency: "USD" } as NativeContext;

function source(rows: Record<string, unknown[]>): QboSource {
  const client = {
    queryAll: async (entity: string) => rows[entity] ?? [],
  } as unknown as QboClient;
  return new QboSource(client, { orgId: "org", baseCurrency: "USD" });
}

/** Payments serve the document sweep (with `where`) and the link graph (without). */
function linkSource(payments: unknown[]): QboSource {
  const client = {
    queryAll: async (entity: string, where?: string) =>
      entity === "Payment" && where === undefined ? payments : [],
  } as unknown as QboClient;
  return new QboSource(client, { orgId: "org", baseCurrency: "USD" });
}

test("open items stay in transaction currency for foreign balances", async () => {
  const src = source({
    Invoice: [{ Id: "101", Balance: 100, ExchangeRate: 1.2, PrivateNote: "" }],
    Bill: [{ Id: "202", Balance: 50.5, ExchangeRate: 1, PrivateNote: "" }],
  });
  assert.deepEqual(await src.openItems(), [
    { ref: "Invoice:101", unpaid: "100.00" },
    { ref: "Bill:202", unpaid: "50.50" },
  ]);
});

test("open items drop only exact-marker voided transactions at zero", async () => {
  const src = source({
    Invoice: [
      { Id: "1", Balance: 0, ExchangeRate: 1, PrivateNote: "Voided" },
      { Id: "2", Balance: 200, ExchangeRate: 1.2, PrivateNote: "Voided" },
      { Id: "3", Balance: 75, ExchangeRate: 1, PrivateNote: "Customer avoided voiding" },
      { Id: "4", ExchangeRate: 1, PrivateNote: "Voided" },
    ],
  });
  // The zeroed provider void leaves truth; the nonzero "Voided" memo, the
  // mention-void memo, and the marker with a missing balance stay covered so
  // a live document cannot drift silently.
  assert.deepEqual(await src.openItems(), [
    { ref: "Invoice:2", unpaid: "200.00" },
    { ref: "Invoice:3", unpaid: "75.00" },
    { ref: "Invoice:4", unpaid: "0.00" },
  ]);
});

test("payment links ride along stated in the payment currency at its rate", async () => {
  // Recorded QBO shape: a 100 EUR payment at 1.2 against invoice 101.
  const src = linkSource([
    {
      Id: "900",
      CurrencyRef: { value: "EUR", name: "Euro" },
      ExchangeRate: 1.2,
      TotalAmt: 120,
      Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "101", TxnType: "Invoice" }] }],
    },
  ]);
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    { paymentRef: "Payment:900", appliedRef: "Invoice:101", amount: "100", currency: "EUR", rate: "1.2" },
  ]);
});

test("a payment with no CurrencyRef falls back to the company base, never a defaulted rate", async () => {
  const src = linkSource([
    {
      Id: "901",
      TotalAmt: 50,
      Line: [{ Amount: 50, LinkedTxn: [{ TxnId: "102", TxnType: "Invoice" }] }],
    },
  ]);
  const changes = await src.nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    { paymentRef: "Payment:901", appliedRef: "Invoice:102", amount: "50", currency: "USD", rate: null },
  ]);
});
