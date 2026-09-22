import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./banking.ts", import.meta.url), "utf8");
const start = SOURCE.indexOf("export async function listApplicationReconciliations");
const next = SOURCE.indexOf("\nexport async function", start + 1);
const body = next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, next);

test("reconciliation get reuses engine totals and keeps money exact", () => {
  const start = SOURCE.indexOf("export async function getApplicationReconciliation");
  const next = SOURCE.indexOf("\nexport async function", start + 1);
  const body = next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, next);
  assert.match(body, /reconciliationTotals\(/);
  assert.match(body, /normalizeMoneyValue\(String\(totals\.statementBalance\)\)/);
  assert.match(body, /normalizeMoneyValue\(String\(totals\.clearedBalance\)\)/);
  assert.match(body, /normalizeMoneyValue\(String\(totals\.difference\)\)/);
  assert.doesNotMatch(body, /\bnum\(/);
});

test("unmatched bank lines select amount as text and never credentials", () => {
  const start = SOURCE.indexOf("export async function listApplicationUnmatchedBankLines");
  const next = SOURCE.indexOf("\nexport async function", start + 1);
  const body = next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, next);
  assert.match(body, /l\.amount::text as amount/);
  assert.match(body, /normalizeMoneyValue/);
  assert.match(body, /match_status = 'unmatched'/);
  assert.doesNotMatch(body, /from bank_feed_connections/);
});

test("bank feeds never select sealed credentials", () => {
  const start = SOURCE.indexOf("export async function listApplicationBankFeeds");
  const next = SOURCE.indexOf("\nexport async function", start + 1);
  const body = next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, next);
  assert.match(body, /\(c\.credentials is not null\) as has_credentials/);
  assert.doesNotMatch(body, /select c\.credentials/);
});

test("reconciliation list keeps statement balance as an exact decimal and scopes accounts", () => {
  assert.match(body, /statement_balance::text as statement_balance/);
  assert.match(body, /normalizeMoneyValue\(String\(row\.statement_balance/);
  assert.doesNotMatch(body, /\bnum\(/);
  assert.match(body, /subsidiaryVisibleFilter\(sql`a\.subsidiary_id`/);
  assert.match(body, /GET \/api\/v1\/settings\/features/);
  assert.match(body, /assertApplicationPermission\(context, "banking\.read"\)/);
});
