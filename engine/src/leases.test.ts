import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "./money.ts";
import {
  assertLeaseTimingSupported,
  classifyLease,
  classifyLessorLease,
  LeaseError,
  lessorStraightLineSchedule,
  measureLesseeLease,
  salesTypeCommencement,
  shortTermExemptionEligible,
} from "./leases.ts";
import { periodRateFromAnnualPercent, presentValueOfLevelStream } from "./present-value.ts";

// The worked example used throughout: five annual payments of 20,000 in
// arrears at 5%. Annuity factor 4.3294766708… → liability 86,589.5334.

test("lease liability is the exact present value of the payments (842-20-30-1 / IFRS 16.26)", () => {
  const pv = presentValueOfLevelStream({
    payment: "20000",
    periods: 5,
    rate: periodRateFromAnnualPercent("5", 1),
    timing: "arrears",
  });
  assert.equal(pv, "86589.5334");
});

test("advance timing discounts one fewer period", () => {
  const pv = presentValueOfLevelStream({
    payment: "20000",
    periods: 5,
    rate: periodRateFromAnnualPercent("5", 1),
    timing: "advance",
  });
  // arrears PV × 1.05 = 90,919.0101
  assert.equal(pv, "90919.0101");
});

test("advance timing is refused at creation, not deferred to commencement", () => {
  // createLeaseAgreement calls this pure seam before inserting the draft: an
  // agreement that measureLesseeLease could never commence must fail
  // validation up front. The measurement guard remains as defense in depth.
  assert.throws(
    () => assertLeaseTimingSupported("advance"),
    (e) => e instanceof LeaseError && /advance-timing/.test(e.message),
  );
  assert.doesNotThrow(() => assertLeaseTimingSupported("arrears"));
});

test("a zero rate degenerates to the undiscounted sum", () => {
  const pv = presentValueOfLevelStream({
    payment: "1000",
    periods: 12,
    rate: periodRateFromAnnualPercent("0", 12),
    timing: "arrears",
  });
  assert.equal(pv, "12000.0000");
});

test("finance schedule: interest method, straight-line amortization, retires to exactly zero", () => {
  const m = measureLesseeLease({
    payment: "20000",
    periods: 5,
    annualRatePercent: "5",
    periodsPerYear: 1,
    timing: "arrears",
    model: "finance",
  });
  assert.equal(m.liability, "86589.5334");
  assert.equal(m.rouAsset, "86589.5334");
  const y1 = m.schedule[0]!;
  assert.equal(y1.interest, "4329.4767"); // 86,589.5334 × 5%
  assert.equal(y1.closing, "70919.0101"); // 86,589.5334 − 15,670.5233
  assert.equal(y1.amortization, "17317.9067");
  // The liability retires to zero and amortization consumes the asset exactly.
  assert.equal(m.schedule[4]!.closing, "0.0000");
  const amortSum = m.schedule.reduce((a, l) => a + toUnits(l.amortization!), 0n);
  assert.equal(amortSum, toUnits(m.rouAsset));
  const interestSum = m.schedule.reduce((a, l) => a + toUnits(l.interest), 0n);
  const principalSum = m.schedule.reduce((a, l) => a + toUnits(l.payment) - toUnits(l.interest), 0n);
  assert.equal(interestSum + principalSum, toUnits("100000"));
  assert.equal(principalSum, toUnits(m.liability));
});

test("operating schedule: level single cost, liability unwind, ROU stays aligned (842-20-25-6)", () => {
  const m = measureLesseeLease({
    payment: "20000",
    periods: 5,
    annualRatePercent: "5",
    periodsPerYear: 1,
    timing: "arrears",
    model: "operating",
  });
  const y1 = m.schedule[0]!;
  assert.equal(y1.singleCost, "20000.0000");
  assert.equal(y1.interest, "4329.4767");
  assert.equal(y1.rouAdjustment, "15670.5233"); // cost − interest = principal here
  const adjSum = m.schedule.reduce((a, l) => a + toUnits(l.rouAdjustment!), 0n);
  assert.equal(adjSum, toUnits(m.rouAsset));
  // Total cost = total cash, level in every period.
  for (const line of m.schedule) assert.equal(line.singleCost, "20000.0000");
});

