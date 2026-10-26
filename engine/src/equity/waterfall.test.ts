import assert from "node:assert/strict";
import test from "node:test";
import { EquityError } from "./errors.ts";
import { parseMoney, rational, type Rational } from "./quantities.ts";
import {
  runWaterfall,
  type WaterfallAward,
  type WaterfallClass,
  type WaterfallConvertible,
} from "./waterfall.ts";

const ONE = rational(1n);

function common(shares: bigint, holder = "founder"): WaterfallClass {
  return {
    shareClassId: "common",
    code: "CS",
    kind: "common",
    seniority: 0,
    liquidationMultiple: rational(0n),
    participation: "none",
    participationCapMultiple: null,
    originalIssuePrice: null,
    conversionRatio: ONE,
    holdings: [{ securityId: `s-${holder}`, holderPartyId: holder, shares }],
  };
}

function preferred(
  overrides: Partial<WaterfallClass> & Pick<WaterfallClass, "shareClassId">,
  shares: bigint,
  holder: string,
): WaterfallClass {
  return {
    code: overrides.shareClassId.toUpperCase(),
    kind: "preferred",
    seniority: 1,
    liquidationMultiple: ONE,
    participation: "none",
    participationCapMultiple: null,
    originalIssuePrice: rational(1n),
    conversionRatio: ONE,
    holdings: [{ securityId: `s-${holder}`, holderPartyId: holder, shares }],
    ...overrides,
  };
}

function run(
  exit: string,
  classes: WaterfallClass[],
  awards: WaterfallAward[] = [],
  convertibles: WaterfallConvertible[] = [],
) {
  return runWaterfall({
    exitValue: parseMoney(exit, "price"),
    classes,
    awards,
    convertibles,
    minorUnitScale: 2,
  });
}

const amountOf = (result: ReturnType<typeof run>, holder: string) =>
  result.holders.find((row) => row.holderPartyId === holder)?.amount;
const total = (result: ReturnType<typeof run>): Rational => {
  let units = 0n;
  for (const payout of result.payouts) units += BigInt(payout.amount.replace(".", ""));
  units += BigInt(result.unallocated.replace(".", ""));
  return rational(units, 10_000n);
};

test("non-participating preferred takes its preference at a low exit and converts at a high one", () => {
  const classes = [common(4_000_000n), preferred({ shareClassId: "a" }, 1_000_000n, "fund")];
  const low = run("2000000", classes);
  assert.equal(amountOf(low, "fund"), "1000000.0000");
  assert.equal(amountOf(low, "founder"), "1000000.0000");
  assert.equal(low.classes.find((row) => row.shareClassId === "a")!.converted, false);
  const high = run("10000000", classes);
  assert.equal(amountOf(high, "fund"), "2000000.0000");
  assert.equal(amountOf(high, "founder"), "8000000.0000");
  assert.equal(high.classes.find((row) => row.shareClassId === "a")!.converted, true);
});

test("fully participating preferred takes its preference and then its share of the rest", () => {
  const result = run("2000000", [
    common(4_000_000n),
    preferred({ shareClassId: "a", participation: "full" }, 1_000_000n, "fund"),
  ]);
  assert.equal(amountOf(result, "fund"), "1200000.0000");
  assert.equal(amountOf(result, "founder"), "800000.0000");
});

test("capped participation stops at the cap and the excess goes to common", () => {
  const capped = preferred(
    { shareClassId: "a", participation: "capped", participationCapMultiple: rational(2n) },
    1_000_000n,
    "fund",
  );
  const mid = run("6000000", [common(4_000_000n), capped]);
  assert.equal(amountOf(mid, "fund"), "2000000.0000");
  assert.equal(amountOf(mid, "founder"), "4000000.0000");
  // Far above the cap, converting (20%) pays more than the 2x cap.
  const high = run("20000000", [common(4_000_000n), capped]);
  assert.equal(amountOf(high, "fund"), "4000000.0000");
  assert.equal(high.classes.find((row) => row.shareClassId === "a")!.converted, true);
});

test("senior preferred is paid before junior preferred, pro rata within a tier when short", () => {
  const seniorA = preferred(
    { shareClassId: "b", seniority: 2, originalIssuePrice: rational(2n) },
    1_000_000n,
    "b-fund",
  );
  const juniorA = preferred({ shareClassId: "a", seniority: 1 }, 1_000_000n, "a-fund");
  const result = run("2500000", [common(1_000_000n), juniorA, seniorA]);
  assert.equal(amountOf(result, "b-fund"), "2000000.0000");
  assert.equal(amountOf(result, "a-fund"), "500000.0000");
  assert.equal(amountOf(result, "founder"), "0.0000");
  const tier = run("1500000", [
    common(1_000_000n),
    preferred({ shareClassId: "a", seniority: 1 }, 1_000_000n, "a-fund"),
    preferred(
      { shareClassId: "b", seniority: 1, originalIssuePrice: rational(2n) },
      1_000_000n,
      "b-fund",
    ),
  ]);
  assert.equal(amountOf(tier, "a-fund"), "500000.0000");
  assert.equal(amountOf(tier, "b-fund"), "1000000.0000");
});

