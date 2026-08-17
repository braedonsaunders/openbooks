import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import {
  legacyVacationBalances,
  projectedBalances,
} from "../../scripts/migrate-vacation-to-entitlements.ts";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";
import {
  computePlanMovement,
  limitScopeOf,
  monthsOfService,
  pickPlanLimit,
  pickServiceTier,
  resolveServiceTiersFrom,
  type EntitlementLimitRow,
  type EntitlementPlan,
  type EntitlementPlanLimit,
  type ServiceTierRow,
} from "./payroll-entitlements.ts";
import { mulPercent } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";

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

const move = (over: Record<string, unknown> = {}) => ({
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
  const result = computePlanMovement(move({
    plan: plan({ accrualMethod: "per_hour_worked", accrualValue: "0.0577" }),
    hours: "86.50",
  }));
  // 0.0577 × 86.50 = 4.99105 → 4.99
  assert.equal(result.movements[0]!.amount, "4.9900");
  assert.equal(result.movements[0]!.hours, "86.5000");
});

test("fixed-per-period and manual plans", () => {
  assert.equal(
    computePlanMovement(move({
      plan: plan({ accrualMethod: "fixed_per_period", accrualValue: "125.0000" }),
    })).movements[0]!.amount,
    "125.0000",
  );
  const manual = computePlanMovement(move({
    plan: plan({ accrualMethod: "manual", accrualValue: null }),
    earnings: "5000.0000",
  }));
  assert.deepEqual(manual.movements, []);
  assert.equal(manual.closingBalance, "0.0000");
});

/* ------------------------------------------------------------------ */
/* Cap behaviours                                                      */
/* ------------------------------------------------------------------ */

test("warn: the accrual is still recorded and the breach is reported", () => {
  const result = computePlanMovement(move({
    plan: plan({ capBehavior: "warn" }),
    openingBalance: "3900.0000",
    earnings: "5000.0000", // 4% = 200.00 → 4,100 against a 4,000 cap
    limit: limit(),
  }));
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
    () => computePlanMovement(move({
      plan: plan({ capBehavior: "block" }),
      openingBalance: "3900.0000",
      earnings: "5000.0000",
      limit: limit(),
    })),
    (error: unknown) => error instanceof PayrollError && /BANK-OT/.test((error as Error).message),
  );
});

test("auto_payout: the bank lands exactly on the cap and the excess is paid", () => {
  const result = computePlanMovement(move({
    plan: plan({ capBehavior: "auto_payout" }),
    openingBalance: "3900.0000",
    earnings: "5000.0000",
    limit: limit(),
  }));
  assert.equal(result.movements.length, 2);
  assert.equal(result.movements[0]!.kind, "accrual");
  assert.equal(result.movements[0]!.amount, "200.0000");
  assert.equal(result.movements[1]!.kind, "payout");
  assert.equal(result.movements[1]!.amount, "-100.0000");
  assert.equal(result.movements[1]!.componentId, "cmp-payout");
  assert.equal(result.closingBalance, "4000.0000");
  // The ledger is the balance: the movements must sum to the closing figure.
  assert.equal(
    result.movements.reduce((acc, m) => Number(acc) + Number(m.amount), 0) + 3900,
    4000,
  );
});

test("landing exactly on the cap is not a breach", () => {
  const result = computePlanMovement(move({
    plan: plan({ capBehavior: "block" }),
    openingBalance: "3800.0000",
    earnings: "5000.0000", // 4% = 200.00 → exactly 4,000
    limit: limit({ notifyBalance: null }),
  }));
  assert.equal(result.closingBalance, "4000.0000");
  assert.deepEqual(result.warnings, []);
});

test("notify threshold warns without blocking anything", () => {
  const result = computePlanMovement(move({
    openingBalance: "3400.0000",
    earnings: "5000.0000", // → 3,600, past the 3,500 notify but under the cap
    limit: limit(),
  }));
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.kind, "near_limit");
  assert.equal(result.warnings[0]!.threshold, "3500.0000");
});

test("an over-limit breach is reported once, not twice", () => {
  const result = computePlanMovement(move({
    openingBalance: "3900.0000",
    earnings: "5000.0000",
    limit: limit(),
  }));
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.kind, "over_limit");
});

test("no limit row means no ceiling", () => {
  const result = computePlanMovement(move({
    plan: plan({ capBehavior: "block" }),
    openingBalance: "99000.0000",
    earnings: "5000.0000",
    limit: null,
  }));
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
  const result = computePlanMovement(move({
    plan: recoup, openingBalance: "-1200.0000",
  }));
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0]!.kind, "repayment");
  assert.equal(result.movements[0]!.amount, "100.0000");
  assert.equal(result.movements[0]!.componentId, "cmp-payout");
  assert.equal(result.closingBalance, "-1100.0000");
});

