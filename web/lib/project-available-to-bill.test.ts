import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { availableToBill } from "./project-available-to-bill";

const RATES = "54000.0000";

test("time and materials projects keep the valued-work figure", () => {
  for (const billingMethod of ["time_and_materials", "cost_plus"] as const) {
    assert.deepEqual(
      availableToBill({
        billingMethod,
        ratesRevenue: RATES,
        contractValue: "100000",
        invoicedToDate: "5000",
      }),
      { basis: "rates", amount: RATES },
    );
  }
});

test("a fixed-price project shows the contract value less what is invoiced, never time at rates", () => {
  const result = availableToBill({
    billingMethod: "fixed_price",
    ratesRevenue: RATES,
    contractValue: "100000.0000",
    invoicedToDate: "45500.0000",
  });
  assert.equal(result.basis, "contract");
  assert.equal(
    result.basis === "contract" && normalizeMoney(result.amount),
    normalizeMoney("54500"),
  );
  assert.notEqual(
    result.basis === "contract" && normalizeMoney(result.amount),
    normalizeMoney(RATES),
  );
});

test("a fixed-price project over its contract shows the overbilled amount as negative", () => {
  const result = availableToBill({
    billingMethod: "fixed_price",
    ratesRevenue: RATES,
    contractValue: "1000",
    invoicedToDate: "1250.5000",
  });
  assert.equal(result.basis, "contract");
  assert.equal(
    result.basis === "contract" && normalizeMoney(result.amount),
    normalizeMoney("-250.5"),
  );
});

test("the remaining amount is exact decimal arithmetic", () => {
  const result = availableToBill({
    billingMethod: "fixed_price",
    ratesRevenue: "0",
    contractValue: "1000000.01",
    invoicedToDate: "0.02",
  });
  assert.equal(
    result.basis === "contract" && normalizeMoney(result.amount),
    normalizeMoney("999999.99"),
  );
});

test("a fixed-price project without a contract value refuses by name instead of showing rates or zero", () => {
  const result = availableToBill({
    billingMethod: "fixed_price",
    ratesRevenue: RATES,
    contractValue: null,
    invoicedToDate: "0",
  });
  assert.deepEqual(result, { basis: "contract_unset", invoicedToDate: normalizeMoney("0") });
  assert.equal("amount" in result, false);
});

test("a malformed invoiced amount refuses rather than being read as zero", () => {
  assert.throws(() =>
    availableToBill({
      billingMethod: "fixed_price",
      ratesRevenue: RATES,
      contractValue: "1000",
      invoicedToDate: "not-money",
    }),
  );
});
