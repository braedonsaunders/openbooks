import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./trial-balance-read.ts", import.meta.url), "utf8");

test("trial balance reuses the statement reader and keeps money exact", () => {
  assert.match(SOURCE, /from "\.\.\/reports\/statements"/);
  assert.match(SOURCE, /trialBalance\(/);
  assert.match(SOURCE, /normalizeMoneyValue/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  assert.match(SOURCE, /asOf must be YYYY-MM-DD/);
  assert.match(SOURCE, /reports\.read/);
});
