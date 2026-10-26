import assert from "node:assert/strict";
import test from "node:test";
import type { PostingPeriodCandidate } from "@openbooks/engine/close/posting-periods";
import type { PeriodEndPreview } from "@openbooks/engine/close/period-end-journals";
import { labelPeriodEndPreview, labelPostingPeriodCandidates } from "./period-labels";

const december = (fiscalYear: number) => ({
  fiscalYear,
  periodNumber: 12,
  adjustment: false,
  startsOn: `${fiscalYear}-12-01`,
  endsOn: `${fiscalYear}-12-31`,
});
const adjustment = {
  fiscalYear: 2025,
  periodNumber: 13,
  adjustment: true,
  startsOn: "2025-12-31",
  endsOn: "2025-12-31",
};

function candidate(overrides: Partial<PostingPeriodCandidate>): PostingPeriodCandidate {
  return {
    documentId: "doc-1",
    documentNumber: "INV-1",
    kind: "invoice",
    subsidiaryId: null,
    effectiveDate: "2025-12-15",
    periodId: "period-1",
    periodName: "P12 FY2025",
    periodRef: december(2025),
    blocked: false,
    blockReason: null,
    adjustment: false,
    adjustmentPeriod: null,
    ...overrides,
  };
}

test("posting-period candidates read with the period label in every fiscal year", () => {
  const rows = labelPostingPeriodCandidates(
    [
      candidate({}),
      candidate({ documentId: "doc-2", periodName: "P12 FY2026", periodRef: december(2026) }),
    ],
    "en",
  );
  assert.deepEqual(
    rows.map((row) => row.periodName),
    ["P12 FY2025 · Dec 2025", "P12 FY2026 · Dec 2026"],
  );
});

test("the adjustment alternative is labelled in the viewer locale while its id and the refusal stay", () => {
  const blockReason =
    'period P12 FY2025 is closed for AR on this book; the open adjustment period "FY2025 adjustment" can take it instead';
  const [row] = labelPostingPeriodCandidates(
    [
      candidate({
        blocked: true,
        blockReason,
        adjustmentPeriod: { id: "adj-1", name: "FY2025 adjustment", periodRef: adjustment },
      }),
    ],
    "de",
  );
  assert.equal(row!.adjustmentPeriod?.id, "adj-1");
  assert.equal(row!.adjustmentPeriod?.name, "FY2025 adjustment · Dez. 2025");
  assert.equal(row!.blockReason, blockReason);
});

test("a candidate with no covering period keeps its empty label", () => {
  const [row] = labelPostingPeriodCandidates(
    [
      candidate({
        periodId: null,
        periodName: null,
        periodRef: null,
        blocked: true,
        blockReason: "no accounting period covers 2030-01-01",
      }),
    ],
    "en",
  );
  assert.equal(row!.periodName, null);
});

test("a period-end preview labels its closing, opening and journal periods", () => {
  const january = {
    fiscalYear: 2027,
    periodNumber: 1,
    adjustment: false,
    startsOn: "2027-01-01",
    endsOn: "2027-01-31",
  };
  const preview = {
    fiscalYear: {
      calendarId: "cal-1",
      fiscalYear: 2026,
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
      closingPeriod: { id: "dec", name: "P12 FY2026", periodRef: december(2026) },
      openingPeriod: { id: "jan", name: "P01 FY2027", periodRef: january },
    },
    entities: [
      {
        journals: [
          {
            kind: "income_statement",
            periodId: "dec",
            periodName: "P12 FY2026",
            periodRef: december(2026),
          },
          { kind: "opening", periodId: "jan", periodName: "P01 FY2027", periodRef: january },
        ],
      },
    ],
  } as unknown as PeriodEndPreview;
  const labelled = labelPeriodEndPreview(preview, "en");
  assert.equal(labelled.fiscalYear.closingPeriod?.name, "P12 FY2026 · Dec 2026");
  assert.equal(labelled.fiscalYear.openingPeriod?.name, "P01 FY2027 · Jan 2027");
  assert.deepEqual(
    labelled.entities[0]!.journals.map((journal) => journal.periodName),
    ["P12 FY2026 · Dec 2026", "P01 FY2027 · Jan 2027"],
  );
});
