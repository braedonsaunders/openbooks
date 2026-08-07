import assert from "node:assert/strict";
import test from "node:test";
import { add, cmp, mulPercent, neg, normalizeMoney, sum } from "./money.ts";
import {
  PROTECTION_MAX_PASSES,
  amountForBasis,
  applyBasisCaps,
  applyDeductionProtection,
  assertEarningsAssessedStable,
  assertProtectionIsAfterTax,
  disposableEarnings,
  dropIncomeAssessedLines,
  PayrollLimitError,
  protectedBase,
  protectionConverged,
  protectionNeedsIteration,
  settleProtectionOscillation,
  totalShortfall,
  type DisposableEarningsLine,
  type EarningsAssessedLine,
} from "./payroll-limits.ts";

/* ------------------------------------------------------------------ */
/* Deduction protection                                                */
/* ------------------------------------------------------------------ */

test("Ontario Wages Act: an ordinary garnishment stops at 20% of net wages", () => {
  // $2,000 gross, $500 of statutory withholding → $1,500 of net wages.
  const lines: DisposableEarningsLine[] = [
    { kind: "earning", amount: "2000.00" },
    { kind: "deduction", amount: "400.00" },
    { kind: "deduction", amount: "100.00" },
    { kind: "deduction", amount: "400.00", protectedDeduction: true },
  ];
  const base = protectedBase("net_pay", lines);
  assert.equal(base, "1500.0000");

  const result = applyDeductionProtection(
    [{ key: "GARN", requested: "400.00", maxPercent: "20" }],
    base,
  );
  assert.deepEqual(result.applied, [
    { key: "GARN", requested: "400.0000", amount: "300.0000", cap: "300.0000" },
  ]);
  assert.deepEqual(result.shortfalls, [
    {
      key: "GARN",
      requested: "400.0000",
      applied: "300.0000",
      shortfall: "100.0000",
      reason: "protected_base",
    },
  ]);
});

test("a 50% support order measures on a base its allowance and benefit sit outside", () => {
  // The customer rule: "garnishment max 50% of net pay, BUT coveralls and
  // benefits are NOT included in the 50%" — so take-home ends below 50%.
  const lines: DisposableEarningsLine[] = [
    { kind: "earning", amount: "2000.00" },
    { kind: "earning", amount: "150.00", includeInDisposableEarnings: false },
    { kind: "deduction", amount: "500.00" },
    { kind: "deduction", amount: "100.00", includeInDisposableEarnings: false },
    { kind: "deduction", amount: "1200.00", protectedDeduction: true },
    { kind: "employer_contribution", amount: "80.00", accrualOnly: true },
  ];
  assert.equal(disposableEarnings(lines), "1500.0000");
  // The same lines measured as plain net wages would have offered $50 more.
  assert.equal(protectedBase("net_pay", lines), "1550.0000");
  assert.equal(protectedBase("gross", lines), "2150.0000");

  const base = protectedBase("disposable_earnings", lines);
  const { applied, shortfalls } = applyDeductionProtection(
    [{ key: "SUPPORT", requested: "1200.00", maxPercent: "50" }],
    base,
    { available: "1550.00" },
  );
  assert.equal(applied[0]?.amount, "750.0000");
  assert.equal(shortfalls[0]?.shortfall, "450.0000");

  const net = sum(["2000.00", "150.00", neg("500.00"), neg("100.00"), neg(applied[0]!.amount)]);
  assert.equal(net, "800.0000");
});

test("competing orders draw from one pool in priority order; the rest is a shortfall", () => {
  const base = "1500.00";
  const { applied, shortfalls } = applyDeductionProtection(
    [
      // Deliberately supplied out of order: priority decides, not input order.
      { key: "CREDITOR", requested: "400.00", maxPercent: "50", priority: 2 },
      { key: "SUPPORT", requested: "500.00", maxPercent: "50", priority: 1 },
    ],
    base,
  );
  assert.deepEqual(applied.map((entry) => [entry.key, entry.amount]), [
    ["SUPPORT", "500.0000"],
    ["CREDITOR", "250.0000"],
  ]);
  assert.deepEqual(shortfalls, [
    {
      key: "CREDITOR",
      requested: "400.0000",
      applied: "250.0000",
      shortfall: "150.0000",
      reason: "protected_base",
    },
  ]);
  assert.equal(totalShortfall(shortfalls), "150.0000");
});