test("owe: the final period repays the remainder, never more", () => {
  const result = computePlanMovement(move({
    plan: recoup, openingBalance: "-40.0000",
  }));
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
  const result = computePlanMovement(move({
    plan: plan({ ...recoup, capBehavior: "block" }),
    openingBalance: "-500.0000",
    limit: limit({ maxBalance: "0.0000", notifyBalance: null }),
  }));
  assert.equal(result.movements[0]!.amount, "100.0000");
  assert.deepEqual(result.warnings, []);
});

/* ------------------------------------------------------------------ */
/* Service tiers                                                       */
/* ------------------------------------------------------------------ */

test("monthsOfService: the anniversary day decides — exactly 12 months", () => {
  assert.equal(monthsOfService("2025-01-15", "2026-01-14"), 11);
  assert.equal(monthsOfService("2025-01-15", "2026-01-15"), 12);
  assert.equal(monthsOfService("2025-01-15", "2026-01-16"), 12);
});

test("monthsOfService: three-month benefits eligibility boundary", () => {
  assert.equal(monthsOfService("2026-03-02", "2026-06-01"), 2);
  assert.equal(monthsOfService("2026-03-02", "2026-06-02"), 3);
});

test("monthsOfService: a month-end hire date clamps to the shorter month", () => {
  // Hired 31 January reaches one month on 28 February, not 3 March.
  assert.equal(monthsOfService("2026-01-31", "2026-02-27"), 0);
  assert.equal(monthsOfService("2026-01-31", "2026-02-28"), 1);
  // Leap year: February has a 29th, so the 28th is still short.
  assert.equal(monthsOfService("2028-01-31", "2028-02-28"), 0);
  assert.equal(monthsOfService("2028-01-31", "2028-02-29"), 1);
});

test("monthsOfService: dates before the hire date are negative, not zero", () => {
  assert.equal(monthsOfService("2026-06-01", "2026-05-01"), -1);
  assert.ok(monthsOfService("2026-06-01", "2026-05-01") < 0);
});

const vacationLadder: ServiceTierRow[] = [
  { id: "t0", planId: "plan-vac", componentId: null, afterMonths: 0, accrualValue: "4.0000", eligible: null, isActive: true },
  { id: "t5", planId: "plan-vac", componentId: null, afterMonths: 60, accrualValue: "6.0000", eligible: null, isActive: true },
  { id: "t10", planId: "plan-vac", componentId: null, afterMonths: 120, accrualValue: "8.0000", eligible: null, isActive: true },
  { id: "t15", planId: "plan-vac", componentId: null, afterMonths: 180, accrualValue: "10.0000", eligible: null, isActive: true },
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
    row.id === "t10" ? { ...row, isActive: false } : row);
  assert.equal(pickServiceTier(withRetired, 120)!.accrualValue, "6.0000");
  assert.equal(pickServiceTier(vacationLadder, -1), null);
});

test("service tiers resolve plan rates and component eligibility together", () => {
  const rows: ServiceTierRow[] = [
    ...vacationLadder,
    { id: "b", planId: null, componentId: "cmp-benefits", afterMonths: 3, accrualValue: null, eligible: true, isActive: true },
    { id: "r", planId: null, componentId: "cmp-rrsp", afterMonths: 12, accrualValue: null, eligible: true, isActive: true },
  ];
  const atSixMonths = resolveServiceTiersFrom(rows, 6, "2025-01-01");
  assert.equal(atSixMonths.planAccrualValues.get("plan-vac"), "4.0000");
  assert.equal(atSixMonths.componentEligibility.get("cmp-benefits"), true);
  assert.equal(atSixMonths.componentEligibility.has("cmp-rrsp"), false);

  const atSixYears = resolveServiceTiersFrom(rows, 72, "2020-01-01");
  assert.equal(atSixYears.planAccrualValues.get("plan-vac"), "6.0000");
  assert.equal(atSixYears.componentEligibility.get("cmp-rrsp"), true);
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
  const tiered = computePlanMovement(move({
    earnings: "3000.0000", serviceAccrualValue: "6.0000",
  }));
  assert.equal(tiered.movements[0]!.amount, "180.0000");
});

