import assert from "node:assert/strict";
import test from "node:test";
import {
  computePoolYear,
  computeMacrsYear,
  resolvePoolClass,
  TAX_DEPRECIATION_REGIMES,
  type PoolYearInput,
} from "./depreciation-pool.ts";

const run = (over: Partial<PoolYearInput>): ReturnType<typeof computePoolYear> =>
  computePoolYear({ openingBalance: "0", additions: "0", dispositions: "0", rate: 0.2, ...over });

test("ships multiple pooled regimes (not just Canada), all resolvable", () => {
  assert.deepEqual(
    Object.keys(TAX_DEPRECIATION_REGIMES).sort(),
    ["au_pool", "ca_cca", "nz_pool", "uk_wda", "us_macrs"],
  );
  // UK main pool 18% full-year; AU small-business pool 30% at half in year one.
  assert.equal(resolvePoolClass("uk_wda", "main")?.rate, 0.18);
  assert.equal(resolvePoolClass("uk_wda", "main")?.firstYearFraction, 1);
  assert.equal(resolvePoolClass("au_pool", "sbp")?.firstYearFraction, 0.5);
  assert.equal(resolvePoolClass("ca_cca", "10")?.firstYearFraction, 0.5); // half-year rule
});

test("U.S. MACRS 5-year 200% DB half-year schedule switches to straight line", () => {
  const amounts = [2025, 2026, 2027, 2028, 2029, 2030].map((taxYear) =>
    computeMacrsYear({
      basis: "10000", placedInServiceOn: "2025-08-11", taxYear,
      recoveryPeriodYears: 5, method: "200_db", convention: "half_year",
    }).allowance,
  );
  assert.deepEqual(amounts, ["2000.00", "3200.00", "1920.00", "1152.00", "1152.00", "576.00"]);
});

test("U.S. MACRS supports mid-quarter and mid-month conventions", () => {
  assert.equal(computeMacrsYear({
    basis: "10000", placedInServiceOn: "2025-11-15", taxYear: 2025,
    recoveryPeriodYears: 5, method: "200_db", convention: "mid_quarter",
  }).allowance, "500.00");
  assert.equal(computeMacrsYear({
    basis: "10000", placedInServiceOn: "2025-01-10", taxYear: 2025,
    recoveryPeriodYears: 27.5, method: "straight_line", convention: "mid_month",
  }).allowance, "348.48");
});

test("U.S. MACRS applies configured section 179, bonus, and business-use elections", () => {
  const result = computeMacrsYear({
    basis: "10000", placedInServiceOn: "2025-04-01", taxYear: 2025,
    recoveryPeriodYears: 5, method: "200_db", convention: "half_year",
    businessUsePercent: 80, section179: "1000", bonusPercent: 40,
  });
  assert.equal(result.section179, "1000.00");
  assert.equal(result.bonus, "2800.00");
  assert.equal(result.macrs, "840.00");
  assert.equal(result.allowance, "4640.00");
  assert.equal(result.remainingBasis, "3360.00");
});

test("U.S. MACRS remains exact above Number.MAX_SAFE_INTEGER with fractional elections", () => {
  const result = computeMacrsYear({
    basis: "9007199254740993.1234", placedInServiceOn: "2025-04-01", taxYear: 2025,
    recoveryPeriodYears: "5", method: "200_db", convention: "half_year",
    businessUsePercent: "33.3333", section179: "0.0001", bonusPercent: "12.3456",
  });
  assert.deepEqual(result, {
    section179: "0.00",
    bonus: "370663893066837.62",
    macrs: "526346571222748.37",
    allowance: "897010464289585.99",
    remainingBasis: "2105386284890993.47",
  });
});

// The Canada CCA half-year rule is just firstYearFraction 0.5 on a generic pool.
test("first-year fraction (Canada half-year rule) halves year-1 additions", () => {
  const r = run({ additions: "10000", firstYearFraction: 0.5 });
  assert.equal(r.base, "5000.00");
  assert.equal(r.allowance, "1000.00");
  assert.equal(r.closingBalance, "9000.00");
});

test("year 2 depreciates the full opening balance", () => {
  const r = run({ openingBalance: "9000" });
  assert.equal(r.allowance, "1800.00");
  assert.equal(r.closingBalance, "7200.00");
});

test("enhanced first-year multiplier (Canada AII) suspends the fraction and boosts the base", () => {
  const r = run({ additions: "10000", firstYearFraction: 0.5, enhancedFirstYearMultiplier: 1.5 });
  assert.equal(r.base, "15000.00");
  assert.equal(r.allowance, "3000.00");
});

test("full first-year fraction (exempt class) takes the full rate immediately", () => {
  const r = run({ additions: "5000", rate: 1.0, firstYearFraction: 1 });
  assert.equal(r.allowance, "5000.00");
  assert.equal(r.closingBalance, "0.00");
});

test("recapture / balancing charge when disposals exceed the pool", () => {
  const r = run({ openingBalance: "2000", dispositions: "5000" });
  assert.equal(r.recapture, "3000.00");
  assert.equal(r.closingBalance, "0.00");
});

test("terminal loss when the pool empties with value left", () => {
  const r = run({ openingBalance: "3000", poolHasAssetsAtYearEnd: false });
  assert.equal(r.terminalLoss, "3000.00");
});

