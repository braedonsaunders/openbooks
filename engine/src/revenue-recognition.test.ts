import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import {
  allocateByRelativeSSP,
  apportion,
  buildRecognitionSchedule,
  computeRecognitionSchedule,
  estimateVariableConsideration,
  fairValueRangeFlag,
  recordRecognitionEvent,
  RevenueRecognitionError,
  runRevenueRecognition,
  separateFinancingComponent,
  type RecognitionInput,
} from "./revenue-recognition.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Sum of the planned amounts on a plan, in integer money units. */
function plannedUnits(plan: { planned: string }[]): bigint {
  return plan.reduce((acc, l) => acc + toUnits(l.planned), 0n);
}

// ---------------------------------------------------------------------------
// apportion — exact, proportional, drift-free
// ---------------------------------------------------------------------------

test("apportion sums exactly to the total", () => {
  const parts = apportion(toUnits("1000"), [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), toUnits("1000"));
  // 1000/3 → 333.3334 + 333.3333 + 333.3333, largest remainder to the first
  assert.deepEqual(parts.map(String), [toUnits("333.3334"), toUnits("333.3333"), toUnits("333.3333")].map(String));
});

test("apportion is proportional to weights", () => {
  const parts = apportion(toUnits("1000"), [3, 1]);
  assert.deepEqual(parts, [toUnits("750"), toUnits("250")]);
});

test("apportion handles negative totals and preserves the exact sum", () => {
  const parts = apportion(toUnits("-1000"), [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), toUnits("-1000"));
});

test("apportion returns zeros for zero total or non-positive weights", () => {
  assert.deepEqual(apportion(0n, [1, 2, 3]), [0n, 0n, 0n]);
  assert.deepEqual(apportion(toUnits("100"), [0, 0]), [0n, 0n]);
});

// ---------------------------------------------------------------------------
// allocateByRelativeSSP — ASC 606 relative standalone-selling-price
// ---------------------------------------------------------------------------

test("relative-SSP allocation splits the price by SSP and sums exactly", () => {
  const alloc = allocateByRelativeSSP("1000", [{ ssp: "600" }, { ssp: "400" }]);
  assert.deepEqual(alloc, ["600.0000", "400.0000"]);
});

test("relative-SSP allocation absorbs rounding so the bundle still sums to the price", () => {
  const alloc = allocateByRelativeSSP("1000", [{ ssp: "100" }, { ssp: "100" }, { ssp: "100" }]);
  assert.equal(alloc.reduce((a, s) => a + toUnits(s), 0n), toUnits("1000"));
});

test("relative-SSP allocation falls back to the booked amount when SSP is missing", () => {
  const alloc = allocateByRelativeSSP("1000", [{ ssp: null, booked: "500" }, { ssp: "500" }]);
  assert.deepEqual(alloc, ["500.0000", "500.0000"]);
});

// ---------------------------------------------------------------------------
// fairValueRangeFlag — allocated per-unit price vs fair value [low, high]
// ---------------------------------------------------------------------------

