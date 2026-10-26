import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizedShares,
  buildCapTable,
  classCommitted,
  conversionRatio,
  holdingState,
  planPool,
} from "./cap-table.ts";
import { EquityError } from "./errors.ts";
import { formatPrice } from "./quantities.ts";
import type {
  EquityBook,
  PlanRecord,
  SecurityEventRecord,
  SecurityRecord,
  ShareClassRecord,
} from "./types.ts";

const COMMON: ShareClassRecord = {
  id: "c-common",
  code: "CS",
  name: "Common",
  kind: "common",
  effectiveOn: "2023-01-01",
  initialAuthorizedShares: 20_000_000n,
  parValue: "0.0001",
  originalIssuePrice: null,
  initialConversionPrice: null,
  liquidationMultiple: null,
  participation: "none",
  participationCapMultiple: null,
  seniority: 0,
  antiDilution: "none",
  conversionShareClassId: null,
  conversionAdjustsForSplits: true,
  liquidationPreferenceBasis: "original_issue_price",
};
const SERIES_A: ShareClassRecord = {
  id: "c-a",
  code: "A",
  name: "Series A Preferred",
  kind: "preferred",
  effectiveOn: "2024-01-01",
  initialAuthorizedShares: 3_000_000n,
  parValue: "0.0001",
  originalIssuePrice: "2.0000000000",
  initialConversionPrice: "2.0000000000",
  liquidationMultiple: "1.0000",
  participation: "none",
  participationCapMultiple: null,
  seniority: 1,
  antiDilution: "broad_based",
  conversionShareClassId: "c-common",
  conversionAdjustsForSplits: true,
  liquidationPreferenceBasis: "original_issue_price",
};
const PLAN: PlanRecord = {
  id: "p-2023",
  code: "EIP",
  name: "Equity incentive plan",
  shareClassId: COMMON.id,
  effectiveOn: "2023-01-01",
  initialReservedShares: 1_000_000n,
  recycleForfeited: true,
  recycleExpired: false,
  recycleRepurchased: true,
};

function security(
  overrides: Partial<SecurityRecord> & Pick<SecurityRecord, "id" | "kind" | "holderPartyId">,
): SecurityRecord {
  return {
    securityNumber: overrides.id.toUpperCase(),
    shareClassId: COMMON.id,
    planId: null,
    roundId: null,
    sourceSecurityId: null,
    issueDate: "2023-01-01",
    quantity: 1000n,
    pricePerShare: null,
    considerationAmount: null,
    currency: "USD",
    vestingStart: null,
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    vestingTranches: null,
    acceleration: "none",
    accelerationPercent: null,
    expirationDate: null,
    optionType: null,
    earlyExercise: false,
    safeType: null,
    valuationCap: null,
    discountPercent: null,
    interestRatePercent: null,
    interestBasis: null,
    maturityDate: null,
    fairValuePerUnit: null,
    expenseAttribution: null,
    interestDayCount: null,
    mfn: false,
    unvestedRepurchaseBasis: null,
    fxRate: "1",
    ...overrides,
  };
}

function event(
  overrides: Partial<SecurityEventRecord> &
    Pick<SecurityEventRecord, "id" | "securityId" | "kind" | "effectiveOn">,
): SecurityEventRecord {
  return {
    quantity: null,
    pricePerShare: null,
    amount: null,
    resultingSecurityId: null,
    roundId: null,
    reversesEventId: null,
    ...overrides,
  };
}