test("an order whose own ceiling is already consumed takes nothing at all", () => {
  const { applied, shortfalls } = applyDeductionProtection(
    [
      { key: "SUPPORT", requested: "500.00", maxPercent: "50", priority: 1 },
      { key: "GARN", requested: "400.00", maxPercent: "20", priority: 2 },
    ],
    "1500.00",
  );
  assert.equal(applied[1]?.amount, "0.0000");
  assert.equal(shortfalls[0]?.shortfall, "400.0000");
});

test("each order may carry its own base without breaking the shared pool", () => {
  const { applied } = applyDeductionProtection(
    [
      // Support measured on disposable earnings, creditor on net wages.
      { key: "SUPPORT", requested: "300.00", maxPercent: "50", priority: 1, base: "1500.00" },
      { key: "CREDITOR", requested: "400.00", maxPercent: "20", priority: 2, base: "1550.00" },
    ],
    "1500.00",
  );
  assert.equal(applied[0]?.amount, "300.0000");
  // 20% of 1,550 = 310, less the 300 the support order already took.
  assert.equal(applied[1]?.cap, "310.0000");
  assert.equal(applied[1]?.amount, "10.0000");
});

test("protection never produces negative net pay", () => {
  const { applied, shortfalls } = applyDeductionProtection(
    [{ key: "GARN", requested: "250.00", maxPercent: "25" }],
    "1000.00",
    { available: "100.00" },
  );
  assert.equal(applied[0]?.amount, "100.0000");
  assert.equal(shortfalls[0]?.reason, "insufficient_pay");
  assert.equal(add("100.00", neg(applied[0]!.amount)), "0.0000");
});

test("a cap landing on a half-cent rounds to the employee, not the creditor", () => {
  // 50% of 1,000.01 = 500.005 exactly.
  const half = applyDeductionProtection(
    [{ key: "GARN", requested: "600.00", maxPercent: "50" }],
    "1000.01",
  );
  assert.equal(half.applied[0]?.cap, "500.0000");
  assert.equal(half.shortfalls[0]?.shortfall, "100.0000");

  // 20% of 999.99 = 199.998 — the sub-cent tail is truncated, never rounded up.
  const tail = applyDeductionProtection(
    [{ key: "GARN", requested: "500.00", maxPercent: "20" }],
    "999.99",
  );
  assert.equal(tail.applied[0]?.cap, "199.9900");
});

test("disposable earnings never go negative and ignore employer accruals", () => {
  assert.equal(disposableEarnings([
    { kind: "earning", amount: "500.00" },
    { kind: "deduction", amount: "900.00" },
    { kind: "employer_contribution", amount: "60.00" },
  ]), "0.0000");
});

test("a protected deduction is excluded from the base it is measured against", () => {
  const lines: DisposableEarningsLine[] = [
    { kind: "earning", amount: "1000.00" },
    { kind: "deduction", amount: "200.00", protectedDeduction: true },
  ];
  assert.equal(disposableEarnings(lines), "1000.0000");
  assert.equal(disposableEarnings(lines, { excludeProtectedDeductions: false }), "800.0000");
});

test("protection refuses a percentage outside 0–100 and a pre-tax deduction", () => {
  assert.throws(
    () => applyDeductionProtection([{ key: "GARN", requested: "1", maxPercent: "120" }], "100"),
    /between 0 and 100/,
  );
  assert.doesNotThrow(() => assertProtectionIsAfterTax([{ key: "GARN", taxTreatment: "none" }]));
  assert.throws(
    () => assertProtectionIsAfterTax([{ key: "SUPPORT", taxTreatment: "alimony" }]),
    /pre-tax/,
  );
});