test("fair value range: in-range and boundary per-unit prices never flag", () => {
  assert.equal(fairValueRangeFlag("110.0000", "1", "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("100.0000", "1", "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("120.0000", "1", "100.0000", "120.0000"), null);
  // 3 units at 110/unit against a 100–120 range.
  assert.equal(fairValueRangeFlag("330.0000", "3", "100.0000", "120.0000"), null);
});

test("fair value range: out-of-range per-unit prices flag below/above", () => {
  assert.equal(fairValueRangeFlag("99.9900", "1", "100.0000", "120.0000"), "below_range");
  assert.equal(fairValueRangeFlag("120.0100", "1", "100.0000", "120.0000"), "above_range");
  // 4 units, line total 360 → 90/unit, under the 100 floor.
  assert.equal(fairValueRangeFlag("360.0000", "4", "100.0000", "120.0000"), "below_range");
});

test("fair value range: open-ended and missing bounds", () => {
  assert.equal(fairValueRangeFlag("50.0000", "1", null, null), null);
  assert.equal(fairValueRangeFlag("50.0000", "1", "100.0000", null), "below_range");
  assert.equal(fairValueRangeFlag("500.0000", "1", null, "120.0000"), "above_range");
  assert.equal(fairValueRangeFlag("500.0000", "1", "100.0000", null), null);
});

test("cost-to-cost fraction clamps to [0,1] and guards zero budgets", async () => {
  const { costToCostFraction } = await import("./project-revenue.ts");
  assert.equal(costToCostFraction("1000", "250"), "0.2500");
  assert.equal(costToCostFraction("1000", "1500"), "1.0000");
  assert.equal(costToCostFraction("0", "500"), "0.0000");
  assert.equal(costToCostFraction("-5", "500"), "0.0000");
  assert.equal(costToCostFraction("1000", "-20"), "0.0000");
});

test("fair value range: zero/missing quantity falls back to the line amount", () => {
  assert.equal(fairValueRangeFlag("110.0000", "0", "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("110.0000", null, "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("90.0000", null, "100.0000", "120.0000"), "below_range");
});

// ---------------------------------------------------------------------------
// computeRecognitionSchedule — per method
// ---------------------------------------------------------------------------

test("point_in_time recognizes the whole amount in the start month", () => {
  const plan = computeRecognitionSchedule({ total: "1200", method: "point_in_time", startOn: "2026-03-10" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.periodMonth, "2026-03-01");
  assert.equal(toUnits(plan[0]!.planned), toUnits("1200"));
});

test("straight_line_even spreads evenly over the term and sums exactly", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
  });
  assert.equal(plan.length, 12);
  assert.equal(plan[0]!.periodMonth, "2026-01-01");
  assert.equal(plan[11]!.periodMonth, "2026-12-01");
  for (const l of plan) assert.equal(toUnits(l.planned), toUnits("100"));
  assert.equal(plannedUnits(plan), toUnits("1200"));
});

test("initial amount percent is recognized up front, remainder spread evenly", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
    initialAmountPercent: "10",
  });
  // 10% = 120 up front; remainder 1080 / 12 = 90; first period = 210, rest = 90.
  assert.equal(toUnits(plan[0]!.planned), toUnits("210"));
  assert.equal(toUnits(plan[1]!.planned), toUnits("90"));
  assert.equal(plannedUnits(plan), toUnits("1200"));
});

test("straight_line_prorate_first_last weights the first and last partial months by days", () => {
  const plan = computeRecognitionSchedule({
    total: "3100",
    method: "straight_line_prorate_first_last",
    startOn: "2026-01-15",
    endOn: "2026-02-14",
  });
  assert.equal(plan.length, 2);
  // Jan: 15..31 = 17 days; Feb: 1..14 = 14 days; weights [17,14] of 3100.
  assert.equal(plannedUnits(plan), toUnits("3100"));
  assert.ok(toUnits(plan[0]!.planned) > toUnits(plan[1]!.planned));
});

test("straight_line_daily allocates by exact days in each month and sums exactly", () => {
  const plan = computeRecognitionSchedule({
    total: "9000",
    method: "straight_line_daily",
    startOn: "2026-01-01",
    endOn: "2026-03-31",
  });
  assert.equal(plan.length, 3);
  // 90 days total: Jan 31, Feb 28, Mar 31 → 3100, 2800, 3100.
  assert.equal(toUnits(plan[0]!.planned), toUnits("3100"));
  assert.equal(toUnits(plan[1]!.planned), toUnits("2800"));
  assert.equal(toUnits(plan[2]!.planned), toUnits("3100"));
  assert.equal(plannedUnits(plan), toUnits("9000"));
});

test("percent_complete recognizes the cumulative target minus already-recognized", () => {
  const base: RecognitionInput = {
    total: "1000",
    method: "percent_complete",
    startOn: "2026-06-01",
    percentComplete: "40",
    alreadyRecognized: "250",
  };
  const plan = computeRecognitionSchedule(base);
  assert.equal(plan.length, 1);
  assert.equal(toUnits(plan[0]!.planned), toUnits("150")); // 40% of 1000 = 400; 400 − 250
});

