import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../money/money.ts";
import {
  ConsolidatedTaxMatchingError,
  matchConsolidatedDepreciation,
  matchConsolidatedTaxItems,
} from "./consolidated-tax-matching.ts";
import {
  CONSOLIDATED_MEMBERSHIP_IDENTITY,
  assertConsolidatedMembershipMatchesSource,
  assertWriteOnceMatchingPeriod,
  freezeUsConsolidatedMatching,
  matchConsolidatedMacrsFromWorkpaper,
  matchLiveConsolidatedMacrsYear,
  matchingPeriodPersistFacts,
  matchingPeriodRowIdentity,
  parseConsolidatedGroupMembership,
  resolveFrozenUsConsolidatedMatching,
  historicalMatchingYearsToReplay,
  matchingReplayPeriodEvidence,
  matchingReplayVintageWeights,
  receivingMatchingVintageWeights,
  replayMatchingPaperFromCitedHistory,
  replayMatchingPeriodsFromCitedHistory,
  signedDeferredOpening,
} from "./consolidated-macrs-matching.ts";

const SELLER = "00000000-0000-4000-8000-000000000001";
const BUYER = "00000000-0000-4000-8000-000000000002";

const membership = {
  groupKey: "example-4-group",
  sellerSubsidiaryId: SELLER,
  buyerSubsidiaryId: BUYER,
  effectiveOn: "2023-01-01",
  throughOn: "2026-12-31",
};

test("membership parse is complete-object-or-omit and refuses tax_groups-shaped extras", () => {
  assert.equal(parseConsolidatedGroupMembership(null), null);
  assert.equal(parseConsolidatedGroupMembership(undefined), null);
  assert.deepEqual(parseConsolidatedGroupMembership(membership), membership);
  assert.throws(
    () => parseConsolidatedGroupMembership({ groupKey: "example-4-group" }),
    /missing sellerSubsidiaryId, buyerSubsidiaryId, effectiveOn, throughOn/,
  );
  assert.throws(
    () => parseConsolidatedGroupMembership({ ...membership, taxGroupId: "ST-CA" }),
    /unknown consolidatedGroupMembership field\(s\): taxGroupId/,
  );
  assert.throws(
    () => parseConsolidatedGroupMembership({ ...membership, sellerSubsidiaryId: BUYER }),
    /different legal entities/,
  );
});

test("Example 4 sale opening is amount realized minus seller adjusted basis, not zero carryover", () => {
  assert.equal(signedDeferredOpening("130.0000", "80.0000"), "50.0000");
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.ok(frozen);
  assert.equal(frozen.consolidatedMembership.identity, CONSOLIDATED_MEMBERSHIP_IDENTITY);
  assert.equal(frozen.consolidatedMembership.groupKey, "example-4-group");
  assert.equal(frozen.consolidatedMatching.deferredOpening, "50.0000");
  assert.deepEqual(frozen.consolidatedMatching, {
    ...matchConsolidatedTaxItems({
      deferredOpening: "50.0000",
      actualCorrespondingItems: [],
      recomputedCorrespondingItems: [],
    }),
    actualCorrespondingItems: [],
    recomputedCorrespondingItems: [],
  });
});

test("§168(i)(7) or nontaxable recognition without membership does not invent a deferred opening", () => {
  assert.equal(
    freezeUsConsolidatedMatching({
      membership: null,
      amountRealized: "130.00",
      sellerAdjustedBasis: "80.00",
    }),
    null,
  );
});

test("membership without sale facts refuses instead of treating carryover as zero gain", () => {
  assert.throws(
    () => freezeUsConsolidatedMatching({
      membership,
      amountRealized: null,
      sellerAdjustedBasis: "80.00",
    }),
    /§168\(i\)\(7\) carryover is not a zero intercompany gain/,
  );
  assert.throws(
    () => freezeUsConsolidatedMatching({
      membership,
      amountRealized: "130.00",
      sellerAdjustedBasis: null,
    }),
    /sellerAdjustedBasis of the transferred slice/,
  );
});

