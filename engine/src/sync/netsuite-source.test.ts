import assert from "node:assert/strict";
import test from "node:test";
import { netSuiteReconcilableAccount } from "./netsuite-source.ts";

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
