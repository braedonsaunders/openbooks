import assert from "node:assert/strict";
import test from "node:test";
import { blackScholesCall } from "./black-scholes.ts";
import { cumulativeCompensation, totalCompensation } from "./compensation.ts";
import { EquityError } from "./errors.ts";
import { formatMoney } from "./quantities.ts";
import type { SecurityEventRecord, SecurityRecord, SplitRecord } from "./types.ts";

function award(overrides: Partial<SecurityRecord> = {}): SecurityRecord {
  return {
    id: "o-1",
    securityNumber: "OPT-1",
    kind: "option",
    holderPartyId: "employee",
    shareClassId: "common",
    planId: "plan",
    roundId: null,
    sourceSecurityId: null,
    issueDate: "2024-01-01",
    quantity: 4800n,
    pricePerShare: "1.0000000000",
    considerationAmount: null,
    currency: "USD",
    vestingStart: "2024-01-01",
    vestingMonths: 48,
    cliffMonths: 12,
    vestingFrequency: "monthly",
    vestingTranches: null,
    acceleration: "none",
    accelerationPercent: null,
    expirationDate: "2034-01-01",
    optionType: "iso",
    earlyExercise: false,
    safeType: null,
    valuationCap: null,
    discountPercent: null,
    interestRatePercent: null,
    interestBasis: null,
    maturityDate: null,
    fairValuePerUnit: "1.0000000000",
    expenseAttribution: "straight_line",
    interestDayCount: null,
    mfn: false,
    unvestedRepurchaseBasis: null,
    fxRate: "1",
    ...overrides,
  };
}

const event = (
  overrides: Partial<SecurityEventRecord> & Pick<SecurityEventRecord, "kind" | "effectiveOn">,
): SecurityEventRecord => ({
  id: `e-${overrides.kind}-${overrides.effectiveOn}`,
  securityId: "o-1",
  quantity: null,
  pricePerShare: null,
  amount: null,
  resultingSecurityId: null,
  roundId: null,
  reversesEventId: null,
  ...overrides,
});

const cost = (
  security: SecurityRecord,
  through: string,
  events: SecurityEventRecord[] = [],
  splits: SplitRecord[] = [],
) =>
  formatMoney(
    cumulativeCompensation({ events, splits, securities: [security] }, security, through),
  );

test("straight-line cost accrues by day but never trails the value already vested", () => {
  const security = award();
  assert.equal(cost(security, "2023-12-31"), "0.0000");
  // 182 of 1,461 days.
  assert.equal(cost(security, "2024-07-01"), "597.9466");
  // On the cliff the straight line (366 / 1,461 of the cost) is already ahead of the 1,200 vested units.
  assert.equal(cost(security, "2025-01-01"), "1202.4641");
  assert.equal(cost(security, "2028-01-01"), "4800.0000");
  assert.equal(cost(security, "2030-01-01"), "4800.0000");
});

test("the vested floor binds when installments are front-loaded", () => {
  const tranches = award({
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    quantity: 1000n,
    vestingTranches: [
      { date: "2024-02-01", quantity: 900n },
      { date: "2028-01-01", quantity: 100n },
    ],
  });
  // The line would give 31 / 1,461 of 1,000; the 900 units vested on the day set the floor.
  assert.equal(cost(tranches, "2024-02-01"), "900.0000");
});

test("graded attribution front-loads cost: each installment is its own award", () => {
  const security = award({
    expenseAttribution: "graded",
    vestingMonths: 24,
    cliffMonths: 0,
    vestingFrequency: "annual",
    quantity: 2000n,
  });
  // Installments of 1,000 on 2025-01-01 and 2026-01-01; at 2024-07-01: 1000 × 182/366 + 1000 × 182/731.
  assert.equal(cost(security, "2024-07-01"), "746.2418");
  assert.equal(cost(security, "2025-01-01"), "1500.6840");
  assert.equal(cost(security, "2026-01-01"), "2000.0000");
});

