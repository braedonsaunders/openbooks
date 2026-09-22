import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./aging-read.ts", import.meta.url), "utf8");

test("aging reads reuse the report engine and keep buckets as exact decimals", () => {
  assert.match(SOURCE, /agingByParty/);
  assert.match(SOURCE, /agingDetail/);
  assert.match(SOURCE, /normalizeMoneyValue/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  assert.doesNotMatch(SOURCE, /\bNumber\(row\./);
  assert.match(SOURCE, /side is required; use ar or ap/);
  assert.match(SOURCE, /AgingRatesUnavailableError/);
  assert.match(SOURCE, /partnerStatement/);
});
