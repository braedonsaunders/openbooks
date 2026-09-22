import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./crm-read.ts", import.meta.url), "utf8");

test("opportunity list keeps amounts as exact decimals and reuses CRM scope", () => {
  assert.match(SOURCE, /projected_amount::text as projected_amount/);
  assert.match(SOURCE, /weighted_amount::text as weighted_amount/);
  assert.match(SOURCE, /normalizeMoneyValue/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  assert.match(SOURCE, /crmOpportunityScope/);
  assert.match(SOURCE, /GET \/api\/v1\/settings\/features/);
  assert.match(SOURCE, /assertApplicationPermission\(context, "crm\.opportunities\.read"\)/);
});
