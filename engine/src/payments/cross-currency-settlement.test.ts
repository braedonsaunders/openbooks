import assert from "node:assert/strict";
import test from "node:test";
import { mulRate } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import {
  crossCurrencyAllocation,
  rateMeasuringExactly,
  sourceSettlingTarget,
  validateAllocationInputs,
  validateSettlementEvidence,
} from "./settlement-policy.ts";

test("the settling source is the largest four-place amount whose cross-rate stays within the balance", () => {
  // 0.7407407407 USD per CAD: 135.0000 CAD settles exactly 100.0000 USD.
  assert.deepEqual(sourceSettlingTarget("100.0000", "0.7407407407"), {
    source: "135.0000",
    settles: "100.0000",
  });
  // A rate with no exact source falls short by less than one rounding unit, never over.
  const { source, settles } = sourceSettlingTarget("100.0000", "3");
  assert.equal(source, "33.3333");
  assert.equal(settles, "99.9999");
  assert.equal(mulRate("33.3334", "3"), "100.0002", "the next unit would over-settle");
});

test("a cross-currency allocation cross-foots by construction and carries its evidence", () => {
  const allocation = crossCurrencyAllocation("ol-1", "135.00", {
    rate: "0.7407407407",
    source: "provider",
    reference: "Bank of Canada · 2026-07-15",
    fxRateId: "rate-1",
  });
  assert.equal(allocation.sourceTransactionAmount, "135.0000");
  assert.equal(allocation.targetTransactionAmount, "100.0000");
  assert.equal(allocation.settlementRate, "0.7407407407");
  assert.equal(allocation.settlementFxRateId, "rate-1");
  assert.doesNotThrow(() => validateAllocationInputs([allocation]));
  assert.doesNotThrow(() => validateSettlementEvidence(allocation, "CAD", "USD"));
  const manual = crossCurrencyAllocation("ol-2", "50", {
    rate: "0.75",
    source: "manual",
    reference: "Bank advice · rate on the credit advice",
  });
  assert.equal(manual.settlementFxRateId, undefined);
  assert.doesNotThrow(() => validateSettlementEvidence(manual, "CAD", "USD"));
});

test("a rate that settles nothing, or a non-positive balance, is refused by name", () => {
  assert.throws(() => sourceSettlingTarget("0.0000", "1.2"), PaymentError);
  assert.throws(
    () => sourceSettlingTarget("0.0001", "100000"),
    (error: unknown) => error instanceof PaymentError && /settles nothing/.test(error.message),
  );
});

test("a carrying rate recovered from a balance's two frames measures it back exactly", () => {
  for (const [transaction, carrying] of [
    ["40.0000", "52.0000"],
    ["100.0100", "133.3433"],
    ["333.3300", "444.4389"],
    ["0.0100", "0.0137"],
    ["987654.3200", "1312345.6789"],
  ] as const) {
    const { rate, exact } = rateMeasuringExactly(transaction, carrying);
    assert.equal(exact, true, `${transaction} → ${carrying}`);
    assert.equal(mulRate(transaction, rate), carrying);
  }
  assert.equal(rateMeasuringExactly("40", "52").rate, "1.3000000000");
  // Beyond what a ten-place rate can resolve, the nearest rate is returned
  // and flagged; the credit application realizes the sub-unit remainder.
  const coarse = rateMeasuringExactly("98765432.1000", "131234567.8901");
  assert.equal(coarse.exact, false);
  assert.ok(Math.abs(Number(mulRate("98765432.1000", coarse.rate)) - 131234567.8901) < 0.01);
  assert.throws(() => rateMeasuringExactly("0", "1"), PaymentError);
});
