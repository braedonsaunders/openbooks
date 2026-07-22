import assert from "node:assert/strict";
import test from "node:test";
import { computeImportedLineTaxEvidence } from "./tax-persist.ts";
import type { TaxComponentConfig } from "./tax.ts";

const hst: TaxComponentConfig[] = [
  {
    taxCodeId: "hst",
    sequence: 1,
    ratePercent: "13",
    recoverablePercent: "100",
    calculationType: "standard",
    priceIncludesTax: false,
    compoundOnPrevious: false,
    roundingScale: 2,
    collectedAccountId: "output",
    paidAccountId: "input",
    withholdingAccountId: null,
  },
];

test("imported tax evidence preserves an exact statutory result", () => {
  const [component] = computeImportedLineTaxEvidence(
    "100.0000",
    "13.0000",
    hst,
  );
  assert.equal(component?.taxableAmount, "100.0000");
  assert.equal(component?.taxAmount, "13.0000");
  assert.equal(component?.overridden, false);
});

test("imported tax evidence explicitly records source allocation and rounding overrides", () => {
  const [component] = computeImportedLineTaxEvidence(
    "354.7800",
    "46.1100",
    hst,
  );
  assert.equal(component?.taxAmount, "46.1100");
  assert.equal(component?.recoverableAmount, "46.1100");
  assert.equal(component?.nonrecoverableAmount, "0.0000");
  assert.equal(component?.overridden, true);
});

test("an imported zero-tax allocation still produces cross-footing evidence", () => {
  const [component] = computeImportedLineTaxEvidence("275.3600", "0.0000", hst);
  assert.equal(component?.taxAmount, "0.0000");
  assert.equal(component?.recoverableAmount, "0.0000");
  assert.equal(component?.nonrecoverableAmount, "0.0000");
  assert.equal(component?.overridden, true);
});
