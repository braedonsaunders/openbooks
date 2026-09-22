import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./banking.ts", import.meta.url), "utf8");
const start = SOURCE.indexOf("export async function listApplicationReconciliations");
const next = SOURCE.indexOf("\nexport async function", start + 1);
const body = next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, next);

test("reconciliation list keeps statement balance as an exact decimal and scopes accounts", () => {
  assert.match(body, /statement_balance::text as statement_balance/);
  assert.match(body, /normalizeMoneyValue\(String\(row\.statement_balance/);
  assert.doesNotMatch(body, /\bnum\(/);
  assert.match(body, /subsidiaryVisibleFilter\(sql`a\.subsidiary_id`/);
  assert.match(body, /GET \/api\/v1\/settings\/features/);
  assert.match(body, /assertApplicationPermission\(context, "banking\.read"\)/);
});
