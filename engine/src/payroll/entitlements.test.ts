import { seedAdoption } from "./filing-test-fixtures.ts";
import {
  saveEntitlementOpenings,
  entitlementBalances,
  recordEntitlementMovements,
} from "./entitlements.ts";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  computePlanMovement,
  computeEmploymentServiceCredit,
  meetsServiceYears,
  serviceCreditMilestoneDate,
  entitlementMoneyValue,
  limitScopeOf,
  monthsOfService,
  pickPlanLimit,
  pickServiceTier,
  resolveServiceTiersFrom,
  type EntitlementLimitRow,
  type EntitlementPlan,
  type EntitlementPlanLimit,
  type ServiceTierRow,
} from "./entitlements.ts";
import { mulPercent } from "../money/money.ts";
import { PayrollError } from "./error.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const plan = (over: Partial<EntitlementPlan> = {}): EntitlementPlan => ({
  id: "plan-1",
  code: "BANK-OT",
  name: "Banked overtime",
  systemKey: null,
  unit: "money",
  direction: "accrue",
  accrualMethod: "percent_of_earnings",
  accrualValue: "4.0000",
  accrualComponentId: "cmp-accrual",
  payoutComponentId: "cmp-payout",
  depositComponentId: null,
  allowNegativeBalance: false,
  liabilityAccountId: "acct-liability",
  capBehavior: "warn",
  ...over,
});

const limit = (over: Partial<EntitlementPlanLimit> = {}): EntitlementPlanLimit => ({
  id: "limit-1",
  planId: "plan-1",
  maxBalance: "4000.0000",
  notifyBalance: "3500.0000",
  scope: "trade",
  effectiveFrom: "2026-01-01",
  ...over,
});

const move = (over: Record<string, unknown> = {}) =>
  ({
    plan: plan(),
    employeePartyId: "emp-1",
    movementDate: "2026-06-30",
    openingBalance: "0.0000",
    earnings: "0.0000",
    hours: "0.00",
    limit: null,
    ...over,
  }) as Parameters<typeof computePlanMovement>[0];

const limitRow = (over: Partial<EntitlementLimitRow> = {}): EntitlementLimitRow => ({
  id: "row",
  planId: "plan-1",
  employeePartyId: null,
  jobTitle: null,
  tradeId: null,
  departmentId: null,
  subsidiaryId: null,
  maxBalance: null,
  notifyBalance: null,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  isActive: true,
  ...over,
});

const EMPLOYEE = {
  employeePartyId: "emp-1",
  jobTitle: "Foreman",
  tradeId: "trade-electrical",
  departmentId: "dept-field",
  subsidiaryId: "sub-1",
};

/* ------------------------------------------------------------------ */
/* Accrual arithmetic — penny exactness                                */
/* ------------------------------------------------------------------ */

test("percent accrual is exact to the cent, not float-rounded", () => {
  // 4% of 1,234.57 = 49.3828 → 49.38. The float path (1234.57 * 0.04) gives
  // 49.382800000000006, which rounds the same here but drifts once summed.
  const result = computePlanMovement(move({ earnings: "1234.5700" }));
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0]!.amount, "49.3800");
  assert.equal(result.closingBalance, "49.3800");
});

test("percent accrual rounds half away from zero at the cent", () => {
  // 4% of 1,000.125 = 40.005 → 40.01
  assert.equal(
    computePlanMovement(move({ earnings: "1000.1250" })).movements[0]!.amount,
    "40.0100",
  );
});

test("a year of exact accruals never drifts from the analytic total", () => {
  // 26 biweekly periods of 4% on 2,884.62 must equal 26 × 115.38 exactly.
  let balance = "0.0000";
  for (let period = 0; period < 26; period++) {
    const result = computePlanMovement(move({ earnings: "2884.6200", openingBalance: balance }));
    balance = result.closingBalance;
  }
  assert.equal(balance, "2999.8800");
});

test("per-hour accrual multiplies exactly and records the hours as context", () => {
  const result = computePlanMovement(
    move({
      plan: plan({ accrualMethod: "per_hour_worked", accrualValue: "0.0577" }),
      hours: "86.50",
    }),
  );
  // 0.0577 × 86.50 = 4.99105 → 4.99
  assert.equal(result.movements[0]!.amount, "4.9900");
  assert.equal(result.movements[0]!.hours, "86.5000");
});