/* ------------------------------------------------------------------ */
/* Basis caps                                                          */
/* ------------------------------------------------------------------ */

test("RRSP computes on 40 hours a week, and job-charged overtime is exempt", () => {
  const component = {
    basis: "percent_of_gross" as const,
    value: "5",
    basisCapHoursPerPeriod: "40",
  };
  const lines = [
    { hours: "44", amount: "1320.00" },
    // Double time charged to a job: outside the cap, and it never consumes it.
    { hours: "8", amount: "360.00", exemptFromHoursCap: true },
  ];
  assert.equal(amountForBasis(component, "1680.00"), "84.0000");

  const capped = applyBasisCaps(component, "1680.00", { lines });
  // The four capped hours drop at their own line's rate: 1,320 × 4/44 = 120.
  assert.equal(capped, "1560.0000");
  assert.equal(amountForBasis(component, capped), "78.0000");
});

test("an hours cap on a per-hour component caps the hours themselves", () => {
  const component = {
    basis: "per_hour" as const,
    value: "2.00",
    basisCapHoursPerPeriod: "40",
  };
  const lines = [{ hours: "44" }, { hours: "8", exemptFromHoursCap: true }];
  const capped = applyBasisCaps(component, "52", { lines });
  assert.equal(capped, "48.0000");
  assert.equal(amountForBasis(component, capped), "96.0000");
});

test("an hours-capped component without its hours is a configuration error", () => {
  assert.throws(
    () => applyBasisCaps(
      { basis: "percent_of_gross", value: "5", basisCapHoursPerPeriod: "40" },
      "1000.00",
    ),
    /hours behind its basis/,
  );
});

test("an annual cap binds mid-year and stops the component dead once consumed", () => {
  const component = {
    basis: "percent_of_gross" as const,
    value: "10",
    basisCapAmountPerYear: "23000.00",
  };
  // $22,800 already deferred: $200 of room = $2,000 of basis at 10%.
  const capped = applyBasisCaps(component, "5000.00", { yearToDate: "22800.00" });
  assert.equal(capped, "2000.0000");
  assert.equal(amountForBasis(component, capped), "200.0000");

  assert.equal(applyBasisCaps(component, "5000.00", { yearToDate: "23000.00" }), "0.0000");
  assert.equal(applyBasisCaps(component, "5000.00", { yearToDate: "40000.00" }), "0.0000");
  assert.equal(applyBasisCaps(component, "5000.00", {}), "5000.0000");
});

test("the tighter of the period and annual caps wins", () => {
  const component = {
    basis: "percent_of_gross" as const,
    value: "10",
    basisCapAmountPerPeriod: "150.00",
    basisCapAmountPerYear: "23000.00",
  };
  const capped = applyBasisCaps(component, "5000.00", {
    periodToDate: "0",
    yearToDate: "22800.00",
  });
  assert.equal(capped, "1500.0000");
  assert.equal(amountForBasis(component, capped), "150.0000");
});

test("a fixed-amount component is capped directly by its money caps", () => {
  const component = {
    basis: "fixed_amount" as const,
    value: null,
    basisCapAmountPerYear: "500.00",
  };
  assert.equal(applyBasisCaps(component, "200.00", { yearToDate: "400.00" }), "100.0000");
});

test("a money cap converts to basis room without ever rounding past the cap", () => {
  const component = { basis: "percent_of_gross" as const, value: "3", basisCapAmountPerPeriod: "100.00" };
  const capped = applyBasisCaps(component, "9999.00");
  // 100 / 3% = 3,333.3333… — floored, so the amount lands exactly on the cap.
  assert.equal(capped, "3333.3333");
  assert.equal(amountForBasis(component, capped), "100.0000");

  // A cap with a sub-cent tail is truncated before the conversion, so the
  // amount can never round up through the ceiling.
  const odd = { basis: "percent_of_gross" as const, value: "3", basisCapAmountPerPeriod: "100.0099" };
  assert.equal(amountForBasis(odd, applyBasisCaps(odd, "9999.00")), "100.0000");
});