test("live matching uses the frozen Example 4 opening with independent schedules", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  const live = matchLiveConsolidatedMacrsYear({
    computed: frozen,
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    taxYearWindowId: "window-2025",
    vintageKey: "carryover:2023-01-01:2025-08-20:original:2023-01-01",
    transferOn: "2025-08-20",
    allocatedDeferredOpening: "50.0000",
  });
  const expected = matchConsolidatedDepreciation({
    deferredOpening: "50.0000",
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
  });
  assert.equal(live.deferredOpening, "50.0000");
  assert.equal(live.sellerMatchingAmount, expected.sellerMatchingAmount);
  assert.equal(live.deferredClosing, expected.deferredClosing);
  assert.equal(live.membership.identity, CONSOLIDATED_MEMBERSHIP_IDENTITY);
});

test("a vintage-keyed initial year cannot begin at the whole paper deferred opening", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.throws(
    () => matchLiveConsolidatedMacrsYear({
      computed: frozen,
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
      vintageKey: "carryover:2023-01-01:2025-08-20:original:2023-01-01",
      transferOn: "2025-08-20",
    }),
    /do not begin each vintage at the whole paper deferred opening/,
  );
});

test("membership that does not cover the matching period is refused", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership: { ...membership, throughOn: "2025-12-31" },
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.throws(
    () => matchLiveConsolidatedMacrsYear({
      computed: frozen,
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2026-01-01",
      yearEnd: "2026-12-31",
    }),
    /does not cover 2026-01-01–2026-12-31/,
  );
});

test("live prior years require membership coverage and a unique registered window", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership: { ...membership, effectiveOn: "2026-01-01", throughOn: "2026-12-31" },
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  const prior = {
    yearStart: "2024-01-01",
    yearEnd: "2024-12-31",
    taxYearWindowId: "00000000-0000-4000-8000-000000000014",
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
  };
  assert.throws(
    () => matchLiveConsolidatedMacrsYear({
      computed: frozen,
      priorYears: [prior, { ...prior, yearStart: "2025-01-01", yearEnd: "2025-12-31" }],
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2026-01-01",
      yearEnd: "2026-12-31",
    }),
    /does not cover 2024-01-01–2024-12-31/,
  );
  const covered = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.throws(
    () => matchLiveConsolidatedMacrsYear({
      computed: covered,
      priorYears: [{ ...prior, taxYearWindowId: null }],
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2026-01-01",
      yearEnd: "2026-12-31",
    }),
    /must cite a registered tax year/,
  );
  assert.throws(
    () => matchLiveConsolidatedMacrsYear({
      computed: covered,
      priorYears: [prior, { ...prior, yearStart: "2025-01-01", yearEnd: "2025-12-31" }],
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2026-01-01",
      yearEnd: "2026-12-31",
    }),
    /repeats tax year/,
  );
});

test("resolve refuses a 168(i)(7) identity standing in for membership", () => {
  assert.throws(
    () => resolveFrozenUsConsolidatedMatching({
      section168i7Kind: "consolidated_group",
      recognition: "taxable",
      consolidatedMembership: {
        identity: "us_macrs.section168i7.consolidated_group",
        ...membership,
      },
      consolidatedMatching: { deferredOpening: "0.0000" },
    }),
    /identity must be us_macrs.consolidated_group.membership/,
  );
  assert.throws(
    () => resolveFrozenUsConsolidatedMatching({
      recognition: "taxable",
      section168i7Kind: "consolidated_group",
    }),
    /do not infer membership/,
  );
});

test("pool entry is null without a membership nest and refuses missing original unadjusted", () => {
  assert.equal(
    matchConsolidatedMacrsFromWorkpaper({
      role: "buyer",
      computed: { recognition: "taxable", section168i7Kind: "consolidated_group" },
      originalUnadjustedBasis: "10000.0000",
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
    }),
    null,
  );
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.throws(
    () => matchConsolidatedMacrsFromWorkpaper({
      role: "buyer",
      computed: frozen,
      originalUnadjustedBasis: null,
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
      transferOn: "2025-08-20",
    }),
    /originalUnadjustedBasis.*do not recompute from remaining carryover/,
  );
});