test("percent_complete claws back when the estimate falls (ASC 606 cumulative catch-up)", () => {
  const plan = computeRecognitionSchedule({
    total: "1000",
    method: "percent_complete",
    startOn: "2026-06-01",
    percentComplete: "40",
    alreadyRecognized: "500",
  });
  // target 400 − already 500 → −100 reversal in the current period.
  assert.equal(plan[0]!.planned, "-100.0000");
});

test("milestone recognizes exactly the entered event amounts", () => {
  const plan = computeRecognitionSchedule({
    total: "5000",
    method: "milestone",
    startOn: "2026-01-01",
    events: [
      { periodMonth: "2026-02-01", amount: "2000" },
      { periodMonth: "2026-05-01", amount: "3000" },
    ],
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0]!.periodMonth, "2026-02-01");
  assert.equal(plannedUnits(plan), toUnits("5000"));
});

test("period offset defers the whole schedule by N months", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
    periodOffset: 2,
  });
  assert.equal(plan[0]!.periodMonth, "2026-03-01");
  assert.equal(plan[11]!.periodMonth, "2027-02-01");
  assert.equal(plannedUnits(plan), toUnits("1200"));
});

test("start offset days pushes the recognition start into the next month when it crosses a boundary", () => {
  const plan = computeRecognitionSchedule({
    total: "1000",
    method: "straight_line_even",
    startOn: "2026-01-20",
    termPeriods: 1,
    startOffsetDays: 15, // 2026-01-20 + 15 = 2026-02-04
  });
  assert.equal(plan[0]!.periodMonth, "2026-02-01");
});

test("cumulative column tracks recognized-to-date and ends at the total", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
  });
  assert.equal(toUnits(plan[0]!.cumulative), toUnits("100"));
  assert.equal(toUnits(plan[11]!.cumulative), toUnits("1200"));
});

test("an end date before the start date is refused, not planned as silent zeros", () => {
  for (const method of [
    "straight_line_even",
    "straight_line_prorate_first_last",
    "straight_line_daily",
  ] as const) {
    assert.throws(
      () =>
        computeRecognitionSchedule({
          total: "1200",
          method,
          startOn: "2026-03-01",
          endOn: "2026-02-28",
        }),
      /precedes the recognition start/,
    );
  }
});

test("a single-period term ending on the start day still plans the full amount", () => {
  // Guard against over-eager validation: end == start is a legal one-day term.
  const plan = computeRecognitionSchedule({
    total: "500",
    method: "straight_line_daily",
    startOn: "2026-03-01",
    endOn: "2026-03-01",
  });
  assert.equal(plan.length, 1);
  assert.equal(toUnits(plan[0]!.planned), toUnits("500"));
});

// ---------------------------------------------------------------------------
// Step 3 — transaction price: variable consideration + financing component
// ---------------------------------------------------------------------------

test("expected-value estimation probability-weights the outcomes (606-10-32-8)", () => {
  const v = estimateVariableConsideration({
    method: "expected_value",
    outcomes: [
      { amount: "10000", probabilityPercent: "50" },
      { amount: "6000", probabilityPercent: "30" },
      { amount: "0", probabilityPercent: "20" },
    ],
  });
  assert.equal(v.estimate, "6800.0000"); // 5,000 + 1,800 + 0
  assert.equal(v.constrained, "6800.0000");
  assert.equal(v.constrainedOut, "0.0000");
});

test("most-likely-amount takes the single highest-probability outcome and refuses a tie", () => {
  const v = estimateVariableConsideration({
    method: "most_likely_amount",
    outcomes: [
      { amount: "20000", probabilityPercent: "60" },
      { amount: "0", probabilityPercent: "40" },
    ],
  });
  assert.equal(v.estimate, "20000.0000");
  assert.throws(
    () =>
      estimateVariableConsideration({
        method: "most_likely_amount",
        outcomes: [
          { amount: "20000", probabilityPercent: "50" },
          { amount: "0", probabilityPercent: "50" },
        ],
      }),
    /ambiguous/,
  );
});

