import assert from "node:assert/strict";
import test from "node:test";
import { fromUnits, toUnits } from "../money/money.ts";
import { AmortizationError } from "./errors.ts";
import {
  allocateRemainderToLast,
  buildAmortizationPlan,
  planQuantum,
  reforecastAmortizationPlan,
  resolveAmortizationTerm,
  termWeights,
  validateAmortizationPolicy,
  type AmortizationPolicy,
} from "./plan.ts";

const CENT = planQuantum(toUnits("1.00"), 2);

function policy(overrides: Partial<AmortizationPolicy> = {}): AmortizationPolicy {
  return {
    method: "straight_line",
    termSource: "template",
    periodCount: 12,
    percentages: null,
    periodOffset: 0,
    ...overrides,
  };
}

function plan(
  p: AmortizationPolicy,
  amount: string,
  term: { serviceStartOn?: string | null; serviceEndOn?: string | null; transactionDate?: string },
) {
  const resolved = resolveAmortizationTerm(p, {
    serviceStartOn: term.serviceStartOn ?? null,
    serviceEndOn: term.serviceEndOn ?? null,
    transactionDate: term.transactionDate ?? "2026-01-10",
  });
  const total = toUnits(amount);
  return buildAmortizationPlan(p, resolved, total, planQuantum(total, 2)).map((line) => ({
    period: line.periodStart.slice(0, 7),
    amount: fromUnits(line.amount),
  }));
}

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof AmortizationError,
      `expected AmortizationError, got ${String(error)}`,
    );
    return error.code;
  }
  assert.fail("expected a refusal");
}

test("straight-line by period splits evenly and puts the rounding remainder in the last period", () => {
  const lines = plan(policy({ periodCount: 3 }), "1000.00", { transactionDate: "2026-01-20" });
  assert.deepEqual(lines, [
    { period: "2026-01", amount: "333.3300" },
    { period: "2026-02", amount: "333.3300" },
    { period: "2026-03", amount: "333.3400" },
  ]);
});

test("a template term starts on the service start when the line carries one", () => {
  const lines = plan(policy({ periodCount: 2 }), "50.00", {
    serviceStartOn: "2026-05-31",
    transactionDate: "2026-01-02",
  });
  assert.deepEqual(
    lines.map((l) => l.period),
    ["2026-05", "2026-06"],
  );
});

test("exact days weighs each month by the service days it holds", () => {
  // 15 Jan – 14 Mar 2026: 17 + 28 + 14 = 59 days.
  const lines = plan(
    policy({ method: "exact_days", termSource: "service_dates", periodCount: null }),
    "590.00",
    {
      serviceStartOn: "2026-01-15",
      serviceEndOn: "2026-03-14",
    },
  );
  assert.deepEqual(lines, [
    { period: "2026-01", amount: "170.0000" },
    { period: "2026-02", amount: "280.0000" },
    { period: "2026-03", amount: "140.0000" },
  ]);
});

test("prorated first and last periods weigh partial months by their share of the month", () => {
  // Half of a 30-day April, all of May, half of a 30-day June: weights ½, 1, ½.
  const lines = plan(
    policy({ method: "prorated_first_last", termSource: "service_dates", periodCount: null }),
    "400.00",
    {
      serviceStartOn: "2026-04-16",
      serviceEndOn: "2026-06-15",
    },
  );
  assert.deepEqual(lines, [
    { period: "2026-04", amount: "100.0000" },
    { period: "2026-05", amount: "200.0000" },
    { period: "2026-06", amount: "100.0000" },
  ]);
});

test("a day-based template term runs the anniversary window", () => {
  const term = resolveAmortizationTerm(policy({ method: "exact_days", periodCount: 12 }), {
    serviceStartOn: "2026-01-15",
    serviceEndOn: null,
    transactionDate: "2026-01-15",
  });
  assert.equal(term.endOn, "2027-01-14");
  assert.equal(term.periodCount, 13);
  const weights = termWeights(policy({ method: "exact_days", periodCount: 12 }), term);
  assert.equal(
    weights.reduce((a, b) => a + b, 0n),
    365n,
  );
});

test("a variable table allocates by its percentages", () => {
  const lines = plan(
    policy({ method: "variable", periodCount: 3, percentages: ["25", "25", "50"] }),
    "1000.00",
    {
      transactionDate: "2026-02-03",
    },
  );
  assert.deepEqual(lines, [
    { period: "2026-02", amount: "250.0000" },
    { period: "2026-03", amount: "250.0000" },
    { period: "2026-04", amount: "500.0000" },
  ]);
});

test("the period offset delays the first amortization period", () => {
  const lines = plan(policy({ periodCount: 2, periodOffset: 3 }), "20.00", {
    transactionDate: "2026-11-05",
  });
  assert.deepEqual(
    lines.map((l) => l.period),
    ["2027-02", "2027-03"],
  );
});

test("every plan sums exactly to its amount and never goes negative", () => {
  const methods: AmortizationPolicy[] = [
    policy({ periodCount: 7 }),
    policy({ method: "exact_days", termSource: "service_dates", periodCount: null }),
    policy({ method: "prorated_first_last", termSource: "service_dates", periodCount: null }),
    policy({
      method: "variable",
      periodCount: 3,
      percentages: ["33.333333", "33.333333", "33.333334"],
    }),
  ];
  const amounts = ["0.01", "0.07", "1.00", "999.99", "123456.78", "7.1234"];
  for (const p of methods) {
    for (const amount of amounts) {
      const resolved = resolveAmortizationTerm(p, {
        serviceStartOn: "2026-01-31",
        serviceEndOn: "2026-03-01",
        transactionDate: "2026-01-31",
      });
      const total = toUnits(amount);
      const lines = buildAmortizationPlan(p, resolved, total, planQuantum(total, 2));
      assert.equal(
        lines.reduce((acc, l) => acc + l.amount, 0n),
        total,
        `${p.method} ${amount}`,
      );
      assert.ok(
        lines.every((l) => l.amount >= 0n),
        `${p.method} ${amount} has a negative period`,
      );
      // Deterministic: the same inputs reproduce the same plan.
      assert.deepEqual(buildAmortizationPlan(p, resolved, total, planQuantum(total, 2)), lines);
    }
  }
});