test("fixed-per-period and manual plans", () => {
  assert.equal(
    computePlanMovement(
      move({
        plan: plan({ accrualMethod: "fixed_per_period", accrualValue: "125.0000" }),
      }),
    ).movements[0]!.amount,
    "125.0000",
  );
  const manual = computePlanMovement(
    move({
      plan: plan({ accrualMethod: "manual", accrualValue: null }),
      earnings: "5000.0000",
    }),
  );
  assert.deepEqual(manual.movements, []);
  assert.equal(manual.closingBalance, "0.0000");
});

test("an hours plan cannot accrue a percent of earnings", () => {
  // A percent of (money) earnings banked as hours would store dollars as
  // hours — 4% of $2,000 banking "80.00" hours nobody worked. Refused with
  // both coherent shapes named, so the operator can fix the plan.
  assert.throws(
    () =>
      computePlanMovement(
        move({
          plan: plan({ unit: "hours", accrualMethod: "percent_of_earnings" }),
          earnings: "2000.0000",
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof PayrollError);
      assert.match(error.message, /BANK-OT banks hours but accrues a percent of earnings/);
      assert.match(error.message, /per hour worked|fixed amount per period/i);
      assert.match(error.message, /Payroll setup → Entitlement plans/);
      return true;
    },
  );
});

test("stub money values an hours bank at the wage, never as its hour count", () => {
  const hoursPlan = plan({ unit: "hours" });
  // 40 hours at $30/h pay $1,200 — not $40.00.
  assert.equal(
    entitlementMoneyValue({
      plan: hoursPlan,
      amount: "40.0000",
      wage: "30",
      employeeName: "A. User",
    }),
    "1200.0000",
  );
  // Money plans pass through to cents.
  assert.equal(
    entitlementMoneyValue({ plan: plan(), amount: "49.3828", wage: null, employeeName: "A. User" }),
    "49.3800",
  );
});

test("an hours bank with no wage is refused by name, never priced as zero", () => {
  const hoursPlan = plan({ unit: "hours", code: "SICK-HRS" });
  for (const wage of [null, "0", "0.0000"]) {
    assert.throws(
      () =>
        entitlementMoneyValue({
          plan: hoursPlan,
          amount: "40.0000",
          wage,
          employeeName: "A. User",
        }),
      (error: unknown) => {
        assert.ok(error instanceof PayrollError);
        assert.match(error.message, /SICK-HRS banks hours but A\. User has no hourly wage/);
        assert.match(error.message, /labor cost rate/);
        return true;
      },
    );
  }
});

/* ------------------------------------------------------------------ */
/* Cap behaviours                                                      */
/* ------------------------------------------------------------------ */

test("a cheque-declared accrual preserves exact cents, provenance and bank caps", () => {
  const vacation = plan({ systemKey: "vacation", capBehavior: "block" });
  const result = computePlanMovement(
    move({
      plan: vacation,
      openingBalance: "0",
      declaredAccrualAmount: "2500.81",
      declaredAccrualNote: "Reviewed issued cheque liability",
    }),
  );
  assert.equal(result.movements[0]!.amount, "2500.8100");
  assert.equal(result.movements[0]!.note, "Reviewed issued cheque liability");
  assert.throws(
    () =>
      computePlanMovement(
        move({
          plan: vacation,
          openingBalance: "2000",
          limit: limit(),
          declaredAccrualAmount: "2500.81",
        }),
      ),
    /would exceed/,
  );
  for (const amount of ["0", "-1", "1.001", "1,000.00", "1e3"]) {
    assert.throws(
      () => computePlanMovement(move({ plan: vacation, declaredAccrualAmount: amount })),
      /declared vacation accrual/,
    );
  }
});

test("a declared vacation accrual preserves effective service and personal entitlements", () => {
  const vacation = plan({ systemKey: "vacation" });
  for (const rates of [
    { employeeAccrualValue: "4", serviceAccrualValue: "6" },
    { employeeAccrualValue: "6", serviceAccrualValue: "4" },
  ]) {
    const input = move({ plan: vacation, earnings: "240", ...rates });
    assert.throws(
      () => computePlanMovement({ ...input, declaredAccrualAmount: "14.39" }),
      /below the effective policy accrual 14\.4000/,
    );
    assert.equal(
      computePlanMovement({ ...input, declaredAccrualAmount: "14.40" }).movements[0]!.amount,
      "14.4000",
    );
    assert.equal(
      computePlanMovement({ ...input, declaredAccrualAmount: "2500.81" }).movements[0]!.amount,
      "2500.8100",
    );
  }
});

test("warn: the accrual is still recorded and the breach is reported", () => {
  const result = computePlanMovement(
    move({
      plan: plan({ capBehavior: "warn" }),
      openingBalance: "3900.0000",
      earnings: "5000.0000", // 4% = 200.00 → 4,100 against a 4,000 cap
      limit: limit(),
    }),
  );
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0]!.amount, "200.0000");
  assert.equal(result.closingBalance, "4100.0000");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.kind, "over_limit");
  assert.equal(result.warnings[0]!.balance, "4100.0000");
  assert.equal(result.warnings[0]!.threshold, "4000.0000");
});

