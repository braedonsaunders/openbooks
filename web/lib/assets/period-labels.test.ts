import assert from "node:assert/strict";
import test from "node:test";
import type {
  DepreciationPreview,
  RunDepreciationResult,
} from "@openbooks/engine/assets/depreciation";
import { labelDepreciationPreview, labelDepreciationRun } from "./period-labels.ts";

const december2025 = {
  fiscalYear: 2025,
  periodNumber: 12,
  adjustment: false,
  startsOn: "2025-12-01",
  endsOn: "2025-12-31",
};
const july2026 = {
  fiscalYear: 2026,
  periodNumber: 7,
  adjustment: false,
  startsOn: "2026-07-01",
  endsOn: "2026-07-31",
};

test("preview lines and manual-entry candidates read by fiscal position and month in the viewer's locale", () => {
  const preview = {
    rows: [
      { lineId: "line-1", periodName: "P12 FY2025", periodRef: december2025, amount: "10.0000" },
      { lineId: "line-2", periodName: "P07 FY2026", periodRef: july2026, amount: "12.0000" },
    ],
    manualEntryCandidates: [
      { lineId: "line-2", periodName: "P07 FY2026", periodRef: july2026, entryNumber: "JE-1" },
    ],
    warnings: ["FA-1 P07 FY2026: manual entry JE-1 already posts 12.0000"],
    fingerprint: "abc",
  } as unknown as DepreciationPreview;

  const labelled = labelDepreciationPreview(preview, "en");
  assert.deepEqual(
    labelled.rows.map((row) => row.periodName),
    ["P12 FY2025 · Dec 2025", "P07 FY2026 · Jul 2026"],
  );
  assert.equal(labelled.manualEntryCandidates[0]!.periodName, "P07 FY2026 · Jul 2026");
  // Locale-free text, identities and the fingerprint are untouched.
  assert.deepEqual(labelled.warnings, preview.warnings);
  assert.equal(labelled.fingerprint, "abc");
  assert.equal(labelled.rows[1]!.amount, "12.0000");
  // The engine payload is not mutated.
  assert.equal(preview.rows[0]!.periodName, "P12 FY2025");
});

test("every per-line run result labels its period; problem text stays locale-free", () => {
  const result = {
    posted: 1,
    entries: [
      {
        assetId: "a",
        assetNumber: "FA-1",
        period: "P12 FY2025",
        periodRef: december2025,
        amount: "10.0000",
        entryId: "e",
        lineId: "l1",
      },
    ],
    recordedEntries: [
      {
        assetId: "b",
        assetNumber: "FA-2",
        period: "P07 FY2026",
        periodRef: july2026,
        amount: "5.0000",
        lineId: "l2",
      },
    ],
    skippedAssets: [
      {
        assetNumber: "FA-3",
        period: "P07 FY2026",
        periodRef: july2026,
        reason: "GL period closed",
      },
    ],
    problemItems: [
      {
        assetNumber: "FA-3",
        period: "P07 FY2026",
        periodRef: july2026,
        message: "GL period closed",
      },
    ],
    problems: ["FA-3 P07 FY2026: GL period closed"],
    nextDue: {
      assetNumber: "FA-4",
      period: "P07 FY2026",
      periodRef: july2026,
      endsOn: "2026-07-31",
      amount: "1.0000",
    },
  } as unknown as RunDepreciationResult;

  const labelled = labelDepreciationRun(result, "en");
  assert.equal(labelled.entries[0]!.period, "P12 FY2025 · Dec 2025");
  assert.equal(labelled.recordedEntries[0]!.period, "P07 FY2026 · Jul 2026");
  assert.equal(labelled.skippedAssets[0]!.period, "P07 FY2026 · Jul 2026");
  assert.equal(labelled.problemItems[0]!.period, "P07 FY2026 · Jul 2026");
  assert.equal(labelled.nextDue?.period, "P07 FY2026 · Jul 2026");
  assert.deepEqual(labelled.problems, ["FA-3 P07 FY2026: GL period closed"]);
  assert.equal(labelled.entries[0]!.entryId, "e");

  assert.equal(labelDepreciationRun({ ...result, nextDue: null }, "en").nextDue, null);
});
