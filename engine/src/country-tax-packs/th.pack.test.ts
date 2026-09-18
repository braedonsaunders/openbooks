import assert from "node:assert/strict";
import test from "node:test";
import { assertPackCodeRateSchedule, packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { THAILAND_TAX_PACK } from "./th.ts";
import type { EffectiveTaxRate } from "./types.ts";

function assertContiguous(rates: readonly EffectiveTaxRate[]): void {
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1]!;
    const current = rates[index]!;
    assert.ok(prior.effectiveTo, `rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10));
  }
}

test("Thailand pack is found by country with one P.P.30 return and the maintained version pin", () => {
  assert.equal(THAILAND_TAX_PACK.country, "TH");
  assert.equal(THAILAND_TAX_PACK.code, "TH_INDIRECT_TAX");
  assert.equal(THAILAND_TAX_PACK.countryTaxType, "vat");
  assert.equal(THAILAND_TAX_PACK.version, "2026.08.01");
  assert.equal(THAILAND_TAX_PACK.returnPacks.length, 1);
  assert.equal(THAILAND_TAX_PACK.parentReturnPackCode, "TH_PP30");
  assert.equal(THAILAND_TAX_PACK.returnPacks[0]!.code, "TH_PP30");
});

test("Thailand return carries the real P.P.30 computation items plus the two OB workpaper boxes", () => {
  assert.deepEqual(THAILAND_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Thailand filing is monthly portal entry through Revenue Department e-Filing", () => {
  const returnPack = THAILAND_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "monthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /efiling\.rd\.go\.th/);
});

test("Thailand declares the decree 7% band as standard and a Section 80/1 zero band for exports", () => {
  const codes = packTaxCodesForReturn(THAILAND_TAX_PACK, "TH_PP30");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["TH-VAT-STD", "standard", 7],
    ["TH-VAT-ZERO", "zero", 0],
  ]);
});

test("Thailand primary code is the standard 7% band", () => {
  assert.equal(primaryPackTaxCode(THAILAND_TAX_PACK, "TH_PP30")?.code, "TH-VAT-STD");
});

test("Thailand rate schedules are contiguous and every sourceId resolves", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(THAILAND_TAX_PACK), ["TH_PP30"]);
  const sourceIds = new Set(THAILAND_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(THAILAND_TAX_PACK, "TH_PP30")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
  }
});

test("Thailand VAT is national with no subnational VAT jurisdictions", () => {
  assert.equal(THAILAND_TAX_PACK.jurisdictions.length, 0);
});

test("Thailand standard band covers the pinned date and expires on the decree end date", () => {
  const codes = packTaxCodesForReturn(THAILAND_TAX_PACK, "TH_PP30");
  const standard = codes.find((code) => code.code === "TH-VAT-STD")!;
  const zero = codes.find((code) => code.code === "TH-VAT-ZERO")!;
  assertPackCodeRateSchedule("TH_INDIRECT_TAX/TH_PP30/TH-VAT-STD", standard, "2026-09-18");
  assertPackCodeRateSchedule("TH_INDIRECT_TAX/TH_PP30/TH-VAT-STD", standard, "2026-09-30");
  assertPackCodeRateSchedule("TH_INDIRECT_TAX/TH_PP30/TH-VAT-ZERO", zero, "2026-09-18");
  assert.equal(standard.rates!.at(-1)!.effectiveTo, "2026-09-30");
  assert.throws(
    () => assertPackCodeRateSchedule("TH_INDIRECT_TAX/TH_PP30/TH-VAT-STD", standard, "2026-10-01"),
    /TH-VAT-STD has no rate covering 2026-10-01.*successor rate/,
  );
});
