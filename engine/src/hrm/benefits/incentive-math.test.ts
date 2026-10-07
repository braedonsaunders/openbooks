import { refusal } from "../../testing/refusal.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apportionExactUnits,
  computeIncentiveAwards,
  eligibleMembers,
  partitionMembers,
  type ComputeIncentiveInput,
  type IncentiveMeasured,
  type IncentivePeriodBasis,
} from "./incentive-math.ts";
import type { BenefitProgram, BenefitProgramMember } from "./program-types.ts";
import { BenefitsError } from "./errors.ts";

function program(overrides: Partial<BenefitProgram> = {}): BenefitProgram {
  return {
    id: "program-1",
    code: "QPS",
    name: "Quarterly profit share",
    family: "incentive",
    approvalMode: "none",
    description: null,
    legalEntityId: "sub-1",
    currency: "USD",
    status: "active",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    payComponentId: "comp-1",
    deliveryMethod: "payroll",
    valuation: "percent",
    metric: "net_profit",
    metricScope: "company",
    scopeIds: [],
    allocation: "equal",
    percentRate: "10",
    fixedAmount: null,
    capAmount: null,
    budgetAmount: null,
    thresholdAmount: null,
    frequency: "quarterly",
    periodBasis: "calendar",
    paymentDelayDays: 0,
    revision: 3,
    createdBy: "actor-1",
    updatedBy: "actor-1",
    ...overrides,
  };
}

function measured(overrides: Partial<IncentiveMeasured> = {}): IncentiveMeasured {
  return {
    metric: "net_profit",
    scope: "company",
    sourceAccountIds: ["acc-rev", "acc-exp"],
    periodFrom: "2026-01-01",
    periodTo: "2026-03-31",
    value: "10000.0000",
    currency: "USD",
    ...overrides,
  };
}

function member(employmentId: string, overrides: Partial<BenefitProgramMember> = {}): BenefitProgramMember {
  return {
    id: `member-${employmentId}`,
    programId: "program-1",
    employmentId,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    weight: null,
    role: null,
    ...overrides,
  };
}

const CALENDAR: IncentivePeriodBasis = { kind: "calendar" };

function calc(input: Partial<ComputeIncentiveInput> = {}) {
  return computeIncentiveAwards({
    program: program(),
    measured: measured(),
    shares: [{ employmentId: "emp-a", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null }],
    periodBasis: CALENDAR,
    minorUnits: 2,
    ...input,
  });
}

const refuses = async (fn: () => unknown, pattern: RegExp) =>
  (await refusal(Promise.resolve().then(fn), BenefitsError, pattern)).message;


const invalidComputations: [string, Partial<ComputeIncentiveInput>, RegExp[]][] = [
  [
    "a fixed program without a fixed amount refuses by name",
    { program: program({ valuation: "fixed", fixedAmount: null, frequency: "manual" }), measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }) },
    [/names no fixed amount/],
  ],
  [
    "a measured loss refuses instead of sharing the loss",
    { measured: measured({ value: "-500.0000" }) },
    [/loss/, /explicit loss rule/],
  ],
  [
    "a budget overrun refuses with both figures",
    { program: program({ budgetAmount: "900.0000" }) },
    [/exceed the program budget/, /1000\.0000/, /900\.0000/],
  ],
  [
    "a pool without a size refuses instead of guessing one",
    { program: program({ valuation: "pool", percentRate: null, fixedAmount: null, budgetAmount: null }) },
    [/size the pool/],
  ],
  [
    "settling a different metric than the program declares refuses",
    { program: program({ metric: "revenue" }), measured: measured({ metric: "net_profit" }) },
    [/never settles a measure it did not declare/],
  ],
  [
    "no eligible share evidence is a refusal, not an empty success",
    { shares: [] },
    [/no member is eligible/],
  ],
  [
    "nonexistent calendar dates refuse instead of entering a comparison",
    { program: program({ frequency: "manual" }), measured: measured({ periodFrom: "2026-02-30", periodTo: "2026-03-01" }) },
    [/not a real calendar date/],
  ],
];
for (const [name, input, patterns] of invalidComputations) {
  test(name, async () => {
    const message = await refuses(() => calc(input), patterns[0]!);
    for (const pattern of patterns.slice(1)) assert.match(message, pattern);
  });
}

