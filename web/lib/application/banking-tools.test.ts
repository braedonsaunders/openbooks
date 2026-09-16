import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const banking = read("../application/banking.ts");
const catalog = read("../application/tool-catalog.ts");

// Every banking mutation must terminate in the engine/banking-rules service
// the routes call — never a parallel SQL path to reconciliation_matches.
test("banking application wrappers reuse the route services", () => {
  assert.match(banking, /startReconciliation\(/);
  assert.match(banking, /createMatch\(/);
  assert.match(banking, /addJournalMatchFromLine\(/);
  assert.match(banking, /unmatchStatementLine\(/);
  assert.match(banking, /markReconciled\(/);
  assert.doesNotMatch(banking, /reconciliation_matches/);
  assert.doesNotMatch(banking, /insert into reconciliations/);
});

test("banking mutations enforce permission, feature, and subsidiary gates", () => {
  assert.match(banking, /assertApplicationPermission\(context, "banking\.reconcile"\)/);
  assert.match(banking, /isFeatureEnabled\(.*?"banking"\)/);
  assert.match(banking, /assertSubsidiaryAccess\(context, await accountSubsidiary\(/);
  assert.match(banking, /assertSubsidiaryAccess\(context, await reconciliationSubsidiary\(/);
  // Engine BankingError/PostingError/control-account messages are controlled
  // operator feedback (tool-errors.ts allowlists them); the wrapper maps them
  // onto the application error contract instead of leaking raw throws.
  assert.match(banking, /BankingError/);
  assert.match(banking, /invalid_input/);
  assert.match(banking, /executeIdempotent\(/);
});

test("banking tools are registered with confirmation and idempotency", () => {
  for (const name of [
    "start_reconciliation",
    "match_bank_line",
    "match_bank_line_with_journal",
    "unmatch_bank_line",
    "sign_off_reconciliation",
  ]) {
    assert.ok(catalog.includes(`name: "${name}"`), `catalog must register ${name}`);
  }
  const block = catalog.slice(catalog.indexOf('name: "start_reconciliation"'));
  assert.match(block, /featureKey: "banking"/);
  assert.match(block, /assistantConfirmation: "always"/);
  assert.match(block, /idempotencyKey: IDEMPOTENCY_KEY/);
  assert.match(block, /banking\.reconcile/);
});