test("block: the run refuses the employee rather than breaching the cap", () => {
  assert.throws(
    () =>
      computePlanMovement(
        move({
          plan: plan({ capBehavior: "block" }),
          openingBalance: "3900.0000",
          earnings: "5000.0000",
          limit: limit(),
        }),
      ),
    (error: unknown) => error instanceof PayrollError && /BANK-OT/.test((error as Error).message),
  );
});

test("auto_payout: the bank lands exactly on the cap and the excess is paid", () => {
  const result = computePlanMovement(
    move({
      plan: plan({ capBehavior: "auto_payout" }),
      openingBalance: "3900.0000",
      earnings: "5000.0000",
      limit: limit(),
    }),
  );
  assert.equal(result.movements.length, 2);
  assert.equal(result.movements[0]!.kind, "accrual");
  assert.equal(result.movements[0]!.amount, "200.0000");
  assert.equal(result.movements[1]!.kind, "payout");
  assert.equal(result.movements[1]!.amount, "-100.0000");
  assert.equal(result.movements[1]!.hours, null);
  assert.equal(result.movements[1]!.componentId, "cmp-payout");
  assert.equal(result.closingBalance, "4000.0000");
  // The ledger is the balance: the movements must sum to the closing figure.
  assert.equal(result.movements.reduce((acc, m) => Number(acc) + Number(m.amount), 0) + 3900, 4000);
});

test("an hours cap auto-payout retains the paid hours on its movement", () => {
  const result = computePlanMovement(
    move({
      plan: plan({
        unit: "hours",
        accrualMethod: "fixed_per_period",
        accrualValue: "2.0000",
        capBehavior: "auto_payout",
      }),
      openingBalance: "7.0000",
      limit: limit({ maxBalance: "8.0000", notifyBalance: null }),
    }),
  );
  assert.deepEqual(
    result.movements.map(({ kind, amount, hours }) => ({ kind, amount, hours })),
    [
      { kind: "accrual", amount: "2.0000", hours: null },
      { kind: "payout", amount: "-1.0000", hours: "1.0000" },
    ],
  );
  assert.equal(result.closingBalance, "8.0000");
});

test("landing exactly on the cap is not a breach", () => {
  const result = computePlanMovement(
    move({
      plan: plan({ capBehavior: "block" }),
      openingBalance: "3800.0000",
      earnings: "5000.0000", // 4% = 200.00 → exactly 4,000
      limit: limit({ notifyBalance: null }),
    }),
  );
  assert.equal(result.closingBalance, "4000.0000");
  assert.deepEqual(result.warnings, []);
});

test("notify threshold warns without blocking anything", () => {
  const result = computePlanMovement(
    move({
      openingBalance: "3400.0000",
      earnings: "5000.0000", // → 3,600, past the 3,500 notify but under the cap
      limit: limit(),
    }),
  );
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.kind, "near_limit");
  assert.equal(result.warnings[0]!.threshold, "3500.0000");
});