test("percent awards split the pool equally and preserve every cent", () => {
  const result = calc({
    shares: [
      { employmentId: "emp-c", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-a", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-b", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  });
  assert.equal(result.poolValue, "1000.0000");
  assert.equal(result.totalAwarded, "1000.0000");
  assert.equal(result.undistributed, "0.0000");
  // 1000.00 splits to whole cents with the leftover cent dealt by largest
  // remainder — tied remainders break to the earlier employment id.
  const byId = new Map(result.recipients.map((r) => [r.employmentId, r.value]));
  assert.equal(byId.get("emp-a"), "333.3400");
  assert.equal(byId.get("emp-b"), "333.3300");
  assert.equal(byId.get("emp-c"), "333.3300");
  assert.ok(result.summaryLines.some((l) => l.includes("10%")));
  assert.ok(result.summaryLines.some((l) => l.includes("payable pool")));
});

test("caps bind per recipient and the leftover is reported, never re-apportioned", () => {
  const result = calc({
    program: program({ capAmount: "300.0000" }),
    shares: [
      { employmentId: "emp-a", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-b", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  });
  assert.deepEqual(
    result.recipients.map((r) => r.value),
    ["300.0000", "300.0000"],
  );
  assert.ok(result.recipients.every((r) => r.capped));
  assert.equal(result.totalAwarded, "600.0000");
  assert.equal(result.undistributed, "400.0000");
  assert.ok(result.summaryLines.some((l) => l.includes("undistributed")));
});

test("fixed awards pay every eligible member the configured amount", () => {
  const result = calc({
    program: program({ valuation: "fixed", fixedAmount: "250.0000", frequency: "manual" }),
    measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    shares: [
      { employmentId: "emp-a", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-b", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  });
  assert.equal(result.totalAwarded, "500.0000");
  assert.ok(result.recipients.every((r) => r.share === "fixed"));
});


test("hours allocation splits by approved time and refuses missing evidence", async () => {
  const result = calc({
    program: program({ allocation: "hours", frequency: "manual", metric: "approved_hours" }),
    measured: measured({ metric: "approved_hours", value: "120.0000", currency: null, periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    shares: [
      { employmentId: "emp-a", weight: null, hours: "90.0000", effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-b", weight: null, hours: "30.0000", effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  });
  const byId = new Map(result.recipients.map((r) => [r.employmentId, r.value]));
  // Pool is 10% of 120 hours = 12; split 90/30.
  assert.equal(byId.get("emp-a"), "9.0000");
  assert.equal(byId.get("emp-b"), "3.0000");

  await refuses(
    () => calc({
      program: program({ allocation: "hours", frequency: "manual", metric: "approved_hours" }),
      measured: measured({ metric: "approved_hours", value: "120.0000", currency: null, periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    }),
    /emp-a.*no approved-hours evidence|approved-hours evidence.*emp-a/,
  );
});

test("role allocation uses recorded weights and never infers from titles", async () => {
  const result = calc({
    program: program({ allocation: "role", frequency: "manual" }),
    measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    shares: [
      { employmentId: "emp-foreman", weight: "3.0000", hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-hand", weight: "1.0000", hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  });
  const byId = new Map(result.recipients.map((r) => [r.employmentId, r.value]));
  assert.equal(byId.get("emp-foreman"), "750.0000");
  assert.equal(byId.get("emp-hand"), "250.0000");

  // The refusal names the employment and the remedy: record the weight.
  const message = await refuses(
    () => calc({
      program: program({ allocation: "role", frequency: "manual" }),
      measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
      shares: [
        { employmentId: "emp-foreman", weight: "3.0000", hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
        { employmentId: "emp-hand", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      ],
    }),
    /emp-hand/,
  );
  assert.match(message, /record the role weight/);
});

test("a threshold miss pays nothing and explains itself", () => {
  const result = calc({
    program: program({ thresholdAmount: "20000.0000" }),
  });
  assert.equal(result.thresholdMet, false);
  assert.equal(result.recipients.length, 0);
  assert.equal(result.totalAwarded, "0.0000");
  assert.ok(result.summaryLines.some((l) => l.includes("threshold") && l.includes("not met")));
});




test("period shapes follow the measurement frequency", async () => {
  const ok: ComputeIncentiveInput = {
    program: program({ frequency: "monthly" }),
    measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    shares: [{ employmentId: "emp-a", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null }],
    periodBasis: CALENDAR,
    minorUnits: 2,
  };
  assert.equal(calc(ok).recipients.length, 1);

  await refuses(
    () => calc({
      ...ok,
      measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-03-15" }),
    }),
    /whole months/,
  );
  await refuses(
    () => calc({
      program: program({ frequency: "annual" }),
      measured: measured({ periodFrom: "2026-01-01", periodTo: "2026-06-30" }),
    }),
    /whole years/,
  );
  await refuses(
    () => calc({
      program: program({ frequency: "quarterly" }),
      measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-04-30" }),
    }),
    /whole quarters/,
  );
});


test("money measures need a currency; hours measures use the program currency", async () => {
  await refuses(
    () => calc({
      measured: measured({ currency: null }),
    }),
    /needs its currency/,
  );
  const hours = calc({
    program: program({ valuation: "fixed", fixedAmount: "50.0000", frequency: "manual", metric: "approved_hours" }),
    measured: measured({ metric: "approved_hours", value: "40.0000", currency: null, periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
  });
  assert.equal(hours.currency, "USD");
});

test("apportionment preserves the whole across uneven weights", () => {
  const weights = [
    { employmentId: "emp-a", units: 1n },
    { employmentId: "emp-b", units: 2n },
    { employmentId: "emp-c", units: 3n },
  ];
  for (const total of [0n, 1n, 7n, 10000n, 100000001n]) {
    const parts = apportionExactUnits(total, weights);
    const sum = [...parts.values()].reduce((a, b) => a + b, 0n);
    assert.equal(sum, total, `parts of ${total} must sum to the whole`);
  }
  // Deterministic: the same call twice assigns identically.
  const first = apportionExactUnits(100n, weights);
  const second = apportionExactUnits(100n, [...weights].reverse());
  assert.deepEqual([...first.entries()], [...second.entries()]);
});

test("membership eligibility follows the effective dates, not the current roster", () => {
  const members = [
    member("emp-inside"),
    member("emp-ended", { effectiveTo: "2026-01-15" }),
    member("emp-future", { effectiveFrom: "2026-04-01" }),
    member("emp-touching", { effectiveFrom: "2026-03-31", effectiveTo: "2026-03-31" }),
  ];
  const ids = eligibleMembers(members, "2026-01-01", "2026-03-31").map((m) => m.employmentId);
  assert.deepEqual(ids, ["emp-inside", "emp-ended", "emp-touching"]);
});

test("coverage splits full-period members from partial ones without prorating", () => {
  const { covered, partial } = partitionMembers(
    [
      member("emp-full", { effectiveFrom: "2026-01-01" }),
      member("emp-mid", { effectiveFrom: "2026-02-15" }),
      member("emp-ended", { effectiveFrom: "2026-01-01", effectiveTo: "2026-02-15" }),
      member("emp-outside", { effectiveFrom: "2026-04-01" }),
    ],
    "2026-02-01",
    "2026-02-28",
  );
  assert.deepEqual(covered.map((m) => m.employmentId), ["emp-full"]);
  assert.deepEqual(partial.map((m) => m.employmentId).sort(), ["emp-ended", "emp-mid"]);
});

test("recipient explanations carry membership and share evidence", () => {
  const result = calc({
    program: program({ allocation: "role", frequency: "manual" }),
    measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    shares: [
      { employmentId: "emp-a", weight: "2.0000", hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  });
  const line = result.recipients[0]!.explanation;
  assert.match(line, /member 2026-01-01\.\.open/);
  assert.match(line, /weight 2\.0000/);
  assert.match(line, /share 20000\/20000/);
});

test("an inverted membership span refuses with the remedy", async () => {
  await refuses(
    async () => eligibleMembers(
      [member("emp-bad", { effectiveFrom: "2026-03-01", effectiveTo: "2026-02-01" })],
      "2026-01-01",
      "2026-03-31",
    ),
    /end it on or after its start/,
  );
});



test("a duplicated employment in one apportionment refuses instead of double-paying", async () => {
  await refuses(
    async () => apportionExactUnits(10000n, [
      { employmentId: "emp-a", units: 1n },
      { employmentId: "emp-a", units: 2n },
    ]),
    /appears twice.*double-pay/,
  );
});

test("fiscal quarters follow the organization's year-start month", async () => {
  const april: IncentivePeriodBasis = {
    kind: "fiscal", calendarName: "April FY", yearStartMonth: 4, cadence: "monthly",
  };
  // Q1 of FY2026 runs April..June 2026; January..March 2026 closes FY2025.
  const q1 = calc({
    measured: measured({ periodFrom: "2026-04-01", periodTo: "2026-06-30" }),
    periodBasis: april,
  });
  assert.equal(q1.recipients.length, 1);
  assert.ok(q1.summaryLines.some((l) => l.includes('fiscal calendar "April FY"')));
  const q4 = calc({
    measured: measured({ periodFrom: "2026-01-01", periodTo: "2026-03-31" }),
    periodBasis: april,
  });
  assert.equal(q4.recipients.length, 1);
  // A February-start span is a quarter on no July fiscal year (Q3 is Jan..Mar).
  await refuses(
    () => calc({
      measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-04-30" }),
        periodBasis: { kind: "fiscal", calendarName: "July FY", yearStartMonth: 7, cadence: "monthly" },
    }),
    /whole quarters/,
  );
});

test("fiscal years span the year-start month across calendar years", async () => {
  const april: IncentivePeriodBasis = {
    kind: "fiscal", calendarName: "April FY", yearStartMonth: 4, cadence: "monthly",
  };
  const full = calc({
    program: program({ frequency: "annual" }),
    measured: measured({ periodFrom: "2026-04-01", periodTo: "2027-03-31" }),
    periodBasis: april,
  });
  assert.equal(full.recipients.length, 1);
  await refuses(
    () => calc({
      program: program({ frequency: "annual" }),
      measured: measured({ periodFrom: "2026-01-01", periodTo: "2026-12-31" }),
        periodBasis: april,
    }),
    /whole years/,
  );
});

test("the pool rounds once to payable precision, halves away from zero", () => {
  // 10% of 10.05 is 1.005 → payable 1.01, awarded whole to one member.
  const result = calc({
    program: program({ frequency: "manual" }),
    measured: measured({ value: "10.0500", periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
  });
  assert.equal(result.poolValue, "1.0100");
  assert.equal(result.totalAwarded, "1.0100");
  assert.equal(result.recipients[0]!.value, "1.0100");
});

test("a cent pool apportions nonzero-only with named zero exclusions", () => {
  const result = calc({
    program: program({ percentRate: "100", frequency: "manual" }),
    measured: measured({ value: "0.0100", periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    shares: [
      { employmentId: "emp-a", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-b", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-c", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  });
  // One cent cannot split three ways: one recipient, two named exclusions,
  // and the sum still exactly the pool.
  assert.equal(result.recipients.length, 1);
  assert.equal(result.totalAwarded, "0.0100");
  assert.equal(result.excludedZero.length, 2);
  assert.ok(result.excludedZero.every((l) => l.includes("rounds to zero")));
});

test("zero-decimal currencies apportion whole units", () => {
  const result = calc({
    program: program({ currency: "JPY", frequency: "manual" }),
    measured: measured({ value: "1000.0000", currency: "JPY", periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    shares: [
      { employmentId: "emp-a", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: "emp-b", weight: null, hours: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
    minorUnits: 0,
  });
  // 10% of 1000 yen is a 100-yen pool, split whole yen each.
  const byId = new Map(result.recipients.map((r) => [r.employmentId, r.value]));
  assert.equal(byId.get("emp-a"), "50.0000");
  assert.equal(byId.get("emp-b"), "50.0000");
});

test("configured cash finer than payable precision refuses instead of rounding", async () => {
  await refuses(
    () => calc({
      program: program({ valuation: "fixed", fixedAmount: "250.0001", frequency: "manual" }),
      measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    }),
    /finer than payable precision/,
  );
  await refuses(
    () => calc({
      program: program({ capAmount: "300.0010" }),
    }),
    /finer than payable precision/,
  );
});

test("non-plain decimals refuse before they reach the ledger kernel", async () => {
  // Scientific notation, over-scale fractions, symbols, and separators have
  // no plain-decimal reading and refuse; padded and signed forms normalize.
  for (const bad of ["1E3", "5.00001", "$5.00", "1,000"]) {
    await refuses(
      () => calc({
        program: program({ valuation: "fixed", fixedAmount: bad, frequency: "manual" }),
      measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    }),
      /exact plain decimal/,
    );
  }
});

test("week-based fiscal calendars settle periodic programs on manual spans", async () => {
  const retail: IncentivePeriodBasis = {
    kind: "fiscal", calendarName: "Retail 445", yearStartMonth: 2, cadence: "four_four_five",
  };
  await refuses(
    () => calc({
      program: program({ frequency: "quarterly" }),
      measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-04-30" }),
        periodBasis: retail,
    }),
    /no month-aligned periods.*manual span/,
  );
  // Manual spans still work on the same calendar.
  const manual = calc({
    program: program({ frequency: "manual" }),
    measured: measured({ periodFrom: "2026-02-01", periodTo: "2026-04-30" }),
    periodBasis: retail,
  });
  assert.equal(manual.recipients.length, 1);
});