test("hours and money caps compose on one component", () => {
  const component = {
    basis: "percent_of_gross" as const,
    value: "5",
    basisCapHoursPerPeriod: "40",
    basisCapAmountPerPeriod: "70.00",
  };
  const lines = [{ hours: "44", amount: "1320.00" }, { hours: "8", amount: "360.00", exemptFromHoursCap: true }];
  // Hours cap → 1,560 of basis (78.00); the $70 period cap then binds first.
  assert.equal(applyBasisCaps(component, "1680.00", { lines }), "1400.0000");
  assert.equal(amountForBasis(component, "1400.0000"), "70.0000");
});

/* ------------------------------------------------------------------ */
/* Pre-tax protected orders — the statutory ⇄ protection fixed point    */
/* ------------------------------------------------------------------ */

/**
 * A stand-in for the statutory pass, driven exactly as `calculateStub` drives
 * the real one: the support order is pre-tax, so the tax the pool is measured
 * net of depends on the amount the previous pass settled on. Mirrors the loop
 * in .local/handoff-limits.md so the decision helpers are proven on the shape
 * the pipeline actually uses.
 */
function runToFixpoint(input: {
  gross: string
  requested: string
  percent: string
  /** Income tax on the pay left after the pre-tax order. */
  tax: (taxable: string) => string
  maxPasses?: number
}): { amount: string; passes: number; settled: boolean; cap: string } | { failed: true } {
  const maxPasses = input.maxPasses ?? PROTECTION_MAX_PASSES;
  const pass = (amount: string) => {
    const tax = input.tax(add(input.gross, neg(amount)));
    const lines: DisposableEarningsLine[] = [
      { kind: "earning", amount: input.gross },
      { kind: "deduction", amount: tax },
      { kind: "deduction", amount, protectedDeduction: true },
    ];
    return applyDeductionProtection(
      [{ key: "SUPPORT", requested: input.requested, maxPercent: input.percent }],
      protectedBase("net_pay", lines),
      { available: add(input.gross, neg(tax)) },
    );
  };

  let previous = [{ key: "SUPPORT", amount: normalizeMoney(input.requested) }];
  for (let n = 1; n <= maxPasses; n++) {
    const result = pass(previous[0]!.amount);
    const current = result.applied.map(({ key, amount }) => ({ key, amount }));
    if (protectionConverged(previous, current)) {
      return { amount: current[0]!.amount, passes: n, settled: false, cap: result.applied[0]!.cap };
    }
    if (n === maxPasses) {
      const settled = settleProtectionOscillation(previous, current);
      if (!settled) return { failed: true };
      // The stub's tax must come from what is actually deducted, so the
      // settled amount gets one final statutory pass of its own.
      const final = pass(settled[0]!.amount);
      return { amount: settled[0]!.amount, passes: n, settled: true, cap: final.applied[0]!.cap };
    }
    previous = current;
  }
  throw new Error("unreachable");
}

/** Flat-rate stand-in for T4127, rounded to the cent like the real engine. */
const flatTax = (rate: string) => (taxable: string) => mulPercent(taxable, rate, 2);

test("the fast path is only for after-tax orders; a factor-F2 order iterates", () => {
  assert.equal(protectionNeedsIteration([{ taxTreatment: "none" }, {}]), false);
  assert.equal(protectionNeedsIteration([{ taxTreatment: "none" }, { taxTreatment: "alimony" }]), true);
  assert.equal(protectionNeedsIteration([{ taxTreatment: "pension_f" }]), true);
});

test("convergence is exact equality between the pass input and its output", () => {
  const a = [{ key: "SUPPORT", amount: "1235.2900" }];
  assert.equal(protectionConverged(a, [{ key: "SUPPORT", amount: "1235.29" }]), true);
  assert.equal(protectionConverged(a, [{ key: "SUPPORT", amount: "1235.30" }]), false);
  assert.equal(protectionConverged(a, [{ key: "OTHER", amount: "1235.29" }]), false);
  assert.equal(protectionConverged(a, []), false);
});