test("the constraint caps the estimate and carries the held-back amount (606-10-32-11)", () => {
  const v = estimateVariableConsideration({
    method: "most_likely_amount",
    outcomes: [
      { amount: "20000", probabilityPercent: "60" },
      { amount: "0", probabilityPercent: "40" },
    ],
    constraintLimit: "12000",
  });
  assert.equal(v.constrained, "12000.0000");
  assert.equal(v.constrainedOut, "8000.0000");
});

test("probabilities must sum to exactly 100 percent", () => {
  assert.throws(
    () =>
      estimateVariableConsideration({
        method: "expected_value",
        outcomes: [{ amount: "100", probabilityPercent: "99.99" }],
      }),
    /sum to exactly 100/,
  );
});

test("financing component: revenue at the cash selling price, accretion lands exactly (606-10-32-15)", () => {
  const f = separateFinancingComponent({
    consideration: "121000",
    annualRatePercent: "10",
    years: 2,
  });
  assert.equal(f.cashSellingPrice, "100000.0000"); // 121,000 / 1.21 exactly
  assert.equal(f.financingComponent, "21000.0000");
  assert.equal(f.accretion[0]!.interest, "10000.0000");
  assert.equal(f.accretion[1]!.interest, "11000.0000");
  assert.equal(f.accretion[1]!.closing, "121000.0000");
});

test("financing accretion absorbs rounding in the final year and still lands on the billed amount", () => {
  const f = separateFinancingComponent({
    consideration: "50000",
    annualRatePercent: "7.25",
    years: 3,
  });
  // PV = 50,000 / 1.0725^3 — irrational in decimal; the accretion must still
  // land on exactly 50,000.0000.
  const last = f.accretion[f.accretion.length - 1]!;
  assert.equal(last.closing, "50000.0000");
  const interestSum = f.accretion.reduce((a, p) => a + toUnits(p.interest), 0n);
  assert.equal(interestSum, toUnits(f.financingComponent));
});

// ---------------------------------------------------------------------------
// runRevenueRecognition — fail-closed empty milestone/usage schedules
// ---------------------------------------------------------------------------