test("rate precedence: service rung > per-employee rate > plan base", () => {
  const base = move({ earnings: "3000.0000" });
  assert.equal(computePlanMovement(base).movements[0]!.amount, "120.0000"); // 4%
  assert.equal(
    computePlanMovement({ ...base, employeeAccrualValue: "5.0000" }).movements[0]!.amount,
    "150.0000",
  );
  assert.equal(
    computePlanMovement({
      ...base, employeeAccrualValue: "5.0000", serviceAccrualValue: "8.0000",
    }).movements[0]!.amount,
    "240.0000",
  );
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
    limitRow({ id: "trades", jobTitle: "Tradesperson", maxBalance: "4000.0000", notifyBalance: "3500.0000" }),
    limitRow({ id: "foremen", jobTitle: "Foreman", maxBalance: "5000.0000", notifyBalance: "4500.0000" }),
    limitRow({ id: "supers", jobTitle: "Superintendent", maxBalance: "6000.0000", notifyBalance: "5500.0000" }),
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
    limitRow({ id: "old", tradeId: "trade-electrical", maxBalance: "4000.0000", effectiveFrom: "2024-01-01" }),
    limitRow({ id: "new", tradeId: "trade-electrical", maxBalance: "4500.0000", effectiveFrom: "2026-01-01" }),
  ];
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-06-30")!.maxBalance, "4500.0000");
  // History is not reinterpreted: a 2025 run still sees the 2024 ceiling.
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2025-06-30")!.maxBalance, "4000.0000");
});

test("scope precedence: a more specific row wins even when it is older", () => {
  const rows: EntitlementLimitRow[] = [
    limitRow({ id: "trade", tradeId: "trade-electrical", maxBalance: "4000.0000", effectiveFrom: "2026-05-01" }),
    limitRow({ id: "emp", employeePartyId: "emp-1", maxBalance: "9000.0000", effectiveFrom: "2020-01-01" }),
  ];
  assert.equal(pickPlanLimit(rows, EMPLOYEE, "2026-06-30")!.id, "emp");
});

