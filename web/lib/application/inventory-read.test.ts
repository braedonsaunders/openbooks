import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./inventory-read.ts", import.meta.url), "utf8");

test("inventory levels keep quantity and value as strings from posted movements", () => {
  assert.match(SOURCE, /coalesce\(sum\(m\.quantity\), 0\)::text as quantity/);
  assert.match(SOURCE, /coalesce\(sum\(m\.total_value\), 0\)::text as value/);
  assert.match(SOURCE, /normalizeMoneyValue/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  assert.match(SOURCE, /GET \/api\/v1\/settings\/features/);
});
