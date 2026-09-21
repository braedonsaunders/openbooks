import assert from "node:assert/strict";
import test from "node:test";
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
  parseConsolidatedGroupMembership,
  resolveFrozenUsConsolidatedMatching,
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
  });
  const posted = matchingPeriodPersistFacts({
    matched: live,
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