function book(overrides: Partial<EquityBook> = {}): EquityBook {
  return {
    classes: [COMMON, SERIES_A],
    amendments: [],
    splits: [],
    plans: [PLAN],
    reserveChanges: [],
    rounds: [],
    securities: [
      security({
        id: "s-founder-1",
        kind: "share",
        holderPartyId: "founder-1",
        quantity: 4_000_000n,
      }),
      security({
        id: "s-founder-2",
        kind: "share",
        holderPartyId: "founder-2",
        quantity: 4_000_000n,
      }),
      security({
        id: "s-a-1",
        kind: "share",
        holderPartyId: "fund",
        shareClassId: SERIES_A.id,
        issueDate: "2024-01-01",
        quantity: 1_000_000n,
        pricePerShare: "2.0000000000",
      }),
      security({
        id: "o-1",
        kind: "option",
        holderPartyId: "employee",
        planId: PLAN.id,
        issueDate: "2023-06-01",
        quantity: 480_000n,
        pricePerShare: "0.5000000000",
        vestingStart: "2023-06-01",
        vestingMonths: 48,
        cliffMonths: 12,
        vestingFrequency: "monthly",
        optionType: "iso",
      }),
    ],
    events: [],
    securityAmendments: [],
    ...overrides,
  };
}

test("the cap table counts outstanding shares as converted and adds awards and the unallocated pool fully diluted", () => {
  const table = buildCapTable(book(), "2024-06-30");
  assert.equal(table.totals.outstanding, "9000000");
  assert.equal(table.totals.asConvertedOutstanding, "9000000");
  assert.equal(table.totals.awardsOutstanding, "480000");
  assert.equal(table.totals.poolAvailable, "520000");
  assert.equal(table.totals.fullyDiluted, "10000000");
  const fund = table.holders.find((holder) => holder.holderPartyId === "fund")!;
  assert.equal(fund.outstandingPercent, "11.1111");
  assert.equal(fund.fullyDilutedPercent, "10.0000");
  const employee = table.holders.find((holder) => holder.holderPartyId === "employee")!;
  assert.equal(employee.options, "480000");
  assert.equal(employee.vestedAwards, "120000");
  const classA = table.classes.find((row) => row.code === "A")!;
  assert.equal(classA.conversionRatio, "1.0000000000");
  assert.equal(classA.fullyDilutedPercent, "10.0000");
});

test("on the holder basis the unallocated pool is its own line, so holders and the pool make up the fully diluted total", () => {
  const table = buildCapTable(book(), "2024-06-30");
  assert.deepEqual(table.unallocatedPool, {
    fullyDiluted: "520000",
    fullyDilutedPercent: "5.2000",
  });
  const holders = table.holders.reduce((sum, holder) => sum + BigInt(holder.fullyDiluted), 0n);
  assert.equal(
    holders + BigInt(table.unallocatedPool.fullyDiluted),
    BigInt(table.totals.fullyDiluted),
  );
  const classes = table.classes.reduce((sum, row) => sum + BigInt(row.fullyDiluted), 0n);
  assert.equal(
    holders + BigInt(table.unallocatedPool.fullyDiluted),
    classes,
    "the holder basis totals what the class basis totals",
  );
  const percent = [
    ...table.holders.map((holder) => holder.fullyDilutedPercent),
    table.unallocatedPool.fullyDilutedPercent,
  ].reduce((sum, value) => sum + BigInt(value.replace(".", "")), 0n);
  assert.equal(percent, 1_000_000n, "the fully diluted percentages sum to 100%");
});

test("a security issued after the as-of date is not on the table", () => {
  const table = buildCapTable(book(), "2023-12-31");
  assert.equal(table.totals.outstanding, "8000000");
  assert.equal(
    table.classes.some((row) => row.code === "A"),
    false,
  );
});