test("an empty milestone schedule reports a problem and never satisfies the obligation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  try {
    const ruleId = randomUUID();
    await db.execute(sql`
      insert into recognition_rules
        (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
         period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
      values (${ruleId}, ${org.orgId}, 'MILESTONE', 'Milestone events', 'milestone', false, 1,
              'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);

    const contractId = randomUUID();
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
      values (${contractId}, ${org.orgId}, ${org.customerId}, 'REV-MILESTONE-001', 'active', ${org.date},
              'CAD', '5000', ${actorId}, ${actorId})`);

    const obligationId = randomUUID();
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'Milestone deliverable', ${ruleId},
              '5000', '5000', ${org.date}, 'open', ${actorId}, ${actorId})`);

    // The real build path: with no event source, the defect leaves a zero-line schedule.
    const build = await buildRecognitionSchedule(obligationId, org.orgId, actorId);
    assert.equal(build.lineCount, 0);

    const run = await runRevenueRecognition(org.orgId, "2026-12-31", actorId);
    assert.equal(run.posted, 0);
    assert.ok(
      run.problems.some((p) =>
        p.includes("REV-MILESTONE-001") &&
        p.includes("milestone/usage obligation has no recognition events recorded"),
      ),
      `expected an empty-milestone problem, got ${JSON.stringify(run.problems)}`,
    );

    const status = (await db.execute<{ status: string }>(sql`
      select status from performance_obligations where id = ${obligationId}`));
    assert.equal(status.rows[0]!.status, "open");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// buildRecognitionSchedule — fail-closed on absent accounting periods
// ---------------------------------------------------------------------------

test("buildRecognitionSchedule throws when a planned month has no accounting period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  try {
    // Remove future periods so the 12-month rule spans absent months.
    await db.execute(sql`
      delete from accounting_periods where org_id = ${org.orgId} and starts_on >= '2026-08-01'`);

    const contractId = randomUUID();
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
      values (${contractId}, ${org.orgId}, ${org.customerId}, 'REV-MISSING-PERIOD-001', 'active', ${org.date},
              'CAD', '1200', ${actorId}, ${actorId})`);

    const obligationId = randomUUID();
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
      values (${obligationId}, ${org.orgId}, ${contractId}, '12-month subscription', ${org.recognitionRuleId},
              '1200', '1200', ${org.date}, 'open', ${actorId}, ${actorId})`);

    let caught: unknown;
    try {
      await buildRecognitionSchedule(obligationId, org.orgId, actorId);
      assert.fail("expected RevenueRecognitionError for missing period");
    } catch (e: unknown) {
      caught = e;
    }
    assert.ok(caught instanceof RevenueRecognitionError, `expected RevenueRecognitionError, got ${String(caught)}`);
    assert.ok(
      (caught as RevenueRecognitionError).message.includes("no accounting period covers"),
      `expected missing-period message, got: ${(caught as RevenueRecognitionError).message}`,
    );

    const schedule = (await db.execute<{ line_count: string }>(sql`
      select count(*)::text as line_count from recognition_schedule_lines
       where schedule_id in (select id from recognition_schedules where obligation_id = ${obligationId} and org_id = ${org.orgId})`));
    assert.equal(Number(schedule.rows[0]!.line_count), 0, "no schedule lines should be persisted for a failed build");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Milestone + usage event persistence — live PG proofs
// ---------------------------------------------------------------------------

test("milestone events produce a non-zero recognition schedule and post through runRevenueRecognition", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  try {
    // Create additional accounting periods for the event months.
    const calId = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${org.orgId} and is_default = true`)).rows[0]!.id;
    for (const { year, num, name, start, end } of [
      { year: 2026, num: 1, name: "2026-01", start: "2026-01-01", end: "2026-01-31" },
      { year: 2026, num: 2, name: "2026-02", start: "2026-02-01", end: "2026-02-28" },
    ]) {
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, ${year}, ${num}, ${name}, ${start}, ${end}, false, ${calId})`);
    }

    const ruleId = randomUUID();
    await db.execute(sql`
      insert into recognition_rules
        (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
         period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
      values (${ruleId}, ${org.orgId}, 'MILESTONE2', 'Milestone events', 'milestone', false, 1,
              'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);

    const contractId = randomUUID();
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
      values (${contractId}, ${org.orgId}, ${org.customerId}, 'REV-MILESTONE-002', 'active', '2026-01-01',
              'CAD', '5000', ${actorId}, ${actorId})`);

    const obligationId = randomUUID();
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'Milestone deliverable', ${ruleId},
              '5000', '5000', '2026-01-01', 'open', ${actorId}, ${actorId})`);

    // Record two milestone events.
    const evt1 = await recordRecognitionEvent({
      obligationId, orgId: org.orgId, actorId, periodMonth: "2026-01-01", amount: "2000",
      description: "Design complete",
    });
    const evt2 = await recordRecognitionEvent({
      obligationId, orgId: org.orgId, actorId, periodMonth: "2026-02-01", amount: "3000",
      description: "Build complete",
    });
    assert.ok(evt1.eventId);
    assert.ok(evt2.eventId);

    // Build the schedule — should now produce 2 lines, not zero.
    const build = await buildRecognitionSchedule(obligationId, org.orgId, actorId);
    assert.equal(build.lineCount, 2);

    // Run recognition — both periods should post.
    const run = await runRevenueRecognition(org.orgId, "2026-12-31", actorId);
    assert.equal(run.posted, 2);
    assert.equal(run.totalAmount, "5000.0000");
    // Obligation should be satisfied.
    const status = (await db.execute<{ status: string }>(sql`
      select status from performance_obligations where id = ${obligationId}`));
    assert.equal(status.rows[0]!.status, "satisfied");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("usage events produce a non-zero recognition schedule with correct amounts", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  try {
    const calId = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${org.orgId} and is_default = true`)).rows[0]!.id;
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, 1, '2026-01', '2026-01-01', '2026-01-31', false, ${calId})`);

    const ruleId = randomUUID();
    await db.execute(sql`
      insert into recognition_rules
        (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
         period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
      values (${ruleId}, ${org.orgId}, 'USAGE1', 'Usage metered', 'usage', false, 1,
              'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);

    const contractId = randomUUID();
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
      values (${contractId}, ${org.orgId}, ${org.customerId}, 'REV-USAGE-001', 'active', '2026-01-01',
              'CAD', '1200', ${actorId}, ${actorId})`);

    const obligationId = randomUUID();
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'API usage', ${ruleId},
              '1200', '1200', '2026-01-01', 'open', ${actorId}, ${actorId})`);

    // Record a usage event: 10,000 calls at $0.12 each = $1,200.
    await recordRecognitionEvent({
      obligationId, orgId: org.orgId, actorId,
      periodMonth: "2026-01-01", amount: "1200",
      description: "January API calls", unitRate: "0.12", quantity: "10000",
    });

    const build = await buildRecognitionSchedule(obligationId, org.orgId, actorId);
    assert.equal(build.lineCount, 1);

    const plan = computeRecognitionSchedule({
      total: "1200", method: "usage", startOn: "2026-01-01",
      events: [{ periodMonth: "2026-01-01", amount: "1200" }],
    });
    assert.equal(plan.length, 1);
    assert.equal(toUnits(plan[0]!.planned), toUnits("1200"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("recordRecognitionEvent rejects a straight_line method obligation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  try {
    const contractId = randomUUID();
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
      values (${contractId}, ${org.orgId}, ${org.customerId}, 'REV-SL-001', 'active', ${org.date},
              'CAD', '1200', ${actorId}, ${actorId})`);

    const obligationId = randomUUID();
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'Subscription', ${org.recognitionRuleId},
              '1200', '1200', ${org.date}, 'open', ${actorId}, ${actorId})`);

    await assert.rejects(
      () => recordRecognitionEvent({
        obligationId, orgId: org.orgId, actorId, periodMonth: "2026-07-01", amount: "100",
      }),
      /does not accept events/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("milestone schedule rebuilds on new event and preserves posted history", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  try {
    const calId = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${org.orgId} and is_default = true`)).rows[0]!.id;
    // Create periods for Jan and Feb 2026.
    for (const { num, name, start, end } of [
      { num: 1, name: "2026-01", start: "2026-01-01", end: "2026-01-31" },
      { num: 2, name: "2026-02", start: "2026-02-01", end: "2026-02-28" },
    ]) {
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, 2026, ${num}, ${name}, ${start}, ${end}, false, ${calId})`);
    }

    const ruleId = randomUUID();
    await db.execute(sql`
      insert into recognition_rules
        (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
         period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
      values (${ruleId}, ${org.orgId}, 'MILEST3', 'Milestone', 'milestone', false, 1,
              'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);

    const contractId = randomUUID();
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
      values (${contractId}, ${org.orgId}, ${org.customerId}, 'REV-MILESTONE-003', 'active', '2026-01-01',
              'CAD', '5000', ${actorId}, ${actorId})`);

    const obligationId = randomUUID();
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'Milestone deliverable', ${ruleId},
              '5000', '5000', '2026-01-01', 'open', ${actorId}, ${actorId})`);

    // Record first milestone.
    await recordRecognitionEvent({
      obligationId, orgId: org.orgId, actorId, periodMonth: "2026-01-01", amount: "2000",
    });

    // Run recognition — Jan posts.
    const run1 = await runRevenueRecognition(org.orgId, "2026-01-31", actorId);
    assert.equal(run1.posted, 1);

    // Add a second event for Feb.
    await recordRecognitionEvent({
      obligationId, orgId: org.orgId, actorId, periodMonth: "2026-02-01", amount: "3000",
    });

    // Build should now plan both periods, but the Jan line is already posted.
    const build = await buildRecognitionSchedule(obligationId, org.orgId, actorId);
    assert.equal(build.lineCount, 1); // only the new Feb line; Jan is posted

    // Run recognition for Feb.
    const run2 = await runRevenueRecognition(org.orgId, "2026-12-31", actorId);
    assert.equal(run2.posted, 1);
    assert.equal(run2.totalAmount, "3000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
