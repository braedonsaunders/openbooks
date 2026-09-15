import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { OdooSource } from "./odoo-source.ts";
import type { OdooClient } from "../odoo.ts";

/**
 * Settlement-link currency fixtures (wave 3): Odoo `account.partial.reconcile`
 * `amount` is company currency (Odoo multi-currency docs: reconciliation
 * matches "the invoice price in the invoice currency and the ... amount in
 * your company currency"; the foreign legs ride `debit/credit_amount_currency`
 * instead), so every link states the company base with no producer rate —
 * the reconciler prices it from the booked lines.
 */
function source(): OdooSource {
  const client = {
    searchReadAll: async (model: string) => {
      if (model === "account.partial.reconcile") {
        return [
          { id: 1, debit_move_id: [101, "INV/001"], credit_move_id: [102, "PAY/001"], amount: 250 },
        ];
      }
      return [];
    },
    executeKw: async () => [
      { id: 101, move_id: [201, "INV/001"], account_id: [11, "Receivable"] },
      { id: 102, move_id: [202, "PAY/001"], account_id: [11, "Receivable"] },
    ],
  } as unknown as OdooClient;
  const source = new OdooSource(
    { url: "https://example.invalid", database: "test", username: "test", apiKey: "test" },
    { orgId: "org", baseCurrency: "EUR" },
  );
  Object.defineProperty(source, "client", { value: client });
  return source;
}

const ctx = {
  accountByRef: new Map([
    ["11", { id: "ob-11", number: "1100", name: "Receivable", type: "asset_receivable" }],
  ]),
} as unknown as NativeContext;

test("partial-reconcile links state the company currency with no producer rate", async () => {
  const changes = await source().nativeChanges(null, ctx);
  assert.deepEqual(changes.applications, [
    { paymentRef: "202", appliedRef: "201", amount: "250.00", currency: "EUR", rate: null },
  ]);
});