test("a one-cent gap settles on the lower amount; a wider gap does not settle", () => {
  assert.deepEqual(
    settleProtectionOscillation(
      [{ key: "SUPPORT", amount: "1235.30" }],
      [{ key: "SUPPORT", amount: "1235.29" }],
    ),
    [{ key: "SUPPORT", amount: "1235.2900" }],
  );
  // Order of the pair does not matter: the employee-favouring value wins.
  assert.deepEqual(
    settleProtectionOscillation(
      [{ key: "SUPPORT", amount: "1235.29" }],
      [{ key: "SUPPORT", amount: "1235.30" }],
    ),
    [{ key: "SUPPORT", amount: "1235.2900" }],
  );
  assert.equal(
    settleProtectionOscillation(
      [{ key: "SUPPORT", amount: "1235.30" }],
      [{ key: "SUPPORT", amount: "1235.28" }],
    ),
    null,
  );
});

test("a pre-tax support order converges in two passes when the cap is already close", () => {
  // $3,000 gross, flat 30% tax on pay after the order, 50% of net wages.
  // Pass 1: tax on 1,764.69 = 529.41 → net 2,470.59 → cap 1,235.29.
  // Pass 2: the same input reproduces the same cap → fixed point.
  const result = runToFixpoint({
    gross: "3000.00", requested: "1235.31", percent: "50", tax: flatTax("30"),
  });
  assert.ok(!("failed" in result));
  assert.equal(result.passes, 2);
  assert.equal(result.settled, false);
  assert.equal(result.amount, "1235.2900");
  // Self-consistency: the cap recomputed from the final deduction is the
  // deduction. The withholdings on the stub came from exactly this number.
  assert.equal(result.cap, result.amount);
});

test("a pre-tax support order well above the cap still converges inside the bound", () => {
  const result = runToFixpoint({
    gross: "3000.00", requested: "1500.00", percent: "50", tax: flatTax("30"),
  });
  assert.ok(!("failed" in result));
  assert.ok(result.passes > 2, "this one takes several passes to settle");
  assert.ok(result.passes <= PROTECTION_MAX_PASSES);
  assert.equal(result.settled, false);
  assert.equal(result.amount, "1235.2900");
  assert.equal(result.cap, result.amount);
  // The employee keeps the rest, and the unpaid balance is still owed.
  assert.equal(add("1500.00", neg(result.amount)), "264.7100");
});

test("a one-cent rounding cycle settles on the lower amount, not the higher", () => {
  // A statutory table whose cent-level rounding flips either side of one
  // input: 1,764.70 of taxable pay is taxed a cent harder than 1,764.71, so
  // the cap alternates 1,235.29 ⇄ 1,235.30 and never settles exactly.
  const oscillating = (taxable: string) => (cmp(taxable, "1764.705") > 0 ? "529.40" : "529.42");
  const result = runToFixpoint({
    gross: "3000.00", requested: "1300.00", percent: "50", tax: oscillating,
  });
  assert.ok(!("failed" in result));
  assert.equal(result.settled, true);
  assert.equal(result.passes, PROTECTION_MAX_PASSES);
  assert.equal(result.amount, "1235.2900");
  // The bias is explicit: the settled deduction is at or below the cap its own
  // final statutory pass produces, so the employee is never over-deducted.
  assert.ok(cmp(result.amount, result.cap) <= 0);
});

test("a swing wider than a cent is a real failure to converge, never a number", () => {
  // Two caps a dollar apart: no rounding artifact can explain this, so the
  // loop must refuse rather than return whichever pass it stopped on.
  const unstable = (taxable: string) => (cmp(taxable, "1750.00") > 0 ? "500.00" : "600.00");
  const result = runToFixpoint({
    gross: "3000.00", requested: "1300.00", percent: "50", tax: unstable,
  });
  assert.deepEqual(result, { failed: true });
});

/* ------------------------------------------------------------------ */
/* Statutory line classes: what a protection pass may re-derive        */
/* ------------------------------------------------------------------ */