test("IFRS applies the single lessee model regardless of the criteria (IFRS 16.22)", () => {
  const c = classifyLease({}, "ifrs");
  assert.equal(c.model, "finance");
  const us = classifyLease({}, "us_gaap");
  assert.equal(us.model, "operating"); // no criterion met
});

test("US GAAP classification criteria (842-10-25-2)", () => {
  assert.equal(classifyLease({ transfersOwnership: true }, "us_gaap").model, "finance");
  assert.equal(classifyLease({ purchaseOptionReasonablyCertain: true }, "us_gaap").model, "finance");
  assert.equal(
    classifyLease({ leaseTermMonths: 60, economicLifeMonths: 72 }, "us_gaap").model,
    "finance", // 83% ≥ 75%
  );
  assert.equal(
    classifyLease({ leaseTermMonths: 36, economicLifeMonths: 120 }, "us_gaap").model,
    "operating", // 30%
  );
  assert.equal(
    classifyLease({ pvOfPayments: "91000", fairValue: "100000" }, "us_gaap").model,
    "finance", // 91% ≥ 90%
  );
  assert.equal(
    classifyLease({ pvOfPayments: "86589.5334", fairValue: "100000" }, "us_gaap").model,
    "operating", // 86.6%
  );
  assert.equal(classifyLease({ specializedAsset: true }, "us_gaap").model, "finance");
  // Thresholds are policy inputs, not hardcodes.
  assert.equal(
    classifyLease(
      { pvOfPayments: "86589.5334", fairValue: "100000", pvThresholdPercent: "85" },
      "us_gaap",
    ).model,
    "finance",
  );
});

test("short-term exemption eligibility (842-20-25-2 / IFRS 16.5)", () => {
  assert.equal(shortTermExemptionEligible({ leaseTermMonths: 9 }), true);
  assert.equal(shortTermExemptionEligible({ leaseTermMonths: 12 }), true);
  assert.equal(shortTermExemptionEligible({ leaseTermMonths: 13 }), false);
  assert.equal(
    shortTermExemptionEligible({ leaseTermMonths: 9, purchaseOptionReasonablyCertain: true }),
    false,
  );
});

test("lessor straight-line levelling returns to exactly zero (IFRS 16.81)", () => {
  const schedule = lessorStraightLineSchedule(["10000", "11000", "12000", "13000", "14000"]);
  assert.equal(schedule[0]!.income, "12000.0000");
  assert.equal(schedule[0]!.accrualDelta, "2000.0000");
  assert.equal(schedule[4]!.accrualDelta, "-2000.0000");
  assert.equal(schedule[4]!.cumulativeAccrual, "0.0000");
});

test("lessor classification mirrors the transfer-of-risks criteria", () => {
  assert.equal(classifyLessorLease({ transfersOwnership: true }).classification, "sales_type");
  assert.equal(classifyLessorLease({}).classification, "operating");
});

test("sales-type commencement derecognises the asset and takes selling profit (842-30-25-1)", () => {
  const { sellingProfit, lines } = salesTypeCommencement({
    netInvestment: "90000",
    carryingAmount: "75000",
    accounts: {
      netInvestmentAccountId: "ni",
      assetAccountId: "asset",
      sellingProfitAccountId: "profit",
    },
  });
  assert.equal(sellingProfit, "15000.0000");
  const total = lines.reduce((a, l) => a + toUnits(l.amount), 0n);
  assert.equal(total, 0n);
});

test("monthly compounding uses the exact annual/12 rational, not a truncated decimal", () => {
  // 12 monthly payments of 1,000 at 6% annual (0.5%/month exact).
  const pv = presentValueOfLevelStream({
    payment: "1000",
    periods: 12,
    rate: periodRateFromAnnualPercent("6", 12),
    timing: "arrears",
  });
  // Annuity factor (1 − 1.005^−12)/0.005 = 11.6189321… → 11,618.9321
  assert.equal(pv, "11618.9321");
  // A rate that does NOT divide evenly in decimal (5%/12) still measures and
  // retires exactly — the rational carries it without truncation.
  const m = measureLesseeLease({
    payment: "500",
    periods: 24,
    annualRatePercent: "5",
    periodsPerYear: 12,
    timing: "arrears",
    model: "finance",
  });
  assert.equal(m.schedule[23]!.closing, "0.0000");
});