test("forfeiting unvested units reverses the cost recognized for them", () => {
  const security = award();
  // 560 of 1,461 days recognized the day before the forfeiture.
  assert.equal(cost(security, "2025-07-14"), "1839.8357");
  const forfeit = [event({ kind: "forfeit", effectiveOn: "2025-07-15", quantity: 3000n })];
  // Vested by then: 18 months = 1,800 units; the 3,000 unvested units leave the award.
  assert.equal(cost(security, "2025-07-15", forfeit), "1800.0000");
  assert.equal(
    formatMoney(
      totalCompensation(
        { events: forfeit, splits: [], securities: [security] },
        security,
        "2025-07-15",
      ),
    ),
    "1800.0000",
  );
});

test("cancelling unvested units without replacement recognizes their remaining cost at once", () => {
  const security = award();
  const cancel = [event({ kind: "cancel", effectiveOn: "2025-07-01", quantity: 3000n })];
  assert.equal(cost(security, "2025-07-01", cancel), "4800.0000");
});

test("expiry and exercise change nothing; a void reverses everything", () => {
  const security = award();
  const exercised = [
    event({
      kind: "exercise",
      effectiveOn: "2025-02-01",
      quantity: 500n,
      resultingSecurityId: "s",
    }),
  ];
  assert.equal(cost(security, "2025-07-01", exercised), cost(security, "2025-07-01"));
  const voided = [event({ kind: "void", effectiveOn: "2025-07-01" })];
  assert.equal(cost(security, "2025-06-30", voided), cost(security, "2025-06-30"));
  assert.equal(cost(security, "2025-07-01", voided), "0.0000");
});

test("a forfeiture stated after a split is measured in issue units", () => {
  const security = award();
  const splits: SplitRecord[] = [
    {
      id: "sp",
      shareClassId: "common",
      effectiveOn: "2025-03-01",
      ratioNumerator: 2n,
      ratioDenominator: 1n,
    },
  ];
  const forfeit = [event({ kind: "forfeit", effectiveOn: "2025-07-15", quantity: 6000n })];
  assert.equal(cost(security, "2025-07-15", forfeit, splits), "1800.0000");
});

test("a non-compensatory security carries no cost", () => {
  assert.equal(
    cost(
      award({ kind: "warrant", fairValuePerUnit: null, expenseAttribution: null }),
      "2030-01-01",
    ),
    "0.0000",
  );
});

test("Black-Scholes matches published values to ten places", () => {
  const value = (overrides: Partial<Parameters<typeof blackScholesCall>[0]>) =>
    blackScholesCall({
      sharePrice: "100",
      exercisePrice: "100",
      volatilityPercent: "20",
      riskFreeRatePercent: "5",
      expectedTermYears: "1",
      dividendYieldPercent: "0",
      ...overrides,
    });
  assert.equal(value({}).fairValue, "10.4505835722");
  assert.equal(
    value({
      sharePrice: "42",
      exercisePrice: "40",
      riskFreeRatePercent: "10",
      expectedTermYears: "0.5",
    }).fairValue,
    "4.7594223929",
  );
  // With a dividend yield the share leg is discounted: S·e^(−qT)·N(d1) − K·e^(−rT)·N(d2).
  assert.equal(value({ dividendYieldPercent: "3" }).fairValue, "8.6525285539");
  // A zero exercise price is worth the discounted share.
  assert.equal(
    value({ exercisePrice: "0", dividendYieldPercent: "0" }).fairValue,
    "100.0000000000",
  );
  // Deep in the money: S − K·e^(−rT).
  assert.equal(
    value({
      exercisePrice: "1",
      volatilityPercent: "5",
      riskFreeRatePercent: "1",
      expectedTermYears: "0.01",
    }).fairValue,
    "99.0000999950",
  );
});

test("Black-Scholes refuses inputs it cannot price", () => {
  const refuses = (overrides: Partial<Parameters<typeof blackScholesCall>[0]>) =>
    assert.throws(
      () =>
        blackScholesCall({
          sharePrice: "1",
          exercisePrice: "1",
          volatilityPercent: "50",
          riskFreeRatePercent: "4",
          expectedTermYears: "5",
          dividendYieldPercent: "0",
          ...overrides,
        }),
      EquityError,
    );
  refuses({ sharePrice: "0" });
  refuses({ volatilityPercent: "0" });
  refuses({ expectedTermYears: "0" });
  refuses({ dividendYieldPercent: "-1" });
  refuses({ sharePrice: "1e3" });
});