test("a sub-cent amount allocates in ledger units instead of inventing cents", () => {
  assert.equal(planQuantum(toUnits("7.1234"), 2), 1n);
  assert.equal(planQuantum(toUnits("7.12"), 2), CENT);
  assert.equal(planQuantum(toUnits("7"), 0), 10_000n);
});

test("refusals name the missing or inconsistent configuration", () => {
  assert.equal(
    refusalCode(() =>
      resolveAmortizationTerm(policy({ termSource: "service_dates", periodCount: null }), {
        serviceStartOn: "2026-01-01",
        serviceEndOn: null,
        transactionDate: "2026-01-01",
      }),
    ),
    "amortization_service_dates_missing",
  );
  assert.equal(
    refusalCode(() =>
      resolveAmortizationTerm(policy({ termSource: "service_dates", periodCount: null }), {
        serviceStartOn: "2026-03-01",
        serviceEndOn: "2026-02-01",
        transactionDate: "2026-01-01",
      }),
    ),
    "amortization_service_dates_inverted",
  );
  assert.equal(
    refusalCode(() =>
      validateAmortizationPolicy(
        policy({ method: "variable", periodCount: 2, percentages: ["50", "49.999999"] }),
      ),
    ),
    "amortization_percentages_total",
  );
  assert.equal(
    refusalCode(() =>
      validateAmortizationPolicy(
        policy({ method: "variable", periodCount: 3, percentages: ["50", "50"] }),
      ),
    ),
    "amortization_percentages_count",
  );
  assert.equal(
    refusalCode(() =>
      validateAmortizationPolicy(
        policy({
          method: "variable",
          termSource: "service_dates",
          periodCount: 2,
          percentages: ["50", "50"],
        }),
      ),
    ),
    "amortization_variable_term",
  );
  assert.equal(
    refusalCode(() => validateAmortizationPolicy(policy({ periodCount: null }))),
    "amortization_period_count_invalid",
  );
  assert.equal(
    refusalCode(() => validateAmortizationPolicy(policy({ periodCount: 601 }))),
    "amortization_period_count_invalid",
  );
  assert.equal(
    refusalCode(() => validateAmortizationPolicy(policy({ periodOffset: -1 }))),
    "amortization_offset_invalid",
  );
  assert.equal(
    refusalCode(() => validateAmortizationPolicy(policy({ percentages: ["100"] }))),
    "amortization_percentages_unexpected",
  );
  assert.equal(
    refusalCode(() => allocateRemainderToLast(100n, [0n, 0n], 1n)),
    "amortization_zero_weights",
  );
});

test("a re-forecast keeps the remaining method weights and sums to the remaining balance", () => {
  const current = [
    { periodStart: "2026-01-01", weight: 31n },
    { periodStart: "2026-02-01", weight: 28n },
    { periodStart: "2026-03-01", weight: 31n },
  ];
  const lines = reforecastAmortizationPlan({
    policy: policy({ method: "exact_days", termSource: "service_dates", periodCount: null }),
    currentPlan: current,
    remaining: toUnits("590.00"),
    fromPeriod: "2026-02-01",
    quantum: CENT,
  });
  assert.deepEqual(
    lines.map((l) => [l.periodStart, fromUnits(l.amount)]),
    [
      ["2026-02-01", "280.0000"],
      ["2026-03-01", "310.0000"],
    ],
  );
});

test("a term change spreads the balance evenly over the new remaining periods", () => {
  const lines = reforecastAmortizationPlan({
    policy: policy(),
    currentPlan: [],
    remaining: toUnits("100.00"),
    fromPeriod: "2026-06-15",
    newLastPeriod: "2026-08-01",
    quantum: CENT,
  });
  assert.deepEqual(
    lines.map((l) => [l.periodStart, fromUnits(l.amount)]),
    [
      ["2026-06-01", "33.3300"],
      ["2026-07-01", "33.3300"],
      ["2026-08-01", "33.3400"],
    ],
  );
  assert.equal(
    refusalCode(() =>
      reforecastAmortizationPlan({
        policy: policy({ method: "variable", periodCount: 2, percentages: ["50", "50"] }),
        currentPlan: [],
        remaining: 1n,
        fromPeriod: "2026-06-01",
        newLastPeriod: "2026-09-01",
        quantum: CENT,
      }),
    ),
    "amortization_variable_term_change",
  );
  assert.equal(
    refusalCode(() =>
      reforecastAmortizationPlan({
        policy: policy(),
        currentPlan: [],
        remaining: 1n,
        fromPeriod: "2026-06-01",
        newLastPeriod: "2026-05-01",
        quantum: CENT,
      }),
    ),
    "amortization_term_change_inverted",
  );
});

test("a re-forecast past the end of the plan lands the balance in the change period", () => {
  const lines = reforecastAmortizationPlan({
    policy: policy(),
    currentPlan: [{ periodStart: "2026-01-01", weight: 1n }],
    remaining: toUnits("12.34"),
    fromPeriod: "2026-04-01",
    quantum: CENT,
  });
  assert.deepEqual(
    lines.map((l) => [l.periodStart, fromUnits(l.amount)]),
    [["2026-04-01", "12.3400"]],
  );
});
