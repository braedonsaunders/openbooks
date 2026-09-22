import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./fx-read.ts", import.meta.url), "utf8");

test("FX rates select rate as text and refuse feature-off by naming the Features page", () => {
  assert.match(SOURCE, /rate::text as rate/);
  assert.match(SOURCE, /GET \/api\/v1\/settings\/features/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  assert.match(SOURCE, /fromCurrency and toCurrency must be ISO 4217 codes/);
});
