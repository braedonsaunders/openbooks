import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveNetSuiteCrmCurrency,
  resolveNetSuiteCrmOpportunityProbability,
} from "./netsuite-crm.ts";

test("resolves opportunity currencies through configured ISO currencies", () => {
  const sourceCurrencies = new Map([
    ["1", "CAD"],
    ["2", "USD"],
  ]);
  const configuredCurrencies = new Set(["CAD", "USD"]);
  assert.equal(
    resolveNetSuiteCrmCurrency("2", "CAD", sourceCurrencies, configuredCurrencies),
    "USD",
  );
  assert.equal(
    resolveNetSuiteCrmCurrency(null, "CAD", sourceCurrencies, configuredCurrencies),
    "CAD",
  );
  assert.equal(
    resolveNetSuiteCrmCurrency("EUR", "CAD", sourceCurrencies, configuredCurrencies),
    null,
  );
  assert.equal(
    resolveNetSuiteCrmCurrency("not-a-currency", "CAD", sourceCurrencies, configuredCurrencies),
    null,
  );
});

test("uses source opportunity probability when valid and the configured default otherwise", () => {
  assert.equal(resolveNetSuiteCrmOpportunityProbability("37", 10), 37);
  assert.equal(resolveNetSuiteCrmOpportunityProbability(null, 25), 25);
  assert.equal(resolveNetSuiteCrmOpportunityProbability("not-a-probability", 25), 25);
});
