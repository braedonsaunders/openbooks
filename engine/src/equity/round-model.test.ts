import assert from "node:assert/strict";
import test from "node:test";
import {
  accruedInterest,
  convertAtRound,
  type ConvertibleTerms,
  type ConvertingInstrument,
} from "./convertibles.ts";
import { adjustedConversionPrice } from "./anti-dilution.ts";
import { EquityError } from "./errors.ts";
import { formatMoney, formatPrice, parseMoney, parsePrice, rational } from "./quantities.ts";
import { modelRound, type RoundModelInput } from "./round-model.ts";

function terms(
  overrides: Partial<ConvertibleTerms> & Pick<ConvertibleTerms, "id">,
): ConvertibleTerms {
  return {
    kind: "safe",
    issueDate: "2024-01-01",
    principal: "1000000.0000",
    safeType: "pre_money",
    valuationCap: null,
    discountPercent: null,
    interestRatePercent: null,
    interestBasis: null,
    interestDayCount: null,
    currency: "USD",
    ...overrides,
  };
}
const instrument = (t: ConvertibleTerms): ConvertingInstrument => ({
  terms: t,
  amount: parseMoney(t.principal, "principal"),
});

function model(overrides: Partial<RoundModelInput> = {}) {
  return modelRound({
    preMoneyValuation: "10000000.0000",
    investment: "2000000.0000",
    targetPoolPercent: null,
    fullyDilutedBefore: 10_000_000n,
    outstandingBefore: 9_000_000n,
    poolAvailableBefore: 0n,
    convertibles: [],
    convertibleHolders: new Map(),
    protectedClasses: [],
    holdersBefore: new Map([["founder", 10_000_000n]]),
    ...overrides,
  });
}

test("a note accrues simple interest on Actual/365 and compound interest on each anniversary", () => {
  const simple = terms({
    id: "n",
    kind: "note",
    safeType: null,
    principal: "100000.0000",
    interestRatePercent: "8",
    interestBasis: "simple",
    interestDayCount: "actual_365",
  });
  assert.equal(formatMoney(accruedInterest(simple, "2024-07-01")), "3989.0411");
  const compound = { ...simple, interestBasis: "compound_annual" as const };
  // Two full years at 8% then 182 days: 100000 × 1.08² × (1 + 0.08 × 182/365) − 100000.
  assert.equal(formatMoney(accruedInterest(compound, "2026-07-02")), "21292.8175");
  assert.equal(formatMoney(accruedInterest(terms({ id: "s" }), "2026-07-02")), "0.0000");
});

test("a pre-money SAFE converts at the lowest of round, cap and discount price", () => {
  const capped = terms({ id: "cap", valuationCap: "5000000.0000" });
  const discounted = terms({ id: "disc", discountPercent: "20" });
  const roundPriced = terms({ id: "none" });
  const { conversions } = convertAtRound(
    [instrument(capped), instrument(discounted), instrument(roundPriced)],
    parsePrice("2", "price"),
    10_000_000n,
  );
  assert.deepEqual(
    conversions.map((c) => [c.securityId, c.pricedBy, formatPrice(c.price), c.shares]),
    [
      ["cap", "cap", "0.5000000000", 2_000_000n],
      ["disc", "discount", "1.6000000000", 625_000n],
      ["none", "round", "2.0000000000", 500_000n],
    ],
  );
});

test("a post-money SAFE takes exactly its cap's share of the company capitalization", () => {
  const safe = terms({ id: "post", safeType: "post_money", valuationCap: "10000000.0000" });
  const { conversions, companyCapitalization } = convertAtRound(
    [instrument(safe)],
    parsePrice("2", "price"),
    9_000_000n,
  );
  assert.equal(formatPrice(companyCapitalization), "10000000.0000000000");
  assert.equal(formatPrice(conversions[0]!.price), "1.0000000000");
  assert.equal(conversions[0]!.shares, 1_000_000n);
});

test("post-money caps that claim 95% or more of the company refuse", () => {
  const safe = terms({
    id: "typo",
    safeType: "post_money",
    principal: "250000.0000",
    valuationCap: "80000.0000",
  });
  assert.throws(
    () => convertAtRound([instrument(safe)], parsePrice("2", "price"), 9_000_000n),
    (error: unknown) =>
      error instanceof EquityError && error.code === "equity_post_money_overclaim",
  );
});

