import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { macrsVintageKey } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import { MacrsVintageAllocations } from "./MacrsVintageAllocations";
import type {
  MacrsAllocationEdits,
  OpenMacrsVintage,
} from "./macrs-vintage-allocation-draft";

Object.assign(globalThis, { React });
const identity = {
  source: "carryover" as const,
  placedInServiceOn: "2024-03-15",
  transferOn: "2025-08-20",
};
const vintage: OpenMacrsVintage = {
  ...identity,
  key: macrsVintageKey(identity),
  parentKey: null,
  unadjustedBasis: "1000.0001",
  adjustedCarryover: "850.0000",
  section179: "0.0000",
  priorDepreciation: "150.0001",
  recoveryPeriodYears: "5",
  method: "200_db",
  convention: "half_year",
  bonusPercent: "0",
  businessUsePercent: "100",
};
function render(edits: MacrsAllocationEdits = {}, disabled = false) {
  return renderToStaticMarkup(
    <MacrsVintageAllocations
      vintages={[vintage]}
      edits={edits}
      disabled={disabled}
      onChange={() => {}}
    />,
  );
}

test("native allocation controls keep identities fixed and start with unanswered money", () => {
  const markup = render();
  assert.match(markup, /§168\(i\)\(7\) carryover — transferor history/);
  assert.match(markup, /2024-03-15/);
  assert.match(markup, /2025-08-20/);
  assert.match(markup, /5-year 200_db \/ half_year/);
  assert.match(markup, /1000.0001/);
  assert.match(markup, /850.0000/);
  const inputs = markup.match(/<input\b[^>]*>/g) ?? [];
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.match(input, /required=""/);
    assert.match(input, /inputMode="decimal"/);
    assert.match(input, /value=""/);
    assert.doesNotMatch(input, /type="number"|value="(?:2024|2025|0)/);
  }
  assert.doesNotMatch(markup, /<output>/);
});

test("exact totals are outputs rather than a competing editable header", () => {
  const markup = render({
    [vintage.key]: {
      disposedUnadjustedBasis: "250.0001",
      remainingUnadjustedBasis: "750.0000",
    },
  });
  assert.match(markup, /<output>250.0001<\/output>/);
  assert.match(markup, /<output>750.0000<\/output>/);
  assert.equal((markup.match(/<input\b/g) ?? []).length, 2);
});

test("an invalid allocation presents its refusal instead of displaying misleading totals", () => {
  const markup = render({
    [vintage.key]: {
      disposedUnadjustedBasis: "1001",
      remainingUnadjustedBasis: "0",
    },
  });
  assert.match(markup, /must add to the open unadjusted tax basis 1000.0001/);
  assert.doesNotMatch(markup, /<output>/);
});

test("all allocation inputs respect the pending-action lock", () => {
  for (const input of render({}, true).match(/<input\b[^>]*>/g) ?? []) {
    assert.match(input, /disabled=""/);
  }
});