test("exercises consume vested units, forfeitures return unvested units to the pool", () => {
  const events = [
    event({
      id: "e-1",
      securityId: "o-1",
      kind: "exercise",
      effectiveOn: "2024-07-01",
      quantity: 100_000n,
      resultingSecurityId: "s-ex",
    }),
    event({
      id: "e-2",
      securityId: "o-1",
      kind: "forfeit",
      effectiveOn: "2024-08-01",
      quantity: 300_000n,
    }),
  ];
  const exercised = security({
    id: "s-ex",
    kind: "share",
    holderPartyId: "employee",
    sourceSecurityId: "o-1",
    issueDate: "2024-07-01",
    quantity: 100_000n,
  });
  const current = book({ events, securities: [...book().securities, exercised] });
  const option = current.securities.find((row) => row.id === "o-1")!;
  const state = holdingState(current, option, "2024-08-01");
  assert.equal(state.consumed.exercise, 100_000n);
  assert.equal(state.outstanding, 80_000n);
  assert.equal(state.vestedAvailable, 40_000n);
  const pool = planPool(current, PLAN, "2024-08-01");
  assert.equal(pool.returned, 300_000n);
  assert.equal(pool.available, 820_000n);
  const table = buildCapTable(current, "2024-08-01");
  assert.equal(table.totals.outstanding, "9100000");
  assert.equal(table.totals.fullyDiluted, "10000000");
});

test("expirations stay out of the pool when the plan does not recycle them; repurchased exercise shares return", () => {
  const exercised = security({
    id: "s-ex",
    kind: "share",
    holderPartyId: "employee",
    sourceSecurityId: "o-1",
    issueDate: "2024-07-01",
    quantity: 100_000n,
  });
  const events = [
    event({
      id: "e-1",
      securityId: "o-1",
      kind: "exercise",
      effectiveOn: "2024-07-01",
      quantity: 100_000n,
      resultingSecurityId: "s-ex",
    }),
    event({
      id: "e-2",
      securityId: "o-1",
      kind: "expire",
      effectiveOn: "2024-08-01",
      quantity: 30_000n,
    }),
    event({
      id: "e-3",
      securityId: "s-ex",
      kind: "repurchase",
      effectiveOn: "2024-09-01",
      quantity: 40_000n,
    }),
  ];
  const current = book({ events, securities: [...book().securities, exercised] });
  const pool = planPool(current, PLAN, "2024-09-01");
  assert.equal(pool.returned, 40_000n);
  assert.equal(pool.available, 560_000n);
});

test("an event larger than the holding refuses instead of reading a negative position", () => {
  const events = [
    event({
      id: "e-1",
      securityId: "o-1",
      kind: "exercise",
      effectiveOn: "2024-01-01",
      quantity: 200_000n,
      resultingSecurityId: "x",
    }),
  ];
  const current = book({ events });
  assert.throws(
    () => buildCapTable(current, "2024-06-30"),
    (error: unknown) =>
      error instanceof EquityError && error.code === "equity_event_exceeds_holding",
  );
});

test("a split restates holdings, exercise prices, the pool and authorized shares from its date", () => {
  const split = {
    id: "sp-1",
    shareClassId: COMMON.id,
    effectiveOn: "2024-03-01",
    ratioNumerator: 2n,
    ratioDenominator: 1n,
  };
  const current = book({ splits: [split] });
  const before = buildCapTable(current, "2024-02-29");
  const after = buildCapTable(current, "2024-03-01");
  assert.equal(before.totals.outstanding, "9000000");
  assert.equal(after.totals.outstanding, "17000000");
  assert.equal(
    after.holdings.find((row) => row.securityId === "o-1")!.exercisePrice,
    "0.2500000000",
  );
  assert.equal(after.holdings.find((row) => row.securityId === "o-1")!.outstanding, "960000");
  assert.equal(after.plans[0]!.available, "1040000");
  assert.equal(authorizedShares(current, COMMON, "2024-03-01"), 40_000_000n);
  // A quantity recorded on the split date is already in post-split terms.
  const events = [
    event({
      id: "e-1",
      securityId: "o-1",
      kind: "exercise",
      effectiveOn: "2024-07-01",
      quantity: 200_000n,
      resultingSecurityId: "x",
    }),
  ];
  const exercised = holdingState(
    { ...current, events },
    current.securities.find((row) => row.id === "o-1")!,
    "2024-07-01",
  );
  assert.equal(exercised.outstanding, 760_000n);
  assert.equal(exercised.vestedAvailable, 60_000n);
});