test("an over-limit breach is reported once, not twice", () => {
  const result = computePlanMovement(
    move({
      openingBalance: "3900.0000",
      earnings: "5000.0000",
      limit: limit(),
    }),
  );
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.kind, "over_limit");
});

test("no limit row means no ceiling", () => {
  const result = computePlanMovement(
    move({
      plan: plan({ capBehavior: "block" }),
      openingBalance: "99000.0000",
      earnings: "5000.0000",
      limit: null,
    }),
  );
  assert.equal(result.closingBalance, "99200.0000");
  assert.deepEqual(result.warnings, []);
});

/* ------------------------------------------------------------------ */
/* Negative (owe) balances — benefit recoup during leave               */
/* ------------------------------------------------------------------ */

const recoup = plan({
  id: "plan-owe",
  code: "BEN-RECOUP",
  name: "Benefit recoup",
  direction: "owe",
  accrualMethod: "fixed_per_period",
  accrualValue: "100.0000",
  capBehavior: "warn",
});

test("owe: each period repays the scheduled amount toward zero", () => {
  const result = computePlanMovement(
    move({
      plan: recoup,
      openingBalance: "-1200.0000",
    }),
  );
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0]!.kind, "repayment");
  assert.equal(result.movements[0]!.amount, "100.0000");
  assert.equal(result.movements[0]!.componentId, "cmp-payout");
  assert.equal(result.closingBalance, "-1100.0000");
});

test("owe: the final period repays the remainder, never more", () => {
  const result = computePlanMovement(
    move({
      plan: recoup,
      openingBalance: "-40.0000",
    }),
  );
  assert.equal(result.movements[0]!.amount, "40.0000");
  assert.equal(result.closingBalance, "0.0000");
});

test("owe: a settled debt stops moving — no overshoot into a credit", () => {
  const settled = computePlanMovement(move({ plan: recoup, openingBalance: "0.0000" }));
  assert.deepEqual(settled.movements, []);
  assert.equal(settled.closingBalance, "0.0000");

  // Defensive: a positive balance on an 'owe' plan must not be "repaid" either.
  const positive = computePlanMovement(move({ plan: recoup, openingBalance: "25.0000" }));
  assert.deepEqual(positive.movements, []);
  assert.equal(positive.closingBalance, "25.0000");
});

test("owe: a 1,200 debt at 100 a period settles in exactly 12 periods", () => {
  let balance = "-1200.0000";
  let periods = 0;
  while (Number(balance) < 0 && periods < 50) {
    balance = computePlanMovement(move({ plan: recoup, openingBalance: balance })).closingBalance;
    periods++;
  }
  assert.equal(periods, 12);
  assert.equal(balance, "0.0000");
});

test("owe: caps do not apply — the balance is bounded by zero", () => {
  const result = computePlanMovement(
    move({
      plan: plan({ ...recoup, capBehavior: "block" }),
      openingBalance: "-500.0000",
      limit: limit({ maxBalance: "0.0000", notifyBalance: null }),
    }),
  );
  assert.equal(result.movements[0]!.amount, "100.0000");
  assert.deepEqual(result.warnings, []);
});

/* ------------------------------------------------------------------ */
/* Service tiers                                                       */
/* ------------------------------------------------------------------ */

