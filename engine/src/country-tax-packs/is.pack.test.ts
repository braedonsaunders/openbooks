import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { ICELAND_TAX_PACK } from "./is.ts";
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

test("Iceland pack is found by country with one VSK return and the maintained version pin", () => {
  assert.equal(ICELAND_TAX_PACK.country, "IS");
  assert.equal(ICELAND_TAX_PACK.code, "IS_INDIRECT_TAX");
  assert.equal(ICELAND_TAX_PACK.countryTaxType, "vat");
  assert.equal(ICELAND_TAX_PACK.version, "2026.08.01");
  assert.equal(ICELAND_TAX_PACK.returnPacks.length, 1);
  assert.equal(ICELAND_TAX_PACK.parentReturnPackCode, "IS_VSK");
  assert.equal(ICELAND_TAX_PACK.returnPacks[0]!.code, "IS_VSK");
});

test("Iceland return carries turnover per band, output/input VSK, the payable amount, plus the two OB workpaper boxes", () => {
  assert.deepEqual(ICELAND_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "VELTA-24", "VELTA-11", "VELTA-0", "UTSKATTUR", "INNSKATTUR", "MISMUNUR", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Iceland filing is bimonthly portal entry through the Skatturinn VAT page", () => {
  const returnPack = ICELAND_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "bimonthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /skatturinn\.is/);
});

test("Iceland declares the 24/11/0 bands with honest roles", () => {
  const codes = packTaxCodesForReturn(ICELAND_TAX_PACK, "IS_VSK");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["IS-VAT-STD", "standard", 24],
    ["IS-VAT-RED11", "reduced", 11],
    ["IS-VAT-ZERO", "zero", 0],
  ]);
});

test("Iceland primary code is the standard 24% band", () => {
  assert.equal(primaryPackTaxCode(ICELAND_TAX_PACK, "IS_VSK")?.code, "IS-VAT-STD");
});

test("Iceland rate schedules are contiguous and every sourceId resolves", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(ICELAND_TAX_PACK), ["IS_VSK"]);
  const sourceIds = new Set(ICELAND_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(ICELAND_TAX_PACK, "IS_VSK")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
  }
});

test("Iceland VSK is national with no subnational VAT jurisdictions", () => {
  assert.equal(ICELAND_TAX_PACK.jurisdictions.length, 0);
});