test("a prior year that is not earlier than the current year is refused", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.throws(
    () => matchLiveConsolidatedMacrsYear({
      computed: frozen,
      priorYears: [{
        yearStart: "2025-01-01",
        yearEnd: "2025-12-31",
        taxYearWindowId: "00000000-0000-4000-8000-000000000015",
        actualDeduction: "15.0000",
        recomputedDeduction: "10.0000",
      }],
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
    }),
    /do not match the current year twice/,
  );
});

test("membership IDs must match the selected source legal entities", () => {
  assertConsolidatedMembershipMatchesSource(membership, {
    sellerSubsidiaryId: SELLER,
    buyerSubsidiaryId: BUYER,
    sourceOperation: "intercompany_transfer",
  });
  assert.throws(
    () => assertConsolidatedMembershipMatchesSource(membership, {
      sellerSubsidiaryId: SELLER,
      buyerSubsidiaryId: null,
      sourceOperation: "partial_disposal",
    }),
    /customer disposal is not a 1.1502-13 matching event/,
  );
  assert.throws(
    () => assertConsolidatedMembershipMatchesSource(membership, {
      sellerSubsidiaryId: BUYER,
      buyerSubsidiaryId: SELLER,
      sourceOperation: "intercompany_transfer",
    }),
    /source transferor legal entity/,
  );
});

test("posted matching is write-once: identical re-run passes and a different amount is a refusal", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  const live = matchLiveConsolidatedMacrsYear({
    computed: frozen,
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    taxYearWindowId: "00000000-0000-4000-8000-000000000015",
    vintageKey: "carryover:2023-01-01:2025-08-20:original:2023-01-01",
    transferOn: "2025-08-20",
    allocatedDeferredOpening: "50.0000",
  });
  const posted = matchingPeriodPersistFacts({
    matched: live,
    workpaperId: "00000000-0000-4000-8000-0000000000aa",
    workpaperChangeId: "00000000-0000-4000-8000-000000000099",
    parentKey: "original:2023-01-01",
  });
  assertWriteOnceMatchingPeriod(posted, posted);
  assert.throws(
    () => assertWriteOnceMatchingPeriod(posted, { ...posted, deferredOpening: "0.0000" }),
    /already records deferred opening 50.0000, not 0.0000/,
  );
});

test("a posted prior closing is used instead of a live prior-year walk", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  const fromPosted = matchLiveConsolidatedMacrsYear({
    computed: frozen,
    postedDeferredOpening: "40.0000",
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
  });
  assert.equal(fromPosted.deferredOpening, "40.0000");
  assert.throws(
    () => matchLiveConsolidatedMacrsYear({
      computed: frozen,
      postedDeferredOpening: "40.0000",
      priorYears: [{
        yearStart: "2025-01-01",
        yearEnd: "2025-12-31",
        actualDeduction: "15.0000",
        recomputedDeduction: "10.0000",
      }],
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2026-01-01",
      yearEnd: "2026-12-31",
    }),
    /do not recompute a posted opening from a live walk/,
  );
});

test("two assets placed and transferred on the same dates keep distinct matching rows", () => {
  const vintageKey = "carryover:2023-01-01:2025-08-20:original:2023-01-01";
  const taxYearWindowId = "00000000-0000-4000-8000-000000000015";
  const paperA = "00000000-0000-4000-8000-0000000000aa";
  const paperB = "00000000-0000-4000-8000-0000000000bb";
  const lookupA = matchingPeriodRowIdentity({ workpaperId: paperA, vintageKey, taxYearWindowId });
  const lookupB = matchingPeriodRowIdentity({ workpaperId: paperB, vintageKey, taxYearWindowId });
  assert.equal(lookupA.vintageKey, lookupB.vintageKey);
  assert.equal(lookupA.taxYearWindowId, lookupB.taxYearWindowId);
  assert.notEqual(lookupA.workpaperId, lookupB.workpaperId);
  assert.notDeepEqual(lookupA, lookupB);
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  const live = matchLiveConsolidatedMacrsYear({
    computed: frozen,
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    taxYearWindowId,
    vintageKey,
    transferOn: "2025-08-20",
    allocatedDeferredOpening: "50.0000",
  });
  const postedA = matchingPeriodPersistFacts({
    matched: live,
    workpaperId: paperA,
    workpaperChangeId: "00000000-0000-4000-8000-0000000000a1",
    parentKey: "original:2023-01-01",
  });
  const postedB = matchingPeriodPersistFacts({
    matched: live,
    workpaperId: paperB,
    workpaperChangeId: "00000000-0000-4000-8000-0000000000b1",
    parentKey: "original:2023-01-01",
  });
  assert.equal(postedA.vintageKey, postedB.vintageKey);
  assert.equal(postedA.parentKey, postedB.parentKey);
  assert.notEqual(postedA.workpaperId, postedB.workpaperId);
  assertWriteOnceMatchingPeriod(postedA, postedA);
  assertWriteOnceMatchingPeriod(postedB, postedB);
  assert.throws(
    () => assertWriteOnceMatchingPeriod(postedA, postedB),
    /already records a different receiving workpaper/,
  );
  assert.throws(
    () => matchingPeriodRowIdentity({ workpaperId: "", vintageKey, taxYearWindowId }),
    /receiving tax basis workpaper/,
  );
});

