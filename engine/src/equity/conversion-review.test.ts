import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../platform/db.ts";
import { reviewRecordedConversion } from "./conversion-review.ts";
import type { EquityBook, SecurityEventRecord, SecurityRecord, ShareClassRecord } from "./types.ts";

const COMMON: ShareClassRecord = {
  id: "c-common",
  code: "CS",
  name: "Common",
  kind: "common",
  effectiveOn: "2026-01-01",
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
const SEED: ShareClassRecord = {
  ...COMMON,
  id: "c-seed",
  code: "SS",
  name: "Series Seed",
  kind: "preferred",
  originalIssuePrice: "1.0000000000",
  initialConversionPrice: "1.0000000000",
  liquidationMultiple: "1.0000",
  seniority: 1,
  conversionShareClassId: COMMON.id,
  liquidationPreferenceBasis: "amount_paid",
};

function security(
  overrides: Partial<SecurityRecord> & Pick<SecurityRecord, "id" | "kind">,
): SecurityRecord {
  return {
    securityNumber: overrides.id.toUpperCase(),
    holderPartyId: "holder",
    shareClassId: null,
    planId: null,
    roundId: null,
    sourceSecurityId: null,
    issueDate: "2026-01-01",
    quantity: null,
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
    interestDayCount: null,
    maturityDate: null,
    fairValuePerUnit: null,
    expenseAttribution: null,
    mfn: false,
    unvestedRepurchaseBasis: null,
    fxRate: "1",
    ...overrides,
  };
}
const event = (
  overrides: Partial<SecurityEventRecord> &
    Pick<SecurityEventRecord, "id" | "securityId" | "kind" | "effectiveOn">,
): SecurityEventRecord => ({
  quantity: null,
  pricePerShare: null,
  amount: null,
  resultingSecurityId: null,
  roundId: null,
  reversesEventId: null,
  ...overrides,
});

/** Only currency minor units are read; every instrument here is stated in the round's currency. */
const runner = {
  execute: async (_query: unknown, mode?: string) =>
    Promise.resolve({ rows: [{ minor_units: 2 }] }).then(
      <T extends { rows: unknown }>(result: T) => (mode === "objects" ? result.rows : result),
    ),
} as unknown as SqlExecutor;

function book(recordedPrice: string): EquityBook {
  const mfn = security({
    id: "s-mfn",
    kind: "safe",
    considerationAmount: "100000.0000",
    safeType: "pre_money",
    mfn: true,
  });
  const later = security({
    id: "s-later",
    kind: "safe",
    issueDate: "2026-02-01",
    considerationAmount: "50000.0000",
    safeType: "post_money",
    valuationCap: "400000.0000",
  });
  return {
    classes: [COMMON, SEED],
    amendments: [],
    splits: [],
    plans: [],
    reserveChanges: [],
    rounds: [
      {
        id: "r-1",
        name: "Seed",
        shareClassId: SEED.id,
        closedOn: "2026-02-28",
        pricePerShare: "1.0000000000",
        preMoneyValuation: "1000000.0000",
        currency: "USD",
        preMoneyBasisReason: null,
      },
    ],
    securities: [
      security({
        id: "s-common",
        kind: "share",
        shareClassId: COMMON.id,
        quantity: 1_000_000n,
        pricePerShare: "0.0001000000",
      }),
      mfn,
      later,
      security({
        id: "s-cert",
        kind: "share",
        shareClassId: SEED.id,
        roundId: "r-1",
        sourceSecurityId: mfn.id,
        issueDate: "2026-02-28",
        quantity: 100_000n,
        pricePerShare: recordedPrice,
      }),
    ],
    events: [
      event({ id: "e-void", securityId: later.id, kind: "void", effectiveOn: "2026-02-27" }),
      event({
        id: "e-convert",
        securityId: mfn.id,
        kind: "convert",
        effectiveOn: "2026-02-28",
        roundId: "r-1",
        resultingSecurityId: "s-cert",
        pricePerShare: recordedPrice,
      }),
    ],
    securityAmendments: [
      {
        id: "am-1",
        securityId: mfn.id,
        kind: "mfn_election",
        effectiveOn: "2026-02-10",
        sourceSecurityId: later.id,
        valuationCap: "400000.0000",
        discountPercent: null,
        safeType: "post_money",
        reversesAmendmentId: null,
      },
    ],
  };
}

test("a conversion recorded while an election named a void instrument stands when it was measured on the SAFE's own terms", async () => {
  const ownTerms = book("1.0000000000");
  assert.equal(
    await reviewRecordedConversion(
      runner,
      "org",
      ownTerms,
      ownTerms.securities[1]!,
      "2026-03-01",
      "USD",
      undefined,
      ownTerms,
    ),
    null,
  );
});

test("a conversion measured on the void instrument's terms is flagged for correction", async () => {
  const adopted = book("0.3333333333");
  const review = await reviewRecordedConversion(
    runner,
    "org",
    adopted,
    adopted.securities[1]!,
    "2026-03-01",
    "USD",
    undefined,
    adopted,
  );
  assert.deepEqual(review, {
    voidedTerms: {
      electionId: "am-1",
      sourceSecurityId: "s-later",
      sourceVoidedOn: "2026-02-27",
      resultingSecurityId: "s-cert",
    },
    drift: null,
  });
});

/**
 * A capped MFN SAFE that adopted a void instrument's lower cap, converted on
 * those terms, was corrected (certificate voided, election reversed after
 * the round, converted again on its own cap), and then an issue dated
 * before the round was recorded, raising the pre-round fully diluted count.
 */
function corrected(options: { reconvertedAt: string; backdatedIssue: boolean }): EquityBook {
  const mfn = security({
    id: "s-mfn",
    kind: "safe",
    considerationAmount: "100000.0000",
    safeType: "pre_money",
    valuationCap: "6000000.0000",
    mfn: true,
  });
  const later = security({
    id: "s-later",
    kind: "safe",
    issueDate: "2026-02-01",
    considerationAmount: "50000.0000",
    safeType: "pre_money",
    valuationCap: "3000000.0000",
  });
  return {
    classes: [COMMON, SEED],
    amendments: [],
    splits: [],
    plans: [],
    reserveChanges: [],
    rounds: [
      {
        id: "r-1",
        name: "Series A",
        shareClassId: SEED.id,
        closedOn: "2026-02-28",
        pricePerShare: "10.0000000000",
        preMoneyValuation: "10000000.0000",
        currency: "USD",
        preMoneyBasisReason: null,
      },
    ],
    securities: [
      security({
        id: "s-common",
        kind: "share",
        shareClassId: COMMON.id,
        quantity: 1_000_000n,
        pricePerShare: "0.0001000000",
      }),
      mfn,
      later,
      security({
        id: "s-cert-1",
        kind: "share",
        shareClassId: SEED.id,
        roundId: "r-1",
        sourceSecurityId: mfn.id,
        issueDate: "2026-02-28",
        quantity: 33_333n,
        pricePerShare: "3.0000000000",
      }),
      security({
        id: "s-cert-2",
        kind: "share",
        shareClassId: SEED.id,
        roundId: "r-1",
        sourceSecurityId: mfn.id,
        issueDate: "2026-02-28",
        quantity: 16_666n,
        pricePerShare: options.reconvertedAt,
      }),
      ...(options.backdatedIssue
        ? [
            security({
              id: "s-backdated",
              kind: "share",
              shareClassId: COMMON.id,
              issueDate: "2026-01-15",
              quantity: 1_000n,
              pricePerShare: "0.0001000000",
            }),
          ]
        : []),
    ],
    events: [
      event({ id: "e-void", securityId: later.id, kind: "void", effectiveOn: "2026-02-27" }),
      event({
        id: "e-convert-1",
        securityId: mfn.id,
        kind: "convert",
        effectiveOn: "2026-02-28",
        roundId: "r-1",
        resultingSecurityId: "s-cert-1",
        pricePerShare: "3.0000000000",
      }),
      event({ id: "e-void-cert", securityId: "s-cert-1", kind: "void", effectiveOn: "2026-02-28" }),
      event({
        id: "e-convert-2",
        securityId: mfn.id,
        kind: "convert",
        effectiveOn: "2026-02-28",
        roundId: "r-1",
        resultingSecurityId: "s-cert-2",
        pricePerShare: options.reconvertedAt,
      }),
    ],
    securityAmendments: [
      {
        id: "am-1",
        securityId: mfn.id,
        kind: "mfn_election",
        effectiveOn: "2026-02-10",
        sourceSecurityId: later.id,
        valuationCap: "3000000.0000",
        discountPercent: null,
        safeType: "pre_money",
        reversesAmendmentId: null,
      },
      {
        id: "am-2",
        securityId: mfn.id,
        kind: "mfn_reversal",
        effectiveOn: "2026-10-19",
        sourceSecurityId: later.id,
        valuationCap: "6000000.0000",
        discountPercent: null,
        safeType: "pre_money",
        reversesAmendmentId: "am-1",
      },
    ],
  };
}

test("a conversion on the SAFE's own terms after the election is reversed is not flagged once a later backdated issue moves the round's count; the drift is reported instead", async () => {
  const before = corrected({ reconvertedAt: "6.0000000000", backdatedIssue: false });
  assert.equal(
    await reviewRecordedConversion(
      runner,
      "org",
      before,
      before.securities[1]!,
      "2026-10-20",
      "USD",
      undefined,
      before,
    ),
    null,
    "converted at the price the round gives its own cap",
  );

  const after = corrected({ reconvertedAt: "6.0000000000", backdatedIssue: true });
  const review = await reviewRecordedConversion(
    runner,
    "org",
    after,
    after.securities[1]!,
    "2026-10-20",
    "USD",
    undefined,
    before,
  );
  assert.equal(
    review?.voidedTerms,
    null,
    "the recorded price is the SAFE's own cap over the count as it then stood, not the void instrument's terms",
  );
  assert.deepEqual(review?.drift, {
    securityId: "s-mfn",
    roundId: "r-1",
    convertedOn: "2026-02-28",
    resultingSecurityId: "s-cert-2",
    recordedPrice: "6.0000000000",
    standingPrice: "5.9940059940",
    recordedShares: "16666",
    standingShares: "16683",
  });
});

test("a conversion on the void instrument's terms stays flagged when backdated activity has moved its price too", async () => {
  const onVoidTerms = corrected({ reconvertedAt: "3.0000000000", backdatedIssue: true });
  const review = await reviewRecordedConversion(
    runner,
    "org",
    onVoidTerms,
    onVoidTerms.securities[1]!,
    "2026-10-20",
    "USD",
    undefined,
    corrected({ reconvertedAt: "3.0000000000", backdatedIssue: false }),
  );
  assert.equal(review?.voidedTerms?.electionId, "am-1");
  assert.equal(
    review?.drift,
    null,
    "a conversion on void terms is corrected by converting again, not reported as drift",
  );
});

test("a plain SAFE conversion whose round count moved afterwards is drift, and one at the current price is not", async () => {
  const plain = corrected({ reconvertedAt: "6.0000000000", backdatedIssue: true });
  const own = { ...plain, securityAmendments: [] };
  const drift = await reviewRecordedConversion(
    runner,
    "org",
    own,
    own.securities[1]!,
    "2026-10-20",
    "USD",
  );
  assert.equal(drift?.voidedTerms, null);
  assert.equal(drift?.drift?.standingPrice, "5.9940059940");
  const current = corrected({ reconvertedAt: "5.9940059940", backdatedIssue: true });
  assert.equal(
    await reviewRecordedConversion(
      runner,
      "org",
      { ...current, securityAmendments: [] },
      current.securities[1]!,
      "2026-10-20",
      "USD",
    ),
    null,
  );
});

test("a large backdated change cannot identify adopted terms merely because their current price is nearer", async () => {
  const recordedBook = corrected({ reconvertedAt: "3.0000000000", backdatedIssue: false });
  // The source was still live when this conversion was recorded, so the
  // recorded snapshot prices the conversion on its adopted cap.
  const original = {
    ...recordedBook,
    events: recordedBook.events.filter((row) => row.id !== "e-void"),
  };
  const current = corrected({ reconvertedAt: "3.0000000000", backdatedIssue: true });
  const changed = {
    ...current,
    securities: current.securities.map((row) =>
      row.id === "s-backdated" ? { ...row, quantity: 1_000_000n } : row,
    ),
  };
  const review = await reviewRecordedConversion(
    runner,
    "org",
    changed,
    changed.securities[1]!,
    "2026-10-20",
    "USD",
    undefined,
    original,
  );
  assert.equal(
    review?.voidedTerms?.electionId,
    "am-1",
    "the current standing price coincides with the old adopted price, but the recorded terms still require correction",
  );
  assert.equal(review?.drift, null);
});