test("calendar service preserves anniversary, month-end, leap-year and prehire boundaries", () => {
  for (const [hired, on, expected] of [
    ["2025-01-15", "2026-01-14", 11],
    ["2025-01-15", "2026-01-15", 12],
    ["2025-01-15", "2026-01-16", 12],
    ["2026-03-02", "2026-06-01", 2],
    ["2026-03-02", "2026-06-02", 3],
    ["2026-01-31", "2026-02-27", 0],
    ["2026-01-31", "2026-02-28", 1],
    ["2028-01-31", "2028-02-28", 0],
    ["2028-01-31", "2028-02-29", 1],
    ["2026-06-01", "2026-05-01", -1],
  ] as const)
    assert.equal(monthsOfService(hired, on), expected, `${hired} on ${on}`);
});
test("ACT/365 credited service retains fractional evidence at a tier boundary", () => {
  const baseline = {
    id: "credit",
    convention: "actual_365" as const,
    asOfDate: "2026-09-26",
    creditedDays: "1824.9999999999999999",
    creditedMonths: null,
    sourceSnapshot: { source: "observed" },
  };
  const before = computeEmploymentServiceCredit(baseline, baseline.asOfDate);
  const after = computeEmploymentServiceCredit(baseline, "2026-09-27");
  assert.equal(before.completedMonths, 59);
  assert.equal(meetsServiceYears(before, 5), false);
  assert.equal(meetsServiceYears(after, 5), true);
  assert.equal(after.serviceDays, "1825.9999999999999999");
  assert.equal(serviceCreditMilestoneDate(baseline, 60), "2026-09-27");
  assert.throws(
    () => computeEmploymentServiceCredit({ ...baseline, creditedDays: "1e3" }, baseline.asOfDate),
    /Credited service/,
  );
});
test("calendar months accept a mid-month start with whole credited months", () => {
  const baseline = {
    id: "credit",
    convention: "calendar_months" as const,
    asOfDate: "2018-04-02",
    creditedDays: null,
    creditedMonths: 89,
    sourceSnapshot: { source: "observed" },
  };
  const credit = computeEmploymentServiceCredit(baseline, "2025-09-02");
  assert.equal(credit.serviceDays, null);
  assert.equal(credit.completedMonths, 178);
  assert.equal(meetsServiceYears(credit, 7), true);
  // Only truly invalid input refuses, with the remedy naming the convention.
  assert.throws(
    () => computeEmploymentServiceCredit({ ...baseline, creditedMonths: 88.5 }, baseline.asOfDate),
    /whole months by anniversary/,
  );
  assert.throws(
    () => computeEmploymentServiceCredit({ ...baseline, creditedMonths: -1 }, baseline.asOfDate),
    /whole months by anniversary/,
  );
  assert.throws(
    () => computeEmploymentServiceCredit({ ...baseline, creditedDays: "0" }, baseline.asOfDate),
    /cannot carry credited days/,
  );
});
test("vacation progression preserves a separately granted higher personal rate", () => {
  const result = computePlanMovement(
    move({
      plan: plan({ systemKey: "vacation" }),
      earnings: "3000.0000",
      employeeAccrualValue: "11.0000",
      serviceAccrualValue: "9.0000",
    }),
  );
  assert.equal(result.movements[0]!.amount, "330.0000");
});

const vacationLadder: ServiceTierRow[] = [
  {
    id: "t0",
    planId: "plan-vac",
    componentId: null,
    afterMonths: 0,
    accrualValue: "4.0000",
    eligible: null,
    isActive: true,
  },
  {
    id: "t5",
    planId: "plan-vac",
    componentId: null,
    afterMonths: 60,
    accrualValue: "6.0000",
    eligible: null,
    isActive: true,
  },
  {
    id: "t10",
    planId: "plan-vac",
    componentId: null,
    afterMonths: 120,
    accrualValue: "8.0000",
    eligible: null,
    isActive: true,
  },
  {
    id: "t15",
    planId: "plan-vac",
    componentId: null,
    afterMonths: 180,
    accrualValue: "10.0000",
    eligible: null,
    isActive: true,
  },
];

test("service ladder: the highest rung reached wins, at the boundary month", () => {
  assert.equal(pickServiceTier(vacationLadder, 59)!.accrualValue, "4.0000");
  assert.equal(pickServiceTier(vacationLadder, 60)!.accrualValue, "6.0000");
  assert.equal(pickServiceTier(vacationLadder, 119)!.accrualValue, "6.0000");
  assert.equal(pickServiceTier(vacationLadder, 120)!.accrualValue, "8.0000");
  assert.equal(pickServiceTier(vacationLadder, 600)!.accrualValue, "10.0000");
});

test("service ladder: inactive rungs are skipped, negative service reaches none", () => {
  const withRetired = vacationLadder.map((row) =>
    row.id === "t10" ? { ...row, isActive: false } : row,
  );
  assert.equal(pickServiceTier(withRetired, 120)!.accrualValue, "6.0000");
  assert.equal(pickServiceTier(vacationLadder, -1), null);
});

