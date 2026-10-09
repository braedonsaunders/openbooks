import assert from "node:assert/strict";
import test from "node:test";
import { withholdingCurrencyRate, withholdingStatutoryAmount, withholdingTransactionAmount } from "./payment-currency.ts";

test("statutory FX retains ten-place quotes without binary arithmetic", () => {
  assert.equal(withholdingCurrencyRate("0.8000000001"), "0.8000000001");
  assert.equal(withholdingStatutoryAmount("99999999.9999", "0.8000000001"), "80000000.0099");
  assert.equal(withholdingTransactionAmount("160", "0.8", 2), "200.0000");
});

test("cash conversion rounds once at the currency quantum", () => {
  assert.equal(withholdingTransactionAmount("1", "1.0050761293", 2), "0.9900");
  assert.equal(withholdingTransactionAmount("200", "0.8", 0), "250.0000");
  assert.equal(withholdingTransactionAmount("1", "0.8", 3), "1.2500");
});

test("missing, zero, negative and malformed FX cannot become par", () => {
  for (const rate of [null, undefined, "0", "-1", "1,25", "1e2", "0.00000000001"]) assert.throws(() => withholdingCurrencyRate(rate));
});
