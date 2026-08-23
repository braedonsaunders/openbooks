import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalDecimal } from "./exact-decimal.ts";
import { TAX_DEPRECIATION_REGIMES } from "./tax-depreciation-pool.ts";

const source = readFileSync(new URL("./tax-depreciation-packs.ts", import.meta.url), "utf8");

test("tax depreciation packs persist rates through canonicalDecimal then normalizeDecimal at FX scale", () => {
  const helperStart = source.indexOf("function persistPackFxRate");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistPackFxRate helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(rate, 10\)/);
  assert.match(helper, /normalizeDecimal\(exact, 10\)/);
  assert.match(helper, /pack rate must be an exact decimal/);
  assert.doesNotMatch(helper, /return normalizeDecimal\(rate, 10\)/);

  assert.match(source, /persistPackFxRate\(classDef\.rate\)/);
  assert.match(source, /persistPackFxRate\(classDef\.firstYearFraction\)/);
  assert.match(source, /persistPackFxRate\(classDef\.recoveryPeriodYears\)/);
});

test("tax depreciation packs persist costCap through canonicalDecimal then normalizeMoney", () => {
  const helperStart = source.indexOf("function persistPackCostCap");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistPackCostCap helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /cost cap must be an exact decimal/);
  assert.doesNotMatch(helper, /normalizeMoney\(classDef\.costCap\)/);
  assert.match(source, /persistPackCostCap\(classDef\.costCap\)/);
});

test("every shipped tax depreciation pack costCap is an exact ledger decimal", () => {
  for (const regime of Object.values(TAX_DEPRECIATION_REGIMES)) {
    for (const classDef of Object.values(regime.classes)) {
      if (classDef.costCap == null) continue;
      assert.ok(
        canonicalDecimal(classDef.costCap, 4),
        `${regime.code}/${classDef.code} costCap`,
      );
    }
  }
});

test("every shipped tax depreciation pack rate is an exact FX-scale decimal", () => {
  for (const regime of Object.values(TAX_DEPRECIATION_REGIMES)) {
    for (const classDef of Object.values(regime.classes)) {
      assert.ok(canonicalDecimal(classDef.rate, 10), `${regime.code}/${classDef.code} rate`);
      assert.ok(
        canonicalDecimal(classDef.firstYearFraction, 10),
        `${regime.code}/${classDef.code} firstYearFraction`,
      );
      if (classDef.recoveryPeriodYears != null) {
        assert.ok(
          canonicalDecimal(classDef.recoveryPeriodYears, 10),
          `${regime.code}/${classDef.code} recoveryPeriodYears`,
        );
      }
    }
  }
});
