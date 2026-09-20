import assert from "node:assert/strict";
import { test } from "node:test";
import { measureLesseeLease } from "./leases.ts";
import { measureLeaseChange } from "./lease-changes.ts";
import { toUnits } from "../money/money.ts";

for (const model of ["finance", "operating"] as const) {
  test(`${model}: advance cash is paid at commencement, unpaid liability excludes it`, () => {
    const m = measureLesseeLease({
      payment: "20000",
      periods: 5,
      annualRatePercent: "5",
      periodsPerYear: 1,
      timing: "advance",
      model,
    });
    assert.equal(m.initialPayment, "20000.0000");
    assert.equal(m.liability, "70919.0101");
    assert.equal(m.rouAsset, "90919.0101");
    assert.equal(m.schedule[0]!.payment, "0.0000");
    assert.equal(m.schedule[0]!.interest, "3545.9505");
    assert.equal(m.schedule.at(-1)!.closing, "0.0000");
    assert.equal(m.schedule.at(-1)!.interest, "0.0000");
    assert.equal(
      m.schedule.reduce(
        (a, r) => a + toUnits(r.amortization ?? r.rouAdjustment!),
        0n,
      ),
      toUnits(m.rouAsset),
    );
    assert.equal(
      m.schedule.reduce(
        (a, r) => a + toUnits(r.payment) - toUnits(r.interest),
        0n,
      ),
      toUnits(m.liability),
    );
    if (model === "operating")
      assert.equal(
        m.schedule.reduce((a, r) => a + toUnits(r.singleCost!), 0n),
        toUnits("100000"),
      );
  });
  test(`${model}: a single advance period has no unpaid debt or fictitious interest`, () => {
    const m = measureLesseeLease({
      payment: "1000",
      periods: 1,
      annualRatePercent: "6",
      periodsPerYear: 12,
      timing: "advance",
      model,
    });
    assert.equal(m.liability, "0.0000");
    assert.equal(m.rouAsset, "1000.0000");
    assert.equal(m.schedule[0]!.interest, "0.0000");
    assert.equal(
      m.schedule[0]!.amortization ?? m.schedule[0]!.singleCost,
      "1000.0000",
    );
  });
  test(`${model}: ROU costs retire exactly without an unbalanced operating entry`, () => {
    const m = measureLesseeLease({
      payment: "1000",
      periods: 3,
      annualRatePercent: "6",
      periodsPerYear: 12,
      timing: "arrears",
      model,
      initialDirectCosts: "30",
      prepayments: "90",
      incentives: "15",
    });
    assert.equal(toUnits(m.rouAsset) - toUnits(m.liability), toUnits("105"));
    assert.equal(
      m.schedule.reduce(
        (a, r) => a + toUnits(r.amortization ?? r.rouAdjustment!),
        0n,
      ),
      toUnits(m.rouAsset),
    );
    if (model === "operating")
      for (const r of m.schedule)
        assert.equal(
          toUnits(r.singleCost!) -
            toUnits(r.interest) -
            toUnits(r.rouAdjustment!),
          0n,
        );
  });
}
test("scope reduction derecognizes proportional carrying amounts before remeasurement", () => {
  const r = measureLeaseChange({
    liability: "10000",
    rouAsset: "8000",
    scopeReductionPercent: "25",
    newLiability: "7000",
    settlementPayment: "0",
  });
  assert.equal(r.removedLiability, "2500.0000");
  assert.equal(r.removedRou, "2000.0000");
  assert.equal(r.newRou, "5500.0000");
  assert.equal(r.gain, "500.0000");
});
test("full termination includes cash settlement and removes both balances", () => {
  const r = measureLeaseChange({
    liability: "10000",
    rouAsset: "8000",
    scopeReductionPercent: "100",
    newLiability: "0",
    settlementPayment: "900",
  });
  assert.equal(r.newRou, "0.0000");
  assert.equal(r.newLiability, "0.0000");
  assert.equal(r.gain, "1100.0000");
});
test("remeasurement never credits ROU below zero; excess is a gain", () => {
  const r = measureLeaseChange({
    liability: "10000",
    rouAsset: "1000",
    scopeReductionPercent: "0",
    newLiability: "8000",
    settlementPayment: "0",
  });
  assert.equal(r.newRou, "0.0000");
  assert.equal(r.gain, "1000.0000");
});
test("every lease adjustment balances at ledger precision", () => {
  for (const percent of ["0", "0.0001", "12.3456", "50", "100"])
    for (const revised of ["0", "123.4567", "12345.6789"]) {
      const r = measureLeaseChange({
        liability: "10000.1234",
        rouAsset: "9876.4321",
        scopeReductionPercent: percent,
        newLiability: revised,
        settlementPayment: "17.0001",
      });
      assert.equal(
        toUnits(r.rouDelta) -
          toUnits(r.liabilityDelta) -
          toUnits(r.settlement) -
          toUnits(r.gain),
        0n,
      );
    }
});
test("invalid scope, carrying amount and precision refuse before producing a journal", () => {
  const base = {
    liability: "10000",
    rouAsset: "8000",
    scopeReductionPercent: "0",
    newLiability: "9000",
    settlementPayment: "0",
  };
  for (const patch of [
    { scopeReductionPercent: "100.0001" },
    { scopeReductionPercent: "-1" },
    { liability: "-1" },
    { rouAsset: "NaN" },
    { newLiability: "1.23456" },
  ])
    assert.throws(() => measureLeaseChange({ ...base, ...patch }));
});

test("termination refund is a receipt, not another payment", () => {
  const result = measureLeaseChange({
    liability: "0",
    rouAsset: "900",
    scopeReductionPercent: "100",
    newLiability: "0",
    settlementPayment: "-800",
  });
  assert.equal(result.gain, "-100.0000");
  assert.equal(result.settlement, "-800.0000");
});