test("options share the residual only while in the money, net of their exercise price", () => {
  const option: WaterfallAward = {
    securityId: "o-1",
    holderPartyId: "employee",
    shareClassId: "common",
    shares: 100_000n,
    strike: rational(5n),
  };
  const low = run("1000000", [common(1_000_000n)], [option]);
  assert.equal(amountOf(low, "employee"), "0.0000");
  assert.equal(amountOf(low, "founder"), "1000000.0000");
  const high = run("11000000", [common(1_000_000n)], [option]);
  // Price (11M + 0.5M) / 1.1M = 10.4545…; option nets 100,000 × (price − 5).
  assert.equal(amountOf(high, "employee"), "545454.5500");
  assert.equal(amountOf(high, "founder"), "10454545.4500");
  assert.equal(high.pricePerCommonShare, "10.4545454545");
});

test("notes are paid first as debt and SAFEs rank with the most junior preference", () => {
  const convertibles: WaterfallConvertible[] = [
    {
      securityId: "n-1",
      holderPartyId: "lender",
      kind: "note",
      amount: parseMoney("500000", "price"),
    },
    {
      securityId: "safe-1",
      holderPartyId: "angel",
      kind: "safe",
      amount: parseMoney("1000000", "price"),
    },
  ];
  const result = run(
    "1500000",
    [common(4_000_000n), preferred({ shareClassId: "a" }, 1_000_000n, "fund")],
    [],
    convertibles,
  );
  assert.equal(amountOf(result, "lender"), "500000.0000");
  assert.equal(amountOf(result, "angel"), "500000.0000");
  assert.equal(amountOf(result, "fund"), "500000.0000");
});

test("payouts round to the currency's minor unit and always sum to the exit value", () => {
  const classes = [
    common(3n, "a"),
    {
      ...common(3n, "b"),
      holdings: [
        { securityId: "s-b", holderPartyId: "b", shares: 3n },
        { securityId: "s-c", holderPartyId: "c", shares: 3n },
      ],
    },
  ];
  const result = run("100", [
    { ...classes[0]!, holdings: [...classes[0]!.holdings, ...classes[1]!.holdings] },
  ]);
  assert.deepEqual(result.holders.map((row) => row.amount).sort(), [
    "33.3300",
    "33.3300",
    "33.3400",
  ]);
  assert.equal(total(result).numerator, 100n);
});

test("a negative exit refuses", () => {
  assert.throws(
    () =>
      runWaterfall({
        exitValue: rational(-1n),
        classes: [],
        awards: [],
        convertibles: [],
        minorUnitScale: 2,
      }),
    EquityError,
  );
});

test("a capped SAFE takes the greater of its cash-out amount and its conversion amount", () => {
  const safe: WaterfallConvertible = {
    securityId: "safe",
    holderPartyId: "angel",
    kind: "safe",
    amount: parseMoney("1000000", "price"),
    cap: parseMoney("10000000", "price"),
    postMoney: true,
  };
  // Converting, the post-money SAFE owns 1,000,000 / 10,000,000 of a 10,000,000-share liquidity capitalization.
  const low = run("5000000", [common(9_000_000n)], [], [safe]);
  assert.equal(
    amountOf(low, "angel"),
    "1000000.0000",
    "below the cap the cash-out amount pays more",
  );
  assert.equal(low.safes[0]!.converted, false);
  assert.equal(amountOf(low, "founder"), "4000000.0000");
  const high = run("50000000", [common(9_000_000n)], [], [safe]);
  assert.equal(
    amountOf(high, "angel"),
    "5000000.0000",
    "above the cap the conversion amount pays more",
  );
  assert.equal(high.safes[0]!.converted, true);
  assert.equal(high.safes[0]!.shares, "1000000.0000000000");
  assert.equal(amountOf(high, "founder"), "45000000.0000");
  const uncapped = run("50000000", [common(9_000_000n)], [], [{ ...safe, cap: null }]);
  assert.equal(
    amountOf(uncapped, "angel"),
    "1000000.0000",
    "an uncapped SAFE has no liquidity price and takes its cash-out amount",
  );
  assert.deepEqual(total(high), rational(50_000_000n), "the payouts sum to the exit value");
});

test("a pre-money SAFE converting at liquidity prices its shares on the capitalization before it", () => {
  const safe: WaterfallConvertible = {
    securityId: "safe",
    holderPartyId: "angel",
    kind: "safe",
    amount: parseMoney("1000000", "price"),
    cap: parseMoney("9000000", "price"),
    postMoney: false,
  };
  // Liquidity price 9,000,000 / 9,000,000 = 1.00: 1,000,000 shares beside the founder's 9,000,000.
  const result = run("100000000", [common(9_000_000n)], [], [safe]);
  assert.equal(amountOf(result, "angel"), "10000000.0000");
  assert.equal(amountOf(result, "founder"), "90000000.0000");
});