test("service tiers resolve plan rates and component eligibility together", () => {
  const rows: ServiceTierRow[] = [
    ...vacationLadder,
    {
      id: "b",
      planId: null,
      componentId: "cmp-benefits",
      afterMonths: 3,
      accrualValue: null,
      eligible: true,
      isActive: true,
    },
    {
      id: "r",
      planId: null,
      componentId: "cmp-rrsp",
      afterMonths: 12,
      accrualValue: null,
      eligible: true,
      isActive: true,
    },
  ];
  const atSixMonths = resolveServiceTiersFrom(rows, 6, "2025-01-01");
  assert.equal(atSixMonths.planAccrualValues.get("plan-vac"), "4.0000");
  assert.equal(atSixMonths.componentEligibility.get("cmp-benefits"), true);
  assert.equal(atSixMonths.componentEligibility.has("cmp-rrsp"), false);

  const atSixYears = resolveServiceTiersFrom(rows, 72, "2020-01-01");
  assert.equal(atSixYears.planAccrualValues.get("plan-vac"), "6.0000");
  assert.equal(atSixYears.componentEligibility.get("cmp-rrsp"), true);
});

test("legal-employer service ladder overrides the default without leaking to another employer", () => {
  const rows = [
    ...vacationLadder,
    ...vacationLadder.slice(0, 2).map((row) => ({
      ...row,
      id: `employer-${row.id}`,
      employerSubsidiaryId: "employer-a",
      accrualValue: "7.0000",
    })),
  ];
  assert.equal(
    resolveServiceTiersFrom(rows, 120, "2016-01-01", "employer-a").planAccrualValues.get(
      "plan-vac",
    ),
    "7.0000",
  );
  assert.equal(
    resolveServiceTiersFrom(rows, 120, "2016-01-01", "employer-b").planAccrualValues.get(
      "plan-vac",
    ),
    "8.0000",
  );
  assert.equal(
    resolveServiceTiersFrom(rows.slice(4), 120, "2016-01-01", "employer-b").planAccrualValues.size,
    0,
  );
});

test("no hire date on file resolves no tiers at all", () => {
  const resolved = resolveServiceTiersFrom(vacationLadder, null, null);
  assert.equal(resolved.planAccrualValues.size, 0);
  assert.equal(resolved.componentEligibility.size, 0);
});

test("a reached rung overrides the plan's base accrual value", () => {
  // 6% at five years on 3,000 of vacationable earnings = 180.00, not 120.00.
  const base = computePlanMovement(move({ earnings: "3000.0000" }));
  assert.equal(base.movements[0]!.amount, "120.0000");
  const tiered = computePlanMovement(
    move({
      earnings: "3000.0000",
      serviceAccrualValue: "6.0000",
    }),
  );
  assert.equal(tiered.movements[0]!.amount, "180.0000");
});

test("rate precedence: service rung > per-employee rate > plan base", () => {
  for (const [personal, tier, expected] of [
    [null, null, "120.0000"],
    ["5.0000", null, "150.0000"],
    ["5.0000", "8.0000", "240.0000"],
  ] as const) {
    const result = computePlanMovement(
      move({ earnings: "3000.0000", employeeAccrualValue: personal, serviceAccrualValue: tier }),
    );
    assert.equal(result.movements[0]!.amount, expected, `personal ${personal}, tier ${tier}`);
  }
});

/* ------------------------------------------------------------------ */
/* Scope precedence — identical to labor_cost_rates                    */
/* ------------------------------------------------------------------ */

