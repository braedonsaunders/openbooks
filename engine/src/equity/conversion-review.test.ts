import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../platform/db.ts";
import { conversionOnVoidedTermsAsRecorded } from "./conversion-review.ts";
import type { EquityBook, SecurityEventRecord, SecurityRecord, ShareClassRecord } from "./types.ts";

const COMMON: ShareClassRecord = {
  id: "c-common", code: "CS", name: "Common", kind: "common", effectiveOn: "2026-01-01", initialAuthorizedShares: 20_000_000n,
  parValue: "0.0001", originalIssuePrice: null, initialConversionPrice: null, liquidationMultiple: null,
  participation: "none", participationCapMultiple: null, seniority: 0, antiDilution: "none",
  conversionShareClassId: null, conversionAdjustsForSplits: true, liquidationPreferenceBasis: "original_issue_price",
};
const SEED: ShareClassRecord = {
  ...COMMON, id: "c-seed", code: "SS", name: "Series Seed", kind: "preferred", originalIssuePrice: "1.0000000000", initialConversionPrice: "1.0000000000",
  liquidationMultiple: "1.0000", seniority: 1, conversionShareClassId: COMMON.id, liquidationPreferenceBasis: "amount_paid",
};

function security(overrides: Partial<SecurityRecord> & Pick<SecurityRecord, "id" | "kind">): SecurityRecord {
  return {
    securityNumber: overrides.id.toUpperCase(), holderPartyId: "holder", shareClassId: null, planId: null, roundId: null, sourceSecurityId: null,
    issueDate: "2026-01-01", quantity: null, pricePerShare: null, considerationAmount: null, currency: "USD",
    vestingStart: null, vestingMonths: null, cliffMonths: null, vestingFrequency: null, vestingTranches: null,
    acceleration: "none", accelerationPercent: null, expirationDate: null, optionType: null, earlyExercise: false,
    safeType: null, valuationCap: null, discountPercent: null, interestRatePercent: null, interestBasis: null, interestDayCount: null,
    maturityDate: null, fairValuePerUnit: null, expenseAttribution: null, mfn: false, unvestedRepurchaseBasis: null, fxRate: "1",
    ...overrides,
  };
}
const event = (overrides: Partial<SecurityEventRecord> & Pick<SecurityEventRecord, "id" | "securityId" | "kind" | "effectiveOn">): SecurityEventRecord => ({
  quantity: null, pricePerShare: null, amount: null, resultingSecurityId: null, roundId: null, reversesEventId: null, ...overrides,
});

/** Only currency minor units are read; every instrument here is stated in the round's currency. */
const runner = { execute: async () => ({ rows: [{ minor_units: 2 }] }) } as unknown as SqlExecutor;

function book(recordedPrice: string): EquityBook {
  const mfn = security({ id: "s-mfn", kind: "safe", considerationAmount: "100000.0000", safeType: "pre_money", mfn: true });
  const later = security({ id: "s-later", kind: "safe", issueDate: "2026-02-01", considerationAmount: "50000.0000", safeType: "post_money", valuationCap: "400000.0000" });
  return {
    classes: [COMMON, SEED], amendments: [], splits: [], plans: [], reserveChanges: [],
    rounds: [{ id: "r-1", name: "Seed", shareClassId: SEED.id, closedOn: "2026-02-28", pricePerShare: "1.0000000000", preMoneyValuation: "1000000.0000", currency: "USD", preMoneyBasisReason: null }],
    securities: [
      security({ id: "s-common", kind: "share", shareClassId: COMMON.id, quantity: 1_000_000n, pricePerShare: "0.0001000000" }),
      mfn, later,
      security({ id: "s-cert", kind: "share", shareClassId: SEED.id, roundId: "r-1", sourceSecurityId: mfn.id, issueDate: "2026-02-28", quantity: 100_000n, pricePerShare: recordedPrice }),
    ],
    events: [
      event({ id: "e-void", securityId: later.id, kind: "void", effectiveOn: "2026-02-27" }),
      event({ id: "e-convert", securityId: mfn.id, kind: "convert", effectiveOn: "2026-02-28", roundId: "r-1", resultingSecurityId: "s-cert", pricePerShare: recordedPrice }),
    ],
    securityAmendments: [{ id: "am-1", securityId: mfn.id, kind: "mfn_election", effectiveOn: "2026-02-10", sourceSecurityId: later.id, valuationCap: "400000.0000", discountPercent: null, safeType: "post_money", reversesAmendmentId: null }],
  };
}

test("a conversion recorded while an election named a void instrument stands when it was measured on the SAFE's own terms", async () => {
  const ownTerms = book("1.0000000000");
  assert.equal(await conversionOnVoidedTermsAsRecorded(runner, "org", ownTerms, ownTerms.securities[1]!, "2026-03-01", "USD"), null);
});

test("a conversion measured on the void instrument's terms is flagged for correction", async () => {
  const adopted = book("0.3333333333");
  const flagged = await conversionOnVoidedTermsAsRecorded(runner, "org", adopted, adopted.securities[1]!, "2026-03-01", "USD");
  assert.deepEqual(flagged, { electionId: "am-1", sourceSecurityId: "s-later", sourceVoidedOn: "2026-02-27", resultingSecurityId: "s-cert" });
});
