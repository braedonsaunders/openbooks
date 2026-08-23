import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./payments.ts", import.meta.url), "utf8");

test("createPaymentDocument persists fxRate through canonicalDecimal then normalizeDecimal at FX scale", () => {
  const helperStart = source.indexOf("function persistPaymentFxRate");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistPaymentFxRate helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 10\)/);
  assert.match(helper, /normalizeDecimal\(exact, 10\)/);
  assert.match(helper, /exchange rate must be an exact decimal/);
  assert.doesNotMatch(helper, /return normalizeDecimal\(value, 10\)/);

  const start = source.indexOf("export async function createPaymentDocument");
  const next = source.indexOf("export async function updateDraftPayment");
  const body = source.slice(start, next);
  assert.match(body, /persistPaymentFxRate\(opts\.fxRate \?\? "1"\)/);
  assert.doesNotMatch(body, /normalizeDecimal\(opts\.fxRate \?\? "1", 10\)/);
});