test("a reverse split rounds each holding down to whole shares once", () => {
  const split = {
    id: "sp-1",
    shareClassId: COMMON.id,
    effectiveOn: "2024-03-01",
    ratioNumerator: 1n,
    ratioDenominator: 3n,
  };
  const odd = security({ id: "s-odd", kind: "share", holderPartyId: "angel", quantity: 1001n });
  const current = book({ splits: [split], securities: [odd] });
  assert.equal(holdingState(current, odd, "2024-03-01").outstanding, 333n);
});

test("a conversion price amendment changes the as-converted count of preferred shares", () => {
  const amendment = {
    id: "am-1",
    shareClassId: SERIES_A.id,
    kind: "conversion_price" as const,
    effectiveOn: "2024-05-01",
    authorizedShares: null,
    conversionShareClassId: null,
    conversionPrice: "1.6000000000",
    reason: "Down round adjustment",
  };
  const current = book({ amendments: [amendment] });
  assert.equal(formatPrice(conversionRatio(current, SERIES_A, "2024-05-01")), "1.2500000000");
  const table = buildCapTable(current, "2024-05-01");
  assert.equal(table.classes.find((row) => row.code === "A")!.asConvertedOutstanding, "1250000");
  assert.equal(table.totals.asConvertedOutstanding, "9250000");
});

test("a void removes the security from its void date onward and the award stops drawing on the pool", () => {
  const events = [
    event({ id: "e-void", securityId: "o-1", kind: "void", effectiveOn: "2024-02-01" }),
  ];
  const current = book({ events });
  assert.equal(buildCapTable(current, "2024-01-31").totals.awardsOutstanding, "480000");
  const after = buildCapTable(current, "2024-02-01");
  assert.equal(after.totals.awardsOutstanding, "0");
  assert.equal(after.plans[0]!.available, "1000000");
  assert.equal(after.holdings.find((row) => row.securityId === "o-1")!.status, "void");
});

test("committed shares of a class include outstanding awards and the unallocated pool", () => {
  assert.equal(classCommitted(book(), COMMON.id, "2024-06-30"), 9_000_000n);
});

test("convertibles report principal and accrued interest beside the table", () => {
  const note = security({
    id: "n-1",
    kind: "note",
    holderPartyId: "angel",
    shareClassId: null,
    quantity: null,
    considerationAmount: "100000.0000",
    issueDate: "2024-01-01",
    interestRatePercent: "8.0000",
    interestBasis: "simple",
    interestDayCount: "actual_365",
    valuationCap: "8000000.0000",
    discountPercent: "20.0000",
  });
  const table = buildCapTable(book({ securities: [...book().securities, note] }), "2024-12-31");
  const row = table.convertibles[0]!;
  assert.equal(row.status, "outstanding");
  assert.equal(row.accruedInterest, "8000.0000");
  assert.equal(row.convertingAmount, "108000.0000");
  assert.equal(table.totals.fullyDiluted, "10000000");
});

test("voiding the certificate an exercise produced returns its units to the option from the void date", () => {
  const exercised = security({
    id: "s-ex",
    kind: "share",
    holderPartyId: "employee",
    sourceSecurityId: "o-1",
    issueDate: "2024-07-01",
    quantity: 100_000n,
  });
  const events = [
    event({
      id: "e-1",
      securityId: "o-1",
      kind: "exercise",
      effectiveOn: "2024-07-01",
      quantity: 100_000n,
      resultingSecurityId: "s-ex",
    }),
    event({ id: "e-2", securityId: "s-ex", kind: "void", effectiveOn: "2024-07-10" }),
  ];
  const current = book({ events, securities: [...book().securities, exercised] });
  const option = current.securities.find((row) => row.id === "o-1")!;
  assert.equal(holdingState(current, option, "2024-07-09").outstanding, 380_000n);
  assert.equal(holdingState(current, option, "2024-07-10").outstanding, 480_000n);
  assert.equal(buildCapTable(current, "2024-07-10").totals.outstanding, "9000000");
});