// A line as the pass sees it. The CLASS comes from the country pack
// (engine/src/payroll/packs.ts) — see packs.test.ts for the declaration
// itself; these cases are about what the pipeline may do with it.
type PassLine = EarningsAssessedLine & { assessedOn: "earnings" | "taxable_income" };

const wcbSplit: PassLine[] = [
  { component: "WCB/WSIB", amount: "18.00", projectId: "job-a", assessedOn: "earnings" },
  { component: "WCB/WSIB", amount: "12.01", projectId: "job-b", assessedOn: "earnings" },
];
const firstPass = (): PassLine[] => [
  ...wcbSplit.map((line) => ({ ...line })),
  { component: "CPP", amount: "142.66", assessedOn: "earnings" },
  { component: "EI", amount: "38.40", assessedOn: "earnings" },
  { component: "Income tax", amount: "310.55", assessedOn: "taxable_income" },
];

test("a protection pass drops the income-assessed lines and only those", () => {
  const lines = firstPass();
  dropIncomeAssessedLines(lines);
  assert.deepEqual(lines.map((l) => l.component), ["WCB/WSIB", "WCB/WSIB", "CPP", "EI"]);
  // The premium's job split survives intact — re-running the allocation would
  // hand the last job the rounding remainder a second time.
  assert.deepEqual(lines.slice(0, 2).map((l) => l.amount), ["18.00", "12.01"]);
});

test("the invariant accepts earnings-assessed lines that stood still while tax moved", () => {
  const first = firstPass();
  const lines = firstPass();
  // Pass 2: a smaller pre-tax support order leaves more taxable income, so the
  // income-assessed line is dropped and re-derived higher. Nothing else moves.
  dropIncomeAssessedLines(lines);
  lines.push({ component: "Income tax", amount: "347.12", assessedOn: "taxable_income" });
  assert.equal(
    lines.find((l) => l.component === "Income tax")!.amount,
    "347.12",
  );
  assertEarningsAssessedStable(
    "Terry Worker",
    first.filter((l) => l.assessedOn === "earnings"),
    lines.filter((l) => l.assessedOn === "earnings"),
  );
});

test("an earnings-assessed line that moved between passes fails loudly", () => {
  const first = firstPass().filter((l) => l.assessedOn === "earnings");
  const final = first.map((l) => (l.component === "CPP" ? { ...l, amount: "140.11" } : l));
  assert.throws(
    () => assertEarningsAssessedStable("Terry Worker", first, final),
    (error: Error) => {
      assert.ok(error instanceof PayrollLimitError);
      // The error has to name the employee AND the component: an operator
      // reading it must know whose stub and which levy.
      assert.match(error.message, /Terry Worker/);
      assert.match(error.message, /CPP/);
      assert.match(error.message, /142\.6600 to 140\.1100/);
      assert.match(error.message, /taxable_income/);
      return true;
    },
  );
});

test("a job split re-allocated by a second pass is caught", () => {
  // The failure the idempotent push exists to prevent: WCB allocated again,
  // so the premium is on the stub twice.
  const first = firstPass().filter((l) => l.assessedOn === "earnings");
  const final = [...first, ...wcbSplit.map((line) => ({ ...line }))];
  assert.throws(
    () => assertEarningsAssessedStable("Terry Worker", first, final),
    /WCB\/WSIB for Terry Worker appeared only after the first pass/,
  );
});

test("a premium that changed jobs between passes is caught", () => {
  const first = firstPass().filter((l) => l.assessedOn === "earnings");
  const final = first.map((l) => (l.projectId === "job-b" ? { ...l, projectId: "job-c" } : l));
  assert.throws(
    () => assertEarningsAssessedStable("Terry Worker", first, final),
    /moved from job-b\/no department to job-c\/no department/,
  );
});

test("an earnings-assessed line dropped by a later pass is caught", () => {
  const first = firstPass().filter((l) => l.assessedOn === "earnings");
  assert.throws(
    () => assertEarningsAssessedStable("Terry Worker", first, first.slice(0, 3)),
    /EI for Terry Worker disappeared/,
  );
});