const historical2025 = {
  id: "00000000-0000-4000-8000-000000000025",
  workpaperId: "00000000-0000-4000-8000-0000000000aa",
  vintageKey: "carryover:2023-01-01:2025-08-20:original:2023-01-01",
  parentKey: "original:2023-01-01",
  taxYearWindowId: "00000000-0000-4000-8000-000000000015",
  yearStart: "2025-01-01",
  yearEnd: "2025-12-31",
  actualDeduction: "15.0000",
  recomputedDeduction: "10.0000",
};

test("earlier matching years replay when a later pool result exists; the latest year does not", () => {
  assert.deepEqual(
    historicalMatchingYearsToReplay([historical2025], "2026-01-01").map((row) => row.id),
    [historical2025.id],
  );
  assert.deepEqual(historicalMatchingYearsToReplay([historical2025], "2025-01-01"), []);
  assert.deepEqual(historicalMatchingYearsToReplay([historical2025], null), []);
});

test("cited matching replay walks the replacement opening and does not borrow the reversed closing", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.ok(frozen);
  const replacementOpening = "40.0001";
  const replayed = replayMatchingPeriodsFromCitedHistory({
    replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
    replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
    replacementOpening,
    replacementMembership: frozen.consolidatedMembership,
    historical: [historical2025],
  });
  assert.equal(replayed.length, 1);
  const expected = matchConsolidatedDepreciation({
    deferredOpening: replacementOpening,
    actualDeduction: historical2025.actualDeduction,
    recomputedDeduction: historical2025.recomputedDeduction,
  });
  assert.equal(replayed[0]!.priorMatchingPeriodId, historical2025.id);
  assert.equal(replayed[0]!.taxYearWindowId, historical2025.taxYearWindowId);
  assert.equal(replayed[0]!.workpaperId, "00000000-0000-4000-8000-0000000000cc");
  assert.equal(replayed[0]!.workpaperChangeId, "00000000-0000-4000-8000-0000000000c1");
  assert.equal(replayed[0]!.deferredOpening, "40.0001");
  assert.equal(replayed[0]!.deferredClosing, expected.deferredClosing);
  assert.notEqual(replayed[0]!.deferredOpening, frozen.consolidatedMatching.deferredOpening);
  assert.throws(
    () => replayMatchingPeriodsFromCitedHistory({
      replacementWorkpaperId: historical2025.workpaperId,
      replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
      replacementOpening,
      replacementMembership: frozen.consolidatedMembership,
      historical: [historical2025],
    }),
    /replacement workpaper/,
  );
  assert.throws(
    () => replayMatchingPeriodsFromCitedHistory({
      replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
      replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
      replacementOpening,
      replacementMembership: frozen.consolidatedMembership,
      historical: [],
    }),
    /cited historical matching rows/,
  );
});

