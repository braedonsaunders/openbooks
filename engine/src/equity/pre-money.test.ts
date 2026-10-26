import assert from "node:assert/strict";
import test from "node:test";
import { renderRefusal } from "../platform/catalog-refusal.ts";
import { EQUITY_REFUSALS } from "./refusals/index.ts";
import { EquityError } from "./errors.ts";
import { parsePrice, rational } from "./quantities.ts";
import { assertPreMoneyConsistent, roundPreMoneyDrift } from "./structure.ts";
import type {
  EquityBook,
  FinancingRoundRecord,
  SecurityRecord,
  ShareClassRecord,
} from "./types.ts";

const COMMON: ShareClassRecord = {
  id: "c-common",
  code: "CS",
  name: "Common",
  kind: "common",
  effectiveOn: "2026-01-01",
  initialAuthorizedShares: 50_000_000n,
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

function shares(id: string, quantity: bigint, issueDate = "2026-01-01"): SecurityRecord {
  return {
    id,
    securityNumber: id.toUpperCase(),
    kind: "share",
    holderPartyId: "holder",
    shareClassId: COMMON.id,
    planId: null,
    roundId: null,
    sourceSecurityId: null,
    issueDate,
    quantity,
    pricePerShare: "0.0001000000",
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
    interestDayCount: null,
    maturityDate: null,
    fairValuePerUnit: null,
    expenseAttribution: null,
    mfn: false,
    unvestedRepurchaseBasis: null,
    fxRate: "1",
  };
}

const book = (securities: SecurityRecord[], rounds: FinancingRoundRecord[] = []): EquityBook => ({
  classes: [COMMON],
  amendments: [],
  splits: [],
  plans: [],
  reserveChanges: [],
  rounds,
  securities,
  events: [],
  securityAmendments: [],
});

const PAR = parsePrice("0.0001", "price");
const refusal = (run: () => void): EquityError => {
  try {
    run();
  } catch (error) {
    if (error instanceof EquityError) return error;
    throw error;
  }
  assert.fail("expected a refusal");
};

test("a pre-money refusal proposes the consistent valuation and the consistent price for the stated valuation", () => {
  const before = book([shares("s-1", 2_000_000n)]);
  const error = refusal(() =>
    assertPreMoneyConsistent(before, {
      closedOn: "2026-08-15",
      price: parsePrice("3.50", "price"),
      preMoney: rational(9_000_000n),
      currency: "USD",
      basisReason: null,
      parValue: PAR,
      priceLocked: false,
    }),
  );
  assert.equal(error.code, "equity_round_pre_money_inconsistent");
  assert.equal(error.field, "preMoneyValuation");
  assert.match(
    error.remedy,
    /pre-money valuation of \$7,000,000\.00 or a price per share of \$4\.5000;/,
    "the proposed price reads under the four-place per-share rule",
  );
  assert.match(
    error.remedy,
    /state that basis under “Pre-money basis”\.$/,
    "the remedy names the field by its form label",
  );
  assert.doesNotThrow(
    () =>
      assertPreMoneyConsistent(before, {
        closedOn: "2026-08-15",
        price: parsePrice("4.5", "price"),
        preMoney: rational(9_000_000n),
        currency: "USD",
        basisReason: null,
        parValue: PAR,
        priceLocked: false,
      }),
    "the proposed price agrees with the stated valuation",
  );
});

test("a pre-money refusal never proposes a price below par, at zero, or while live securities stand at the price", () => {
  const before = book([shares("s-1", 21_090_000n)]);
  const tiny = refusal(() =>
    assertPreMoneyConsistent(before, {
      closedOn: "2026-08-15",
      price: parsePrice("3.50", "price"),
      preMoney: rational(1000n),
      currency: "USD",
      basisReason: null,
      parValue: PAR,
      priceLocked: false,
    }),
  );
  assert.doesNotMatch(
    tiny.remedy,
    /price per share/,
    "a price of a fraction of par cannot be recorded",
  );
  assert.match(tiny.remedy, /^Enter a pre-money valuation of \$73,815,000\.00;/);

  const locked = refusal(() =>
    assertPreMoneyConsistent(before, {
      closedOn: "2026-08-15",
      price: parsePrice("3.50", "price"),
      preMoney: rational(73_000_000n),
      currency: "USD",
      basisReason: null,
      parValue: PAR,
      priceLocked: true,
    }),
  );
  assert.doesNotMatch(locked.remedy, /price per share of/);
  assert.match(
    locked.remedy,
    /the price stays at \$3\.5000, since live securities were issued or converted at it/,
  );
  assert.match(
    renderRefusal(EQUITY_REFUSALS[locked.key].remedy, locked.values, "de-DE"),
    /73\.815\.000,00/,
  );
});

test("a recorded round whose pre-round count changed afterwards reads as drifted until its valuation or basis is amended", () => {
  const round: FinancingRoundRecord = {
    id: "r-1",
    name: "Series A",
    shareClassId: COMMON.id,
    closedOn: "2026-06-30",
    pricePerShare: "2.0000000000",
    preMoneyValuation: "4000000.0000",
    currency: "USD",
    preMoneyBasisReason: null,
  };
  assert.equal(
    roundPreMoneyDrift(book([shares("s-1", 2_000_000n)], [round]), round),
    null,
    "the valuation agrees as recorded",
  );
  const backdated = book(
    [shares("s-1", 2_000_000n), shares("s-late", 1_750n, "2026-03-01")],
    [round],
  );
  assert.deepEqual(roundPreMoneyDrift(backdated, round), {
    fullyDilutedBefore: "2001750",
    impliedPreMoney: "4003500.0000",
  });
  assert.equal(
    roundPreMoneyDrift(backdated, { ...round, preMoneyValuation: "4003500.0000" }),
    null,
    "an amended valuation agrees again",
  );
  assert.equal(
    roundPreMoneyDrift(backdated, {
      ...round,
      preMoneyBasisReason: "Stated on the signed term sheet's share count",
    }),
    null,
    "a recorded basis explains the difference",
  );
  assert.equal(
    roundPreMoneyDrift(
      book([shares("s-1", 2_000_000n), shares("s-after", 5_000n, "2026-07-15")], [round]),
      round,
    ),
    null,
    "shares issued after the round do not move its pre-round count",
  );
});