test("scope precedence: employee > job title > trade > department > subsidiary > plan", () => {
  const rows: EntitlementLimitRow[] = [
    limitRow({ id: "plan-default", maxBalance: "1000.0000" }),
    limitRow({ id: "sub", subsidiaryId: "sub-1", maxBalance: "2000.0000" }),
    limitRow({ id: "dept", departmentId: "dept-field", maxBalance: "3000.0000" }),
    limitRow({ id: "trade", tradeId: "trade-electrical", maxBalance: "4000.0000" }),
    limitRow({ id: "title", jobTitle: "Foreman", maxBalance: "5000.0000" }),
    limitRow({ id: "emp", employeePartyId: "emp-1", maxBalance: "6000.0000" }),
  ];
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-06-30")!.id, "emp");
  assert.equal(pickPlanLimit(rows.slice(0, 5), EMPLOYEE, "2026-06-30")!.id, "title");
  assert.equal(pickPlanLimit(rows.slice(0, 4), EMPLOYEE, "2026-06-30")!.id, "trade");
  assert.equal(pickPlanLimit(rows.slice(0, 3), EMPLOYEE, "2026-06-30")!.id, "dept");
  assert.equal(pickPlanLimit(rows.slice(0, 2), EMPLOYEE, "2026-06-30")!.id, "sub");
  assert.equal(pickPlanLimit(rows.slice(0, 1), EMPLOYEE, "2026-06-30")!.scope, "plan");
});

test("scope precedence: the trade/foreman/super configuration this replaces", () => {
  const rows: EntitlementLimitRow[] = [
    limitRow({
      id: "trades",
      jobTitle: "Tradesperson",
      maxBalance: "4000.0000",
      notifyBalance: "3500.0000",
    }),
    limitRow({
      id: "foremen",
      jobTitle: "Foreman",
      maxBalance: "5000.0000",
      notifyBalance: "4500.0000",
    }),
    limitRow({
      id: "supers",
      jobTitle: "Superintendent",
      maxBalance: "6000.0000",
      notifyBalance: "5500.0000",
    }),
  ];
  const forRole = (jobTitle: string) =>
    pickPlanLimit(rows, { ...EMPLOYEE, jobTitle }, "2026-06-30");
  assert.equal(forRole("Tradesperson")!.maxBalance, "4000.0000");
  assert.equal(forRole("Foreman")!.maxBalance, "5000.0000");
  assert.equal(forRole("Superintendent")!.maxBalance, "6000.0000");
  // Job titles are free text on employee_roles; matching is case-insensitive.
  assert.equal(forRole("FOREMAN")!.maxBalance, "5000.0000");
  assert.equal(forRole("Apprentice"), null);
});

test("scope precedence: within a scope the latest effective row wins", () => {
  const rows: EntitlementLimitRow[] = [
    limitRow({
      id: "old",
      tradeId: "trade-electrical",
      maxBalance: "4000.0000",
      effectiveFrom: "2024-01-01",
    }),
    limitRow({
      id: "new",
      tradeId: "trade-electrical",
      maxBalance: "4500.0000",
      effectiveFrom: "2026-01-01",
    }),
  ];
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-06-30")!.maxBalance, "4500.0000");
  // History is not reinterpreted: a 2025 run still sees the 2024 ceiling.
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2025-06-30")!.maxBalance, "4000.0000");
});

test("scope precedence: a more specific row wins even when it is older", () => {
  const rows: EntitlementLimitRow[] = [
    limitRow({
      id: "trade",
      tradeId: "trade-electrical",
      maxBalance: "4000.0000",
      effectiveFrom: "2026-05-01",
    }),
    limitRow({
      id: "emp",
      employeePartyId: "emp-1",
      maxBalance: "9000.0000",
      effectiveFrom: "2020-01-01",
    }),
  ];
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-06-30")!.id, "emp");
});

test("scope precedence: ended and inactive rows drop out", () => {
  const rows: EntitlementLimitRow[] = [
    limitRow({
      id: "ended",
      employeePartyId: "emp-1",
      maxBalance: "9000.0000",
      effectiveTo: "2026-03-31",
    }),
    limitRow({ id: "inactive", jobTitle: "Foreman", maxBalance: "5000.0000", isActive: false }),
    limitRow({ id: "trade", tradeId: "trade-electrical", maxBalance: "4000.0000" }),
  ];
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-06-30")!.id, "trade");
  // Before the end date the employee row is still the most specific one.
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-03-31")!.id, "ended");
});

test("scope precedence: another employee's row never leaks across", () => {
  const rows = [limitRow({ id: "other", employeePartyId: "emp-2", maxBalance: "9000.0000" })];
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-06-30"), null);
});