test("paper-level replay allocates the replacement opening once across vintages", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.ok(frozen);
  const second = {
    ...historical2025,
    id: "00000000-0000-4000-8000-000000000026",
    vintageKey: "carryover:2024-01-01:2025-08-20:original:2024-01-01",
    parentKey: "original:2024-01-01",
  };
  assert.throws(
    () => replayMatchingPaperFromCitedHistory({
      replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
      replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
      replacementOpening: "50.0000",
      replacementMembership: frozen.consolidatedMembership,
      historical: [historical2025, second],
    }),
    /do not apply the paper opening to every vintage/,
  );
  const replayed = replayMatchingPaperFromCitedHistory({
    replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
    replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
    replacementOpening: "50.0000",
    replacementMembership: frozen.consolidatedMembership,
    historical: [historical2025, second],
    vintageWeights: [
      { vintageKey: historical2025.vintageKey, amount: "60.0000" },
      { vintageKey: second.vintageKey, amount: "40.0000" },
    ],
  });
  assert.equal(replayed.length, 2);
  const first = replayed.find((row) => row.vintageKey === historical2025.vintageKey)!;
  const other = replayed.find((row) => row.vintageKey === second.vintageKey)!;
  assert.equal(first.deferredOpening, "30.0000");
  assert.equal(other.deferredOpening, "20.0000");
  assert.equal(add(first.deferredOpening, other.deferredOpening), "50.0000");
  const expectedFirst = matchConsolidatedDepreciation({
    deferredOpening: "30.0000",
    actualDeduction: historical2025.actualDeduction,
    recomputedDeduction: historical2025.recomputedDeduction,
  });
  assert.equal(first.deferredClosing, expectedFirst.deferredClosing);
  assert.equal(first.sellerMatchingAmount, expectedFirst.sellerMatchingAmount);
  const evidence = matchingReplayPeriodEvidence(first);
  assert.equal(evidence.yearStart, historical2025.yearStart);
  assert.equal(evidence.yearEnd, historical2025.yearEnd);
  assert.equal(evidence.priorMatchingPeriodId, historical2025.id);
  assert.equal(evidence.deferredOpening, "30.0000");
  assert.equal(evidence.sellerMatchingAmount, first.sellerMatchingAmount);
  assert.equal(evidence.deferredClosing, first.deferredClosing);
  const single = replayMatchingPaperFromCitedHistory({
    replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
    replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
    replacementOpening: "40.0001",
    replacementMembership: frozen.consolidatedMembership,
    historical: [historical2025],
  });
  assert.equal(single[0]!.deferredOpening, "40.0001");
  const gainAboveBasis = replayMatchingPaperFromCitedHistory({
    replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
    replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
    replacementOpening: "50.0000",
    replacementMembership: frozen.consolidatedMembership,
    historical: [historical2025, second],
    vintageWeights: [
      { vintageKey: historical2025.vintageKey, amount: "10.0000" },
      { vintageKey: second.vintageKey, amount: "10.0000" },
    ],
  });
  assert.equal(gainAboveBasis[0]!.deferredOpening, "25.0000");
  assert.equal(gainAboveBasis[1]!.deferredOpening, "25.0000");
  assert.equal(add(gainAboveBasis[0]!.deferredOpening, gainAboveBasis[1]!.deferredOpening), "50.0000");
  const lossAboveBasis = replayMatchingPaperFromCitedHistory({
    replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
    replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
    replacementOpening: "-50.0000",
    replacementMembership: frozen.consolidatedMembership,
    historical: [historical2025, second],
    vintageWeights: [
      { vintageKey: historical2025.vintageKey, amount: "10.0000" },
      { vintageKey: second.vintageKey, amount: "10.0000" },
    ],
  });
  assert.equal(add(lossAboveBasis[0]!.deferredOpening, lossAboveBasis[1]!.deferredOpening), "-50.0000");
  assert.equal(lossAboveBasis[0]!.deferredOpening, "-25.0000");
  assert.equal(lossAboveBasis[1]!.deferredOpening, "-25.0000");
});

