import assert from "node:assert/strict";
import test from "node:test";
import {
  netSuiteLineColumns,
  netSuiteReconcilableAccount,
  normalizeNetSuiteClearedStates,
} from "./netsuite-source.ts";

/**
 * The reconcilable flag is a bank-reconciliation input: only bank and card
 * accounts may inherit it from the source, however the source flags other
 * types. The real tenant carries a COGS account (5090) and an expense
 * account (5901) wrongly flagged reconcilable by the un-gated import; both
 * must map to false while genuinely flagged bank/card accounts stay true.
 */
test("only bank and card accounts inherit the source reconcilable flag", () => {
  assert.equal(netSuiteReconcilableAccount("Bank", "T"), true);
  assert.equal(netSuiteReconcilableAccount("CredCard", "T"), true);
  // Tenant evidence: 5090/cogs and 5901/expense arrive flagged but must not inherit.
  assert.equal(netSuiteReconcilableAccount("COGS", "T"), false);
  assert.equal(netSuiteReconcilableAccount("Expense", "T"), false);
  assert.equal(netSuiteReconcilableAccount("AcctRec", "T"), false);
  assert.equal(netSuiteReconcilableAccount("Income", "T"), false);
  // An unflagged bank account stays non-reconcilable.
  assert.equal(netSuiteReconcilableAccount("Bank", "F"), false);
  assert.equal(netSuiteReconcilableAccount("Bank", null), false);
  // Unknown source types never inherit.
  assert.equal(netSuiteReconcilableAccount("NoSuchType", "T"), false);
});

test("NetSuite line pulls carry cleared markers", () => {
  assert.match(netSuiteLineColumns({}), /tl\.cleared/);
  assert.match(netSuiteLineColumns({}), /cleareddate/);
});

test("NetSuite cleared states normalize with a transaction-date fallback", () => {
  assert.deepEqual(
    normalizeNetSuiteClearedStates([
      { transaction: "7001", id: "11", cleared: "T", cleareddate: "08/31/2026", trandate: "08/28/2026" },
      { transaction: "7001", id: "12", cleared: "T", cleareddate: null, trandate: "08/28/2026" },
      { transaction: "7002", id: "21", cleared: "F", cleareddate: null, trandate: "08/29/2026" },
    ]),
    [
      { docRef: "7001", lineRef: "11", cleared: true, clearedDate: "2026-08-31" },
      // Cleared without a clear date falls back to the transaction date —
      // evidence understated is safe, evidence invented is not.
      { docRef: "7001", lineRef: "12", cleared: true, clearedDate: "2026-08-28" },
      { docRef: "7002", lineRef: "21", cleared: false, clearedDate: null },
    ],
  );
});
