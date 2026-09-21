import assert from "node:assert/strict";
import test from "node:test";
import { add, formatMoney } from "../money/money.ts";
import {
  allocatedDeferredOpeningsByVintage,
  CONSOLIDATED_MEMBERSHIP_IDENTITY,
  replayMatchingPaperFromCitedHistory,
  type HistoricalMatchingPeriodEvidence,
} from "./consolidated-macrs-matching.ts";

const CARRYOVER = "carryover:2023-01-01:2025-08-20:original:2023-01-01";
const EXCESS = "excess:2025-08-20:2025-08-20";
const ORPHAN = "excess:2030-01-01:2030-01-01";
const WEIGHTS = [
  { vintageKey: CARRYOVER, amount: "100.0000" },
  { vintageKey: EXCESS, amount: "50.0000" },
];
const sum = (values: readonly string[]) =>
  formatMoney(values.reduce((total, value) => add(total, value), "0"), 4);

test("an unposted vintage cannot absorb part of the opening from a replayed paper", () => {
  assert.throws(() => allocatedDeferredOpeningsByVintage({
    paperOpening: "50.0000",
    vintageKeys: [CARRYOVER, EXCESS],
    vintageWeights: [...WEIGHTS, { vintageKey: ORPHAN, amount: "50.0000" }],
  }), (error: unknown) => error instanceof Error && error.message.includes(ORPHAN),
  "an extra weight would allocate 12.5000 to a vintage for which replay writes no row; refuse and name that vintage");
});

test("a posted excess vintage cannot disappear from the opening allocation", () => {
  assert.throws(() => allocatedDeferredOpeningsByVintage({
    paperOpening: "50.0000",
    vintageKeys: [CARRYOVER, EXCESS],
    vintageWeights: [WEIGHTS[0]!],
  }), (error: unknown) => error instanceof Error && error.message.includes(EXCESS),
  "carryover-only reconstruction must not assign the excess vintage's share to the carryover");
});

test("duplicate requested vintages cannot multiply a conserved opening when rows are emitted", () => {
  assert.throws(() => allocatedDeferredOpeningsByVintage({
    paperOpening: "50.0000",
    vintageKeys: [CARRYOVER, CARRYOVER],
    vintageWeights: [WEIGHTS[0]!],
  }), (error: unknown) => error instanceof Error && error.message.includes(CARRYOVER),
  "a Map with one opening is insufficient when the caller would emit it twice");
});

test("a signed intercompany gain larger than basis weights is allocated once, independently of row order", () => {
  const weights = [
    { vintageKey: CARRYOVER, amount: "10.0000" },
    { vintageKey: EXCESS, amount: "10.0000" },
  ];
  const gain = allocatedDeferredOpeningsByVintage({
    paperOpening: "50.0001", vintageKeys: [CARRYOVER, EXCESS], vintageWeights: weights,
  });
  const loss = allocatedDeferredOpeningsByVintage({
    paperOpening: "-50.0001", vintageKeys: [EXCESS, CARRYOVER], vintageWeights: [...weights].reverse(),
  });
  assert.deepEqual([...gain].sort(), [[CARRYOVER, "25.0001"], [EXCESS, "25.0000"]]);
  assert.deepEqual([...loss].sort(), [[CARRYOVER, "-25.0001"], [EXCESS, "-25.0000"]]);
  assert.equal(sum([...gain.values()]), "50.0001");
  assert.equal(sum([...loss.values()]), "-50.0001");
});

function historical(
  year: number,
  vintageKey: string,
  actualDeduction: string,
  recomputedDeduction: string,
): HistoricalMatchingPeriodEvidence {
  return {
    id: `${year}:${vintageKey}`,
    workpaperId: "prior-workpaper",
    vintageKey,
    parentKey: vintageKey === CARRYOVER ? "original:2023-01-01" : null,
    taxYearWindowId: `window-${year}`,
    yearStart: `${year}-01-01`,
    yearEnd: `${year}-12-31`,
    actualDeduction,
    recomputedDeduction,
  };
}

test("carryover and excess replay preserve one paper opening through both posted years", () => {
  const evidence = [
    historical(2025, CARRYOVER, "15.0000", "10.0000"),
    historical(2025, EXCESS, "10.0000", "0.0000"),
    historical(2026, CARRYOVER, "12.0000", "10.0000"),
    historical(2026, EXCESS, "8.0000", "0.0000"),
  ];
  const unchanged = structuredClone(evidence);
  const input = {
    replacementWorkpaperId: "replacement-workpaper",
    replacementWorkpaperChangeId: "approved-replacement-change",
    replacementOpening: "50.0000",
    replacementMembership: {
      identity: CONSOLIDATED_MEMBERSHIP_IDENTITY,
      groupKey: "Income-tax group",
      sellerSubsidiaryId: "11111111-1111-4111-8111-111111111111",
      buyerSubsidiaryId: "22222222-2222-4222-8222-222222222222",
      effectiveOn: "2023-01-01",
      throughOn: "2026-12-31",
    },
    historical: evidence,
    vintageWeights: WEIGHTS,
  } satisfies Parameters<typeof replayMatchingPaperFromCitedHistory>[0];
  const rows = replayMatchingPaperFromCitedHistory(input);
  const reordered = replayMatchingPaperFromCitedHistory({
    ...input, historical: [...evidence].reverse(), vintageWeights: [...WEIGHTS].reverse(),
  });
  assert.deepEqual(reordered, rows, "input order cannot change posted matching amounts or lineage");
  assert.deepEqual(evidence, unchanged, "replay appends replacement evidence instead of changing its source");
  assert.equal(rows.length, 4);
  const first = rows.filter((row) => row.yearStart === "2025-01-01");
  const second = rows.filter((row) => row.yearStart === "2026-01-01");
  assert.equal(sum(first.map((row) => row.deferredOpening)), "50.0000");
  assert.equal(sum(first.map((row) => row.sellerMatchingAmount)), "15.0000");
  assert.equal(sum(first.map((row) => row.deferredClosing)), "35.0000");
  assert.equal(sum(second.map((row) => row.deferredOpening)), "35.0000");
  assert.equal(sum(second.map((row) => row.sellerMatchingAmount)), "10.0000");
  assert.equal(sum(second.map((row) => row.deferredClosing)), "25.0000");
  assert.equal(second.find((row) => row.vintageKey === EXCESS)!.deferredClosing, "-1.3333",
    "a per-vintage negative closing is preserved; clamping it would increase the paper closing");
  for (const row of rows) {
    assert.equal(sum([row.actualCorrespondingAmount, row.sellerMatchingAmount]), row.recomputedCorrespondingAmount,
      `${row.vintageKey} ${row.yearStart}: actual plus seller must equal recomputed`);
    assert.equal(sum([row.sellerMatchingAmount, row.deferredClosing]), row.deferredOpening,
      `${row.vintageKey} ${row.yearStart}: opening must equal matched plus closing`);
    assert.equal(row.priorMatchingPeriodId, `${row.yearStart.slice(0, 4)}:${row.vintageKey}`,
      `${row.vintageKey} ${row.yearStart}: keep the exact cited historical row`);
  }
});