test("replay vintage weights join seller allocation keys to receiver carryover keys", () => {
  const sellerA = "original:2023-01-01";
  const sellerB = "original:2024-01-01";
  const receiverA = "carryover:2023-01-01:2025-08-20:original:2023-01-01";
  const receiverB = "carryover:2024-01-01:2025-08-20:original:2024-01-01";
  assert.deepEqual(matchingReplayVintageWeights({ allocations: [], receivers: [] }), []);
  assert.deepEqual(
    matchingReplayVintageWeights({
      allocations: [{ sellerVintageKey: sellerA, disposedUnadjustedBasis: "10.0000" }],
      receivers: [],
    }),
    [],
  );
  const joined = matchingReplayVintageWeights({
    allocations: [
      { sellerVintageKey: sellerA, disposedUnadjustedBasis: "10.0000" },
      { sellerVintageKey: sellerB, disposedUnadjustedBasis: "10.0000" },
    ],
    receivers: [
      { vintageKey: receiverA, parentKey: sellerA, unadjustedBasis: "10.0000" },
      { vintageKey: receiverB, parentKey: sellerB, unadjustedBasis: "10.0000" },
    ],
  });
  assert.deepEqual(joined, [
    { vintageKey: receiverA, amount: "10.0000" },
    { vintageKey: receiverB, amount: "10.0000" },
  ]);
  assert.throws(
    () => matchingReplayVintageWeights({
      allocations: [{ sellerVintageKey: sellerA, disposedUnadjustedBasis: "10.0000" }],
      receivers: [{ vintageKey: receiverB, parentKey: sellerB, unadjustedBasis: "10.0000" }],
    }),
    /not a vintageAllocations seller identity/,
  );
  assert.throws(
    () => matchingReplayVintageWeights({
      allocations: [{ sellerVintageKey: sellerA, disposedUnadjustedBasis: "10.0000" }],
      receivers: [{
        vintageKey: "carryover:2023-01-01:2025-08-20:original:2024-01-01",
        parentKey: sellerB,
        unadjustedBasis: "10.0000",
      }],
    }),
    /do not match those vintages by placed-in-service date/,
  );
  assert.throws(
    () => matchingReplayVintageWeights({
      allocations: [
        { sellerVintageKey: sellerA, disposedUnadjustedBasis: "10.0000" },
        { sellerVintageKey: sellerB, disposedUnadjustedBasis: "10.0000" },
      ],
      receivers: [{ vintageKey: receiverA, parentKey: sellerA, unadjustedBasis: "10.0000" }],
    }),
    /has no receiving buyerVintages parentKey/,
  );
});

test("receiving vintage weights keep header excess beside carryover parent joins", () => {
  const seller = "original:2023-01-01";
  const carryover = "carryover:2023-01-01:2025-08-20:original:2023-01-01";
  const excess = "excess:2025-08-20:2025-08-20";
  assert.deepEqual(
    receivingMatchingVintageWeights({
      allocations: [{ sellerVintageKey: seller, disposedUnadjustedBasis: "100.0000" }],
      receivers: [{ vintageKey: carryover, parentKey: seller, unadjustedBasis: "100.0000" }],
      newlyPlaced: [{ vintageKey: excess, amount: "50.0000" }],
    }),
    [
      { vintageKey: carryover, amount: "100.0000" },
      { vintageKey: excess, amount: "50.0000" },
    ],
  );
  assert.deepEqual(
    receivingMatchingVintageWeights({
      newlyPlaced: [
        { vintageKey: carryover, amount: "100.0000" },
        { vintageKey: excess, amount: "50.0000" },
      ],
    }),
    [
      { vintageKey: carryover, amount: "100.0000" },
      { vintageKey: excess, amount: "50.0000" },
    ],
    "header-only carryover+excess must not refuse for missing allocation arrays",
  );
});

test("replay membership beginning on the transfer date covers that year's cited row", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership: { ...membership, effectiveOn: "2025-08-20" },
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  assert.ok(frozen);
  assert.throws(
    () => replayMatchingPeriodsFromCitedHistory({
      replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
      replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
      replacementOpening: "50.0000",
      replacementMembership: frozen.consolidatedMembership,
      historical: [historical2025],
    }),
    /does not cover 2025-01-01–2025-12-31/,
  );
  const replayed = replayMatchingPeriodsFromCitedHistory({
    replacementWorkpaperId: "00000000-0000-4000-8000-0000000000cc",
    replacementWorkpaperChangeId: "00000000-0000-4000-8000-0000000000c1",
    replacementOpening: "50.0000",
    replacementMembership: frozen.consolidatedMembership,
    historical: [{ ...historical2025, transferOn: "2025-08-20" }],
    transferOn: "2025-08-20",
  });
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]!.membershipEffectiveOn, "2025-08-20");
  assert.equal(replayed[0]!.deferredOpening, "50.0000");
});