test("short fiscal year prorates the allowance", () => {
  const r = run({ openingBalance: "10000", rate: 0.3, shortYearFactor: 0.5 });
  assert.equal(r.allowance, "1500.00");
});

test("discretionary claim cap limits the allowance and preserves the balance", () => {
  const r = run({ openingBalance: "10000", claimCap: "500" });
  assert.equal(r.allowance, "500.00");
  assert.equal(r.closingBalance, "9500.00");
});

test("out-of-domain scaling knobs fail closed instead of misstating the allowance", () => {
  const base = { openingBalance: "10000", rate: 0.2 };
  // A short-year factor above 1 used to double the allowance ($4000 for $2000
  // of statutory depreciation); zero/negative silently claimed nothing.
  assert.throws(() => run({ ...base, shortYearFactor: 2 }), /short year factor/);
  assert.throws(() => run({ ...base, shortYearFactor: 0 }), /short year factor/);
  assert.throws(() => run({ ...base, shortYearFactor: -0.5 }), /short year factor/);
  // A first-year fraction above 1 deducted more than the rate allows
  // ($6000 on a $20000 base at 20%); a negative one inflated the base.
  assert.throws(
    () => run({ ...base, additions: "10000", firstYearFraction: 2 }),
    /first year fraction/,
  );
  assert.throws(() => run({ ...base, firstYearFraction: -0.5 }), /first year fraction/);
  // A negative rate silently zeroed the allowance instead of refusing.
  assert.throws(() => run({ ...base, rate: -0.05 }), /rate cannot be negative/);
  // A negative claim cap silently disallowed the whole claim.
  assert.throws(() => run({ ...base, claimCap: "-1" }), /claim cap cannot be negative/);
  // The cap is validated ahead of the early returns: a negative cap on the
  // recapture branch used to return recapture without ever refusing the cap.
  assert.throws(
    () => run({ openingBalance: "2000", dispositions: "5000", claimCap: "-1" }),
    /claim cap cannot be negative/,
  );
  // Boundary values stay legal: full year, half-year rule, zero rate, zero cap.
  assert.equal(run({ ...base, shortYearFactor: 1 }).allowance, "2000.00");
  assert.equal(run({ ...base, shortYearFactor: 0.5 }).allowance, "1000.00");
  assert.equal(run({ ...base, firstYearFraction: 0 }).allowance, "2000.00");
  assert.equal(run({ ...base, rate: 0 }).allowance, "0.00");
  assert.equal(run({ ...base, claimCap: "0" }).allowance, "0.00");
});

test("U.S. MACRS bonus and business-use percents fail closed outside 0..100", () => {
  const base = {
    basis: "10000", placedInServiceOn: "2025-04-01", taxYear: 2025,
    recoveryPeriodYears: 5 as const, method: "200_db" as const, convention: "half_year" as const,
  };
  // A 200% bonus used to deduct twice the basis ($20,000 on $10,000).
  assert.throws(() => computeMacrsYear({ ...base, bonusPercent: 200 }), /bonus percent/);
  assert.throws(() => computeMacrsYear({ ...base, bonusPercent: -10 }), /bonus percent/);
  assert.throws(() => computeMacrsYear({ ...base, businessUsePercent: 150 }), /business use percent/);
  assert.throws(() => computeMacrsYear({ ...base, businessUsePercent: -5 }), /business use percent/);
  // Elections are validated ahead of the date early-returns: a 200% bonus on
  // a pre-placement year used to return zero without refusing the election.
  assert.throws(() => computeMacrsYear({ ...base, taxYear: 2024, bonusPercent: 200 }), /bonus percent/);
  // Boundaries stay legal: full bonus deducts the whole basis, zero business
  // use deducts nothing.
  assert.equal(computeMacrsYear({ ...base, bonusPercent: 100 }).allowance, "10000.00");
  assert.equal(computeMacrsYear({ ...base, businessUsePercent: 0 }).allowance, "0.00");
});

test("regimes that disallow recapture (Canada Class 10.1) just zero the pool", () => {
  const r = run({ openingBalance: "1000", dispositions: "5000", allowRecapture: false });
  assert.equal(r.recapture, "0.00");
  assert.equal(r.closingBalance, "0.00");
});

test("immediate expensing fully deducts before the rate", () => {
  const r = run({ additions: "100000", immediateExpense: "100000", rate: 0.55, firstYearFraction: 0.5 });
  assert.equal(r.immediateExpense, "100000.00");
  assert.equal(r.allowance, "0.00");
  assert.equal(r.closingBalance, "0.00");
});

// The Canada CCA regime is data, driving the same generic engine.
test("Canada CCA is a configured regime, not hardcoded logic", () => {
  const c8 = resolvePoolClass("ca_cca", "8")!;
  assert.equal(c8.rate, 0.2);
  assert.equal(c8.firstYearFraction, 0.5); // half-year rule
  assert.equal(resolvePoolClass("ca_cca", "50")!.rate, 0.55);
  assert.equal(resolvePoolClass("ca_cca", "10.1")!.allowRecapture, false);
  assert.equal(TAX_DEPRECIATION_REGIMES.ca_cca!.name, "Canada — Capital Cost Allowance");

  // Run a real Class 8 year straight from the regime config.
  const r = computePoolYear({
    openingBalance: "0", additions: "10000", dispositions: "0",
    rate: c8.rate, firstYearFraction: c8.firstYearFraction,
  });
  assert.equal(r.allowance, "1000.00");
});