test("a round without convertibles or pool prices at pre-money over the fully diluted count", () => {
  const result = model();
  assert.equal(result.pricePerShare, "1.0000000000");
  assert.equal(result.investorShares, "2000000");
  assert.equal(result.fullyDilutedAfter, "12000000");
  assert.equal(result.investorPercent, "16.6667");
  assert.equal(result.postMoneyValuation, "12000000.0000");
});

test("a pre-money pool top-up is priced into the pre-money and meets the post-round target", () => {
  const result = model({ targetPoolPercent: "10" });
  assert.equal(result.pricePerShare, "0.8800000000");
  assert.equal(result.investorShares, "2272727");
  assert.equal(result.poolTopUp, "1363637");
  assert.equal(result.fullyDilutedAfter, "13636364");
  assert.equal(result.poolPercentAfter, "10.0000");
  assert.ok(BigInt(result.poolAfter) * 10n >= BigInt(result.fullyDilutedAfter));
});

test("converting SAFEs enter the pre-money count and dilute the price", () => {
  const safe = terms({ id: "s1", valuationCap: "5000000.0000" });
  const result = model({
    convertibles: [instrument(safe)],
    convertibleHolders: new Map([["s1", "angel"]]),
  });
  // Cap price 5M / 10M = 0.50 < round price, so 2,000,000 shares; price = 10M / 12M.
  assert.equal(result.pricePerShare, "0.8333333333");
  assert.equal(result.conversions[0]!.shares, "2000000");
  assert.equal(result.conversions[0]!.pricedBy, "cap");
  const angel = result.dilution.find((row) => row.key === "angel")!;
  assert.equal(angel.sharesAfter, "2000000");
  const implied = parsePrice(result.pricePerShare, "price");
  assert.ok(implied.numerator * 12_000_000n <= 10_000_000n * implied.denominator);
});

test("a round the convertibles fully claim refuses as unpriceable", () => {
  const safe = terms({ id: "big", principal: "9900000.0000", discountPercent: "50" });
  assert.throws(
    () => model({ convertibles: [instrument(safe)] }),
    (error: unknown) => error instanceof EquityError && error.code === "equity_round_unpriceable",
  );
});

test("anti-dilution lowers the conversion price of a protected class in a down round", () => {
  const base = {
    conversionPrice: parsePrice("2", "price"),
    newIssuePrice: parsePrice("1", "price"),
    newMoney: parseMoney("1000000", "price"),
    newShares: rational(1_000_000n),
    fullyDilutedBefore: 10_000_000n,
    outstandingBefore: 9_000_000n,
  };
  assert.equal(
    formatPrice(adjustedConversionPrice({ ...base, method: "full_ratchet" })),
    "1.0000000000",
  );
  // 2 × (10M + 0.5M) / (10M + 1M)
  assert.equal(
    formatPrice(adjustedConversionPrice({ ...base, method: "broad_based" })),
    "1.9090909091",
  );
  // 2 × (9M + 0.5M) / (9M + 1M)
  assert.equal(
    formatPrice(adjustedConversionPrice({ ...base, method: "narrow_based" })),
    "1.9000000000",
  );
  assert.equal(
    formatPrice(
      adjustedConversionPrice({
        ...base,
        method: "broad_based",
        newIssuePrice: parsePrice("2.5", "price"),
      }),
    ),
    "2.0000000000",
  );
  const result = model({
    preMoneyValuation: "5000000.0000",
    investment: "1000000.0000",
    protectedClasses: [
      {
        shareClassId: "a",
        code: "A",
        method: "full_ratchet",
        conversionPrice: parsePrice("2", "price"),
        originalIssuePrice: parsePrice("2", "price"),
        outstandingShares: 1_000_000n,
      },
    ],
  });
  const adjustment = result.antiDilution[0]!;
  assert.equal(adjustment.newConversionPrice, result.pricePerShare);
  assert.ok(BigInt(adjustment.additionalShares) > 0n);
  assert.equal(result.antiDilutionShares, adjustment.additionalShares);
});

test("invalid round terms refuse by field", () => {
  assert.throws(
    () => model({ investment: "0" }),
    (error: unknown) => error instanceof EquityError && error.field === "investment",
  );
  assert.throws(
    () => model({ targetPoolPercent: "100" }),
    (error: unknown) => error instanceof EquityError && error.field === "targetPoolPercent",
  );
  assert.throws(
    () => model({ fullyDilutedBefore: 0n }),
    (error: unknown) => error instanceof EquityError && error.code === "equity_round_no_shares",
  );
});
