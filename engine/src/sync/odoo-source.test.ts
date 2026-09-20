import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { buildNativeFromOdoo, type OdooMove, type OdooMoveLine } from "./odoo-native.ts";
import { OdooSource, odooReconcilableAccountType } from "./odoo-source.ts";
import type { OdooClient } from "../connectors/odoo.ts";

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

test("Odoo journal lines propagate match numbers as cleared evidence", () => {
  const bankCtx = {
    accountByRef: new Map([
      ["10", { id: "ob-10", number: "1000", name: "Bank", type: "asset_bank" }],
      ["20", { id: "ob-20", number: "4000", name: "Sales", type: "income" }],
    ]),
    partyByRef: new Map(),
  } as unknown as NativeContext;
  const move: OdooMove = {
    id: 301, name: "BNK/001", move_type: "entry", state: "posted",
    partner_id: false, invoice_date: false, invoice_date_due: false,
    date: "2026-08-27", ref: false, payment_id: false,
    statement_line_id: false, write_date: "2026-08-28 10:00:00",
  };
  const lines: OdooMoveLine[] = [
    {
      id: 401, move_id: [301, "BNK/001"], account_id: [10, "Bank"],
      name: "deposit", balance: 100, display_type: "payment_term",
      tax_ids: [], tax_line_id: false, partner_id: false, matching_number: "P123",
    },
    {
      id: 402, move_id: [301, "BNK/001"], account_id: [20, "Sales"],
      name: "sales", balance: -100, display_type: "product",
      tax_ids: [], tax_line_id: false, partner_id: false, matching_number: false,
    },
  ];
  const built = buildNativeFromOdoo(bankCtx, move, lines, {
    paymentPartnerType: new Map(),
    taxRateById: new Map(),
  });
  assert.ok(!("skip" in built));
  // Odoo states reconciliation per move line (matching_number, set when the
  // line is matched); the move date stands in for the unstated clear date.
  assert.deepEqual(
    built.lines.map((line) => [line.sourceLineRef, line.sourceCleared, line.sourceClearedDate]),
    [
      ["401", true, "2026-08-27"],
      ["402", false, null],
    ],
  );
});

test("only Odoo cash and card accounts inherit the reconcilable flag", () => {
  assert.equal(odooReconcilableAccountType("asset_cash"), true);
  assert.equal(odooReconcilableAccountType("liability_credit_card"), true);
  assert.equal(odooReconcilableAccountType("asset_receivable"), false);
  assert.equal(odooReconcilableAccountType("expense"), false);
  assert.equal(odooReconcilableAccountType("nope"), false);
});
