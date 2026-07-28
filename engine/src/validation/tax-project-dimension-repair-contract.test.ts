import assert from "node:assert/strict";
import test from "node:test";
import {
  reversalPairViolations,
  type TaxProjectDimensionCandidate,
} from "./tax-project-dimension-repair-contract.ts";

function candidate(
  overrides: Partial<TaxProjectDimensionCandidate> = {},
): TaxProjectDimensionCandidate {
  return {
    lineId: "line-original",
    entryId: "entry-original",
    entryStatus: "reversed",
    reversesEntryId: null,
    reversalEntryId: "entry-reversal",
    reversalEntryCount: 1,
    documentId: "document",
    documentNumber: "INV-1",
    periodId: "period",
    bookId: "book",
    subsidiaryId: "subsidiary",
    projectId: "project",
    equipmentUnitId: null,
    taxCodeId: "tax",
    accountId: "tax-control",
    amount: "-5591.5600",
    currency: "CAD",
    txnAmount: "-5591.5600",
    fxRate: "1.0000000000",
    ...overrides,
  };
}

test("accepts an exact dimension-preserving reversal pair", () => {
  const original = candidate();
  const reversal = candidate({
    lineId: "line-reversal",
    entryId: "entry-reversal",
    entryStatus: "posted",
    reversesEntryId: "entry-original",
    reversalEntryId: null,
    reversalEntryCount: 0,
    amount: "5591.5600",
    txnAmount: "5591.5600",
  });
  assert.deepEqual(reversalPairViolations([original, reversal]), []);
});

test("rejects a one-sided reversal-pair amendment population", () => {
  const violations = reversalPairViolations([candidate()]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.reason, /exact inverse candidate/);
});

test("rejects an inverse amount carrying a different project", () => {
  const original = candidate();
  const reversal = candidate({
    lineId: "line-reversal",
    entryId: "entry-reversal",
    entryStatus: "posted",
    reversesEntryId: "entry-original",
    reversalEntryId: null,
    reversalEntryCount: 0,
    amount: "5591.5600",
    txnAmount: "5591.5600",
    projectId: "different-project",
  });
  const violations = reversalPairViolations([original, reversal]);
  assert.equal(violations.length, 2);
});
