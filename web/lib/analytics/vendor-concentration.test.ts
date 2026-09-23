import assert from "node:assert/strict";
import test from "node:test";
import { concentrationBand, concentrationVerdict } from "./vendor-concentration.ts";

/**
 * OM-04: the overview gauge and the HHI card must agree. At hhi ≈ 0.28 the
 * gauge said "Balanced" while the card said "highly concentrated" — opposite
 * verdicts about the same portfolio, produced by design from two independent
 * thresholds. Both words now derive from one shared banding.
 */

test("standard HHI bands: boundaries match the DOJ/FTC 1500/2500 cutoffs", () => {
  assert.equal(concentrationBand(0), "diversified");
  assert.equal(concentrationBand(1500), "diversified");
  assert.equal(concentrationBand(1501), "moderate");
  assert.equal(concentrationBand(2500), "moderate");
  assert.equal(concentrationBand(2501), "highlyConcentrated");
  assert.equal(concentrationBand(10000), "highlyConcentrated");
});

test("gauge and card agree inside every band", () => {
  const cases: Array<{
    hhiScaled: number;
    band: "diversified" | "moderate" | "highlyConcentrated";
    gaugeKey: string;
    subKey: string;
  }> = [
    { hhiScaled: 1000, band: "diversified", gaugeKey: "gauge.diversified", subKey: "sub.diversified" },
    { hhiScaled: 2000, band: "moderate", gaugeKey: "gauge.balanced", subKey: "sub.moderate" },
    // The reported contradiction: hhi ≈ 0.28 read "Balanced" on the gauge
    // and "highly concentrated" on the card. Both must now land concentrated.
    { hhiScaled: 2800, band: "highlyConcentrated", gaugeKey: "gauge.concentrated", subKey: "sub.highlyConcentrated" },
  ];
  for (const c of cases) {
    const verdict = concentrationVerdict(c.hhiScaled);
    assert.equal(verdict.band, c.band, `hhiScaled=${c.hhiScaled}`);
    assert.equal(verdict.gaugeKey, c.gaugeKey, `hhiScaled=${c.hhiScaled} gauge`);
    assert.equal(verdict.subKey, c.subKey, `hhiScaled=${c.hhiScaled} card`);
  }
});

test("the 0.28 fixture can no longer produce the contradictory pair", () => {
  const verdict = concentrationVerdict(2800);
  assert.notEqual(
    verdict.gaugeKey,
    "gauge.balanced",
    "a highly-concentrated portfolio must never read Balanced on the gauge",
  );
});
