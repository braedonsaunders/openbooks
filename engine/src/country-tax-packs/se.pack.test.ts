import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { SWEDEN_TAX_PACK } from "./se.ts";
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

test("Sweden pack is found by country with one momsdeklaration return and the maintained version pin", () => {
  assert.equal(SWEDEN_TAX_PACK.country, "SE");
  assert.equal(SWEDEN_TAX_PACK.code, "SE_INDIRECT_TAX");
  assert.equal(SWEDEN_TAX_PACK.countryTaxType, "vat");
  assert.equal(SWEDEN_TAX_PACK.version, "2026.08.01");
  assert.equal(SWEDEN_TAX_PACK.returnPacks.length, 1);
  assert.equal(SWEDEN_TAX_PACK.parentReturnPackCode, "SE_MOMSDEKLARATION");
  assert.equal(SWEDEN_TAX_PACK.returnPacks[0]!.code, "SE_MOMSDEKLARATION");
});

test("Sweden return carries the real ruta boxes plus the two OB workpaper boxes", () => {
  assert.deepEqual(SWEDEN_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "05", "06", "07", "08", "10", "11", "12", "48", "49", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Sweden filing is quarterly portal entry through the Skatteverket momsdeklaration page", () => {
  const returnPack = SWEDEN_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "quarterly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /skatteverket\.se/);
});

test("Sweden declares the 25/12/6 bands with honest roles and no zero-rated code", () => {
  const codes = packTaxCodesForReturn(SWEDEN_TAX_PACK, "SE_MOMSDEKLARATION");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["SE-VAT-STD", "standard", 25],
    ["SE-VAT-RED12", "reduced", 12],
    ["SE-VAT-RED6", "reduced", 6],
  ]);
  assert.ok(!codes.some((code) => code.role === "zero"), "no zero-rated band on the return, so no zero code");
});

test("Sweden primary code is the standard 25% band", () => {
  assert.equal(primaryPackTaxCode(SWEDEN_TAX_PACK, "SE_MOMSDEKLARATION")?.code, "SE-VAT-STD");
});

test("Sweden rate schedules are contiguous and every sourceId resolves", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(SWEDEN_TAX_PACK), ["SE_MOMSDEKLARATION"]);
  const sourceIds = new Set(SWEDEN_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(SWEDEN_TAX_PACK, "SE_MOMSDEKLARATION")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
  }
});

test("Sweden moms is national with no subnational VAT jurisdictions", () => {
  assert.equal(SWEDEN_TAX_PACK.jurisdictions.length, 0);
});