test("limitScopeOf names the scope a stored row occupies", () => {
  assert.equal(limitScopeOf(limitRow()), "plan");
  assert.equal(limitScopeOf(limitRow({ subsidiaryId: "s" })), "subsidiary");
  assert.equal(limitScopeOf(limitRow({ departmentId: "d" })), "department");
  assert.equal(limitScopeOf(limitRow({ tradeId: "t" })), "trade");
  assert.equal(limitScopeOf(limitRow({ jobTitle: "Foreman" })), "job_title");
  assert.equal(limitScopeOf(limitRow({ employeePartyId: "e" })), "employee");
});

/* ------------------------------------------------------------------ */
/* The vacation case the migration has to reproduce                    */
/* ------------------------------------------------------------------ */

test("a vacation plan accrues four percent of eligible earnings", () => {
  // payroll-run.ts computes mulPercent(vacationableEarnings, percent, 2) and
  // stores it on pay_stubs.vacation_accrued. The plan engine must agree to the
  // cent or the replay verification fails.
  const vacation = plan({
    id: "plan-vac",
    code: "VAC",
    name: "Vacation",
    accrualMethod: "percent_of_earnings",
    accrualValue: "4.0000",
    capBehavior: "warn",
  });
  for (const earnings of ["0.0000", "1234.5600", "2884.6200", "17.7700", "999999.9900"]) {
    const result = computePlanMovement(move({ plan: vacation, earnings }));
    // The literal expression from calculateStub's vacation block.
    assert.equal(result.closingBalance, mulPercent(earnings, "4.0000", 2));
  }
});

test(
  "a prior-year opening and current-year bank movements retain one lifetime balance per employee",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const fresh = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${fresh}, ${fx.orgId}, 'person', 'New bank participant', true, '{}'::jsonb)`);
      const planId = (
        await db.execute<{ id: string }>(
          sql`select id from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!.id;
      await saveEntitlementOpenings({
        orgId: fx.orgId,
        actorId: fx.actorId,
        movementDate: "2025-01-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { [planId]: "1250.55" } }],
      });
      await db.transaction(async (tx) => {
        const movements = [
          { employeePartyId: fx.employeeId, movementDate: "2026-01-16", amount: "115.38" },
          { employeePartyId: fx.employeeId, movementDate: "2026-01-30", amount: "115.38" },
          { employeePartyId: fx.employeeId, movementDate: "2026-01-30", amount: "-500" },
          { employeePartyId: fresh, movementDate: "2026-01-16", amount: "88" },
          { employeePartyId: fresh, movementDate: "2026-01-30", amount: "88" },
        ].map((movement) => ({
          ...movement,
          planId,
          kind: "adjustment" as const,
          componentId: null,
          hours: null,
          note: "Documented bank balance adjustment",
        }));
        assert.equal(
          await recordEntitlementMovements(tx, {
            orgId: fx.orgId,
            actorId: fx.actorId,
            payRunDocumentId: null,
            movements,
          }),
          5,
        );
      });
      const carried = await entitlementBalances(fx.orgId, fx.employeeId, "2026-01-31");
      const newlyAccrued = await entitlementBalances(fx.orgId, fresh, "2026-01-31");
      assert.equal(carried.find((balance) => balance.plan.id === planId)!.balance, "981.3100");
      assert.equal(newlyAccrued.find((balance) => balance.plan.id === planId)!.balance, "176.0000");
      assert.equal(
        (await entitlementBalances(fx.orgId, fx.employeeId, "2025-12-31")).find(
          (balance) => balance.plan.id === planId,
        )!.balance,
        "1250.5500",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test("an hours-denominated bank keeps whole hours, not dollars", () => {
  // A statutory time-off-in-lieu bank: 1.5 banked hours per overtime hour.
  const toil = plan({
    id: "plan-toil",
    code: "TOIL",
    unit: "hours",
    accrualMethod: "per_hour_worked",
    accrualValue: "1.5000",
  });
  const result = computePlanMovement(move({ plan: toil, hours: "12.00" }));
  assert.equal(result.movements[0]!.amount, "18.0000");
  assert.equal(result.movements[0]!.hours, "12.0000");
});
