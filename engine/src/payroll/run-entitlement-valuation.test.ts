import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "./error.ts";
import { entitlementWageInCurrency } from "./run-entitlement-valuation.ts";

test("entitlement hourly wages convert exactly into the pay run currency", () => {
  assert.equal(
    entitlementWageInCurrency({
      wage: "60.00",
      fromCurrency: "CAD",
      toCurrency: "USD",
      payDate: "2026-10-19",
      fxRate: "0.75",
    }),
    "45.0000",
  );
});

test("entitlement valuation refuses a missing foreign-exchange rate", () => {
  assert.throws(
    () =>
      entitlementWageInCurrency({
        wage: "60.00",
        fromCurrency: "CAD",
        toCurrency: "USD",
        payDate: "2026-10-19",
        fxRate: null,
      }),
    (error: unknown) =>
      error instanceof PayrollError &&
      /enter one before this employee can be paid/.test(error.message),
  );
});

test("same-currency entitlement wages need no exchange rate", () => {
  assert.equal(
    entitlementWageInCurrency({
      wage: "60.00",
      fromCurrency: "CAD",
      toCurrency: "CAD",
      payDate: "2026-10-19",
      fxRate: null,
    }),
    "60.00",
  );
});