test("scope precedence: ended and inactive rows drop out", () => {
  const rows: EntitlementLimitRow[] = [
    limitRow({ id: "ended", employeePartyId: "emp-1", maxBalance: "9000.0000", effectiveTo: "2026-03-31" }),
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

test("a vacation plan reproduces the legacy 4%-of-vacationable accrual", () => {
  // payroll-run.ts computes mulPercent(vacationableEarnings, percent, 2) and
  // stores it on pay_stubs.vacation_accrued. The plan engine must agree to the
  // cent or the replay verification fails.
  const vacation = plan({
    id: "plan-vac", code: "VAC", name: "Vacation",
    accrualMethod: "percent_of_earnings", accrualValue: "4.0000",
    capBehavior: "warn",
  });
  for (const earnings of ["0.0000", "1234.5600", "2884.6200", "17.7700", "999999.9900"]) {
    const result = computePlanMovement(move({ plan: vacation, earnings }));
    // The literal expression from calculateStub's vacation block.
    assert.equal(result.closingBalance, mulPercent(earnings, "4.0000", 2));
  }
});

test("the vacation replay is the legacy expression, term for term", () => {
  // scripts/migrate-vacation-to-entitlements.ts proves per-employee equality
  // against real tenant data. This is the structural half of that control: the
  // two sides must keep reading the SAME three sources with the SAME signs, so
  // nobody can quietly "fix" one of them and make the tie-out pass vacuously.
  const script = readFileSync("scripts/migrate-vacation-to-entitlements.ts", "utf8");
  const legacy = script.slice(
    script.indexOf("async function legacyVacationBalances"),
    script.indexOf("async function ensureVacationPlan"),
  );
  const projected = script.slice(
    script.indexOf("async function projectedBalances"),
    script.indexOf("async function employeeNames"),
  );
  for (const term of [
    /b\.vacation_balance/,           // the carry-in
    /sum\(s\.vacation_accrued\)|s\.vacation_accrued/, // committed accruals
    /system_key = 'vacation_payout'/, // committed payouts
    /r\.run_status = 'committed'/,    // only committed runs count on both sides
  ]) {
    assert.match(legacy, term);
    assert.match(projected, term);
  }
  // The legacy expression SUBTRACTS payouts; the ledger stores them negative.
  assert.match(legacy, /-\s*coalesce\(\(select sum\(l\.amount\)/);
  assert.match(projected, /select s\.employee_party_id, -l\.amount as amount/);
  // Neither side may drift onto uncommitted runs or a materialized balance.
  assert.equal(/entitlement_ledger/.test(projected), false);
});

test(
  "the migration ties out for the population it exists to protect: a prior-year "
  + "opening balance with current-year stubs",
  { skip: !DB },
  async () => {
    // THE case the script's tie-out is for, and the one it could not answer
    // deterministically: a converted tenant, where the employee's opening
    // balance sits in the conversion year and their stubs are in the year
    // after. The population CTE emitted TWO rows for that employee — one
    // carrying the opening balance, one reading zero — the outer select
    // computed a different balance for each, and `new Map(rows.map(...))` kept
    // whichever Postgres returned last, with no ORDER BY to decide. So the
    // penny-exact verification flipped between "with opening balance" and
    // "without" from run to run, on exactly the tenants it was written for.
    //
    // (This replaces a test that computed both sides of `opening + accruals -
    // payouts` from the same literals with the same helpers and asserted that
    // `sum` is associative. It touched neither the migration nor the ledger and
    // could not fail for any payroll reason.)
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const payoutComponentId = randomUUID();
      await db.execute(sql`
        insert into pay_components (id, org_id, code, name, kind, system_key, is_active,
                                    created_by, updated_by)
        values (${payoutComponentId}, ${org.orgId}, 'VACPAY', 'Vacation payout', 'earning',
                'vacation_payout', true, ${actorId}, ${actorId})`);

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year,
                                   anchor_period_end, pay_date_offset_days, is_active,
                                   created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);

      const employee = async (name: string): Promise<string> => {
        const id = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${id}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
        return id;
      };
      // Converted: conversion-year opening balance, following-year stubs.
      const carried = await employee("Carried Over");
      // Hired after conversion: stubs only, no opening row at all.
      const fresh = await employee("Fresh Hire");

      await db.execute(sql`
        insert into payroll_opening_balances (org_id, employee_party_id, tax_year, vacation_balance)
        values (${org.orgId}, ${carried}, 2025, '1250.5500')`);

      const committedRun = async (
        payDate: string,
        rows: { employeePartyId: string; accrued: string; payout: string }[],
      ): Promise<void> => {
        const documentId = randomUUID();
        await db.execute(sql`
          insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                                 currency, status, created_by, updated_by)
          values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${payDate}`},
                  ${org.subsidiaryId}, ${payDate}, 'CAD', 'approved', ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                                pay_date, tax_year, run_status, created_by, updated_by)
          values (${documentId}, ${org.orgId}, ${scheduleId}, ${payDate}, ${payDate}, ${payDate},
                  2026, 'committed', ${actorId}, ${actorId})`);
        for (const row of rows) {
          const stubId = randomUUID();
          await db.execute(sql`
            insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                                   periods_per_year, pay_date, tax_year, currency_code,
                                   vacation_accrued, created_by, updated_by)
            values (${stubId}, ${org.orgId}, ${documentId}, ${row.employeePartyId}, 'ON', 26,
                    ${payDate}, 2026, 'CAD', ${row.accrued}, ${actorId}, ${actorId})`);
          if (row.payout !== "0") {
            await db.execute(sql`
              insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                          created_by, updated_by)
              values (${org.orgId}, ${stubId}, ${payoutComponentId}, 'earning', 'Vacation payout',
                      ${row.payout}, ${actorId}, ${actorId})`);
          }
        }
      };

      await committedRun("2026-01-16", [
        { employeePartyId: carried, accrued: "115.3800", payout: "0" },
        { employeePartyId: fresh, accrued: "88.0000", payout: "0" },
      ]);
      await committedRun("2026-01-30", [
        { employeePartyId: carried, accrued: "115.3800", payout: "500.0000" },
        { employeePartyId: fresh, accrued: "88.0000", payout: "0" },
      ]);

      const legacy = await legacyVacationBalances(org.orgId);
      const projected = await projectedBalances(org.orgId);

      // One row per employee, always. Under the UNION population this call
      // threw on `carried` (two rows) instead of quietly picking one.
      assert.equal(legacy.size, 2);

      // The converted employee's carry-in is IN the balance — the branch the
      // coin-flip used to drop. 1250.55 + 115.38 + 115.38 - 500.00
      assert.equal(legacy.get(carried), "981.3100");
      assert.equal(legacy.get(fresh), "176.0000");

      // And the ledger the migration would write reproduces it to the penny,
      // which is the only claim the script actually makes.
      for (const [employeePartyId, balance] of legacy) {
        assert.equal(projected.get(employeePartyId)?.balance, balance);
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test("an hours-denominated bank keeps whole hours, not dollars", () => {
  // A statutory time-off-in-lieu bank: 1.5 banked hours per overtime hour.
  const toil = plan({
    id: "plan-toil", code: "TOIL", unit: "hours",
    accrualMethod: "per_hour_worked", accrualValue: "1.5000",
  });
  const result = computePlanMovement(move({ plan: toil, hours: "12.00" }));
  assert.equal(result.movements[0]!.amount, "18.0000");
  assert.equal(result.movements[0]!.hours, "12.0000");
});
