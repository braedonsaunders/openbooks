import assert from "node:assert/strict";
import test from "node:test";
import { modelRoundFromBook, waterfallFromBook } from "./models.ts";
import type { EquityBook, SecurityRecord, ShareClassRecord } from "./types.ts";

const COMMON: ShareClassRecord = {
  id: "c-common",
  code: "CS",
  name: "Common",
  kind: "common",
  effectiveOn: "2024-01-01",
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

function security(
  overrides: Partial<SecurityRecord> & Pick<SecurityRecord, "id" | "kind" | "holderPartyId">,
): SecurityRecord {
  return {
    securityNumber: overrides.id.toUpperCase(),
    shareClassId: COMMON.id,
    planId: null,
    roundId: null,
    sourceSecurityId: null,
    issueDate: "2024-01-01",
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

const USD = new Map([["USD", "1"]]);

function book(securities: SecurityRecord[]): EquityBook {
  return {
    classes: [COMMON],
    amendments: [],
    splits: [],
    plans: [],
    reserveChanges: [],
    rounds: [],
    securities,
    events: [],
    securityAmendments: [],
  };
}

const founder = security({
  id: "s-founder",
  kind: "share",
  holderPartyId: "founder",
  quantity: 900_000n,
});
const option = security({
  id: "o-employee",
  kind: "option",
  holderPartyId: "employee",
  quantity: 100_000n,
  pricePerShare: "0.0000000000",
  vestingStart: "2024-01-01",
  vestingMonths: 48,
  cliffMonths: 12,
  vestingFrequency: "monthly",
  optionType: "nso",
  acceleration: "single",
  accelerationPercent: "100.0000",
});

test("cancelling unvested awards at exit keeps only vested units unless the acceleration clause fires", () => {
  const scenario = {
    asOf: "2025-01-01",
    exitValue: "1000000",
    unvestedAwards: "cancel" as const,
    terminated: false,
    minorUnitScale: 2,
    currency: "USD",
  };
  // One year in: 25,000 of the 100,000 options are vested; they share 1,000,000 with 900,000 common shares.
  const plain = waterfallFromBook(
    book([founder, option]),
    { ...scenario, changeOfControl: false },
    USD,
  );
  assert.equal(plain.holders.find((row) => row.holderPartyId === "employee")?.amount, "27027.0300");
  const accelerated = waterfallFromBook(
    book([founder, option]),
    { ...scenario, changeOfControl: true },
    USD,
  );
  assert.equal(
    accelerated.holders.find((row) => row.holderPartyId === "employee")?.amount,
    "100000.0000",
  );
  assert.equal(
    accelerated.holders.find((row) => row.holderPartyId === "founder")?.amount,
    "900000.0000",
  );
});

test("every outstanding award takes part when unvested awards participate", () => {
  const result = waterfallFromBook(
    book([founder, option]),
    {
      asOf: "2025-01-01",
      exitValue: "1000000",
      unvestedAwards: "participate",
      changeOfControl: false,
      terminated: false,
      minorUnitScale: 2,
      currency: "USD",
    },
    USD,
  );
  assert.equal(
    result.holders.find((row) => row.holderPartyId === "employee")?.amount,
    "100000.0000",
  );
});

test("the round model reads the book on its date and converts the SAFEs outstanding then", () => {
  const safe = security({
    id: "safe-1",
    kind: "safe",
    holderPartyId: "angel",
    shareClassId: null,
    quantity: null,
    considerationAmount: "500000.0000",
    issueDate: "2024-06-01",
    safeType: "post_money",
    valuationCap: "5000000.0000",
  });
  const current = book([founder, option, safe]);
  const before = modelRoundFromBook(
    current,
    {
      asOf: "2024-05-31",
      preMoneyValuation: "10000000",
      investment: "2000000",
      targetPoolPercent: null,
      currency: "USD",
    },
    USD,
  );
  assert.equal(before.conversions.length, 0, "the SAFE was not yet issued");
  const after = modelRoundFromBook(
    current,
    {
      asOf: "2024-06-30",
      preMoneyValuation: "10000000",
      investment: "2000000",
      targetPoolPercent: null,
      currency: "USD",
    },
    USD,
  );
  assert.equal(after.conversions.length, 1);
  assert.equal(after.conversions[0]!.pricedBy, "cap");
  // A post-money cap of 5,000,000 for 500,000 promises 10% of the capitalization including its own shares.
  const capitalization = 1_000_000n + BigInt(after.conversions[0]!.shares);
  assert.ok(BigInt(after.conversions[0]!.shares) * 10n <= capitalization);
  const angel = after.dilution.find((row) => row.key === "angel");
  assert.equal(angel?.sharesAfter, after.conversions[0]!.shares);
});

test("shares a SAFE or note converted into carry the amount they converted as their preference, not the round price", () => {
  // The Series Seed: 3,000,000 new-money shares at 1.20, and 2,061,433 shares the
  // seed SAFE, the MFN SAFE and the note converted into for 1,763,479.45.
  const seedClass: ShareClassRecord = {
    ...COMMON,
    id: "c-seed",
    code: "SEED",
    name: "Series Seed Preferred",
    kind: "preferred",
    initialAuthorizedShares: 6_000_000n,
    originalIssuePrice: "1.2000000000",
    initialConversionPrice: "1.2000000000",
    liquidationMultiple: "1.0000",
    seniority: 1,
    conversionShareClassId: COMMON.id,
    liquidationPreferenceBasis: "amount_paid",
  };
  const seed = (id: string, holderPartyId: string, quantity: bigint, considerationAmount: string) =>
    security({
      id,
      kind: "share",
      holderPartyId,
      shareClassId: seedClass.id,
      issueDate: "2024-06-28",
      quantity,
      considerationAmount,
    });
  const seedShares = [
    seed("seed-lead", "lead", 2_500_000n, "3000000.0000"),
    seed("seed-pro-rata", "seed-investor", 500_000n, "600000.0000"),
    seed("seed-safe", "seed-investor", 1_169_590n, "1000000.0000"),
    seed("seed-mfn", "angel", 292_397n, "250000.0000"),
    seed("seed-note", "note-holder", 599_446n, "513479.4500"),
  ];
  const common = security({
    id: "s-common",
    kind: "share",
    holderPartyId: "founder",
    quantity: 8_100_000n,
  });
  const scenario = {
    asOf: "2024-07-01",
    exitValue: "5363479.45",
    unvestedAwards: "participate" as const,
    changeOfControl: false,
    terminated: false,
    minorUnitScale: 2,
    currency: "USD",
  };
  const onAmountPaid: EquityBook = {
    ...book([common, ...seedShares]),
    classes: [COMMON, seedClass],
  };
  const result = waterfallFromBook(onAmountPaid, scenario, USD);
  const seedRow = result.classes.find((row) => row.code === "SEED")!;
  assert.equal(
    seedRow.preferenceEntitlement,
    "5363479.4500",
    "the preference is the invested amount",
  );
  assert.equal(seedRow.converted, false);
  assert.equal(
    result.payouts.find((row) => row.securityId === "seed-safe")?.amount,
    "1000000.0000",
    "each certificate's preference is what it paid",
  );
  assert.equal(result.payouts.find((row) => row.securityId === "seed-note")?.amount, "513479.4500");
  const onIssuePrice: EquityBook = {
    ...onAmountPaid,
    classes: [COMMON, { ...seedClass, liquidationPreferenceBasis: "original_issue_price" }],
  };
  assert.equal(
    waterfallFromBook(onIssuePrice, scenario, USD).classes.find((row) => row.code === "SEED")!
      .preferenceEntitlement,
    "6073719.6000",
    "the original issue price basis overstates it by 710,240.15",
  );
});
