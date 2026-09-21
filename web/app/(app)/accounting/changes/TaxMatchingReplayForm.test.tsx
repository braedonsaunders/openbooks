import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaxMatchingReplayForm } from "./TaxMatchingReplayForm";
import { prepareTaxMatchingReplay } from "./tax-matching-replay-draft";

Object.assign(globalThis, { React });
const preview = {
  assetId: "00000000-0000-4000-8000-000000000001",
  replacementWorkpaperId: "00000000-0000-4000-8000-000000000002",
  replacementWorkpaperChangeId: "00000000-0000-4000-8000-000000000003",
  latestPoolYearStart: "2027-01-01",
  citedHistoricalPeriodIds: ["00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"],
  replacementOpening: "50.0001",
  replayedPeriods: [{ yearStart: "2026-01-01", yearEnd: "2026-06-30", taxYearWindowId: "first-window",
    vintageKey: "carryover:2023-01-01:2025-07-01", priorMatchingPeriodId: "00000000-0000-4000-8000-000000000004",
    deferredOpening: "50.0001", actualDeduction: "7.5000", recomputedDeduction: "5.0000",
    actualCorrespondingAmount: "-7.5000", recomputedCorrespondingAmount: "-5.0000",
    sellerMatchingAmount: "2.5000", deferredClosing: "47.5001" }],
  historical: [
    { id: "00000000-0000-4000-8000-000000000004", workpaperId: "old-workpaper", vintageKey: "carryover:2023-01-01:2025-07-01",
      parentKey: "original:2023-01-01", taxYearWindowId: "first-window", yearStart: "2026-01-01", yearEnd: "2026-06-30",
      actualDeduction: "7.5000", recomputedDeduction: "5.0000" },
    { id: "00000000-0000-4000-8000-000000000005", workpaperId: "old-workpaper", vintageKey: "carryover:2023-01-01:2025-07-01",
      parentKey: "original:2023-01-01", taxYearWindowId: "second-window", yearStart: "2026-07-01", yearEnd: "2026-12-31",
      actualDeduction: "7.5000", recomputedDeduction: "5.0000" },
  ],
};

test("native replay uses the server citation set and sends no editable financial or membership facts", () => {
  const input = prepareTaxMatchingReplay(preview, preview.assetId, preview.replacementWorkpaperChangeId,
    "  Correct the approved intercompany gain  ", "request-key");
  assert.deepEqual(input, {
    replacementWorkpaperChangeId: preview.replacementWorkpaperChangeId,
    citedHistoricalPeriodIds: preview.citedHistoricalPeriodIds,
    reason: "Correct the approved intercompany gain", idempotencyKey: "request-key",
  });
  assert.notEqual(input.citedHistoricalPeriodIds, preview.citedHistoricalPeriodIds,
    "editing a submitted request cannot mutate the preview's citation set");
  const declared = JSON.stringify(input);
  assert.doesNotMatch(declared, /replacementOpening|actualDeduction|recomputedDeduction|Membership|yearStart|yearEnd/);
});

test("replay cannot be proposed using absent, cross-asset or stale replacement evidence", () => {
  for (const [label, value] of [
    ["not loaded", null],
    ["different asset", { ...preview, assetId: "another-asset" }],
    ["different workpaper", { ...preview, replacementWorkpaperChangeId: "another-change" }],
  ] as const) {
    assert.throws(() => prepareTaxMatchingReplay(value, preview.assetId, preview.replacementWorkpaperChangeId,
      "Correct the intercompany gain", "request"), /Reload matching history/, label);
  }
  assert.throws(() => prepareTaxMatchingReplay({ ...preview, citedHistoricalPeriodIds: [] }, preview.assetId,
    preview.replacementWorkpaperChangeId, "Correct the intercompany gain", "request"), /re-run the latest computed year/);
});

test("native replay preserves both same-label short years and exact opening with only a reason input", () => {
  const markup = renderToStaticMarkup(<TaxMatchingReplayForm formId="replay" preview={preview}
    reason="Correct the deferred gain" busy={false} onReasonChange={() => {}} onSubmit={() => {}} />);
  for (const fact of ["2026-01-01", "2026-06-30", "2026-07-01", "2026-12-31", "50.0001",
    "Cited historical matching periods", "Replacement opening deferred intercompany amount",
    "re-run the latest computed tax year only", "Open Fixed Assets tax pools"]) {
    assert.ok(markup.includes(fact), fact);
  }
  assert.equal((markup.match(/<textarea\b/g) ?? []).length, 1);
  assert.match(markup, /id="replay-reason"/);
  assert.match(markup, /minLength="8"/i);
  assert.match(markup, /maxLength="1000"/i);
  assert.doesNotMatch(markup, /<(?:input|select)\b/,
    "period IDs, dates, membership, deductions and opening are evidence, never operator-entry controls");
});

test("a refused preview retains the native pool remedy without offering a reason or proposal form input", () => {
  const markup = renderToStaticMarkup(<TaxMatchingReplayForm formId="replay" preview={null}
    reason="" busy={false} onReasonChange={() => {}} onSubmit={() => {}} />);
  assert.match(markup, /href="\/assets\/tax-pools"/);
  assert.doesNotMatch(markup, /<(?:input|select|textarea|button)\b/);
});
