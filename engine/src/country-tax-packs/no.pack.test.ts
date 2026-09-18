import assert from "node:assert/strict";
import test from "node:test";
import { packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { NORWAY_TAX_PACK } from "./no.ts";
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

test("Norway pack is found by country with one skattemelding return and the maintained version pin", () => {
  assert.equal(NORWAY_TAX_PACK.country, "NO");
  assert.equal(NORWAY_TAX_PACK.code, "NO_INDIRECT_TAX");
  assert.equal(NORWAY_TAX_PACK.countryTaxType, "vat");
  assert.equal(NORWAY_TAX_PACK.version, "2026.08.01");
  assert.equal(NORWAY_TAX_PACK.returnPacks.length, 1);
  assert.equal(NORWAY_TAX_PACK.parentReturnPackCode, "NO_MVA_MELDING");
  assert.equal(NORWAY_TAX_PACK.returnPacks[0]!.code, "NO_MVA_MELDING");
});

test("Norway return carries the real SAF-T mvaKode boxes plus the two OB workpaper boxes", () => {
  assert.deepEqual(NORWAY_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "3", "31", "33", "32", "5", "6", "1", "11", "13", "12", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Norway files bimonthly through the efile API from the Skatteetaten VAT-return page", () => {
  const returnPack = NORWAY_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "bimonthly");
  assert.equal(returnPack.submissionChannel, "efile_api");
  assert.equal(returnPack.governmentFormat, "api");
  assert.match(returnPack.submissionUrl, /skatteetaten\.no/);
});

test("Norway declares the 25/15/12 bands with honest roles and an unroled 11.11 band", () => {
  const codes = packTaxCodesForReturn(NORWAY_TAX_PACK, "NO_MVA_MELDING");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["NO-VAT-STD", "standard", 25],
    ["NO-VAT-FOOD", "reduced", 15],
    ["NO-VAT-PASSENGER", "reduced", 12],
    ["NO-VAT-FISH-1111", undefined, 11.11],
  ]);
});

test("Norway primary code is the standard 25% band", () => {
  assert.equal(primaryPackTaxCode(NORWAY_TAX_PACK, "NO_MVA_MELDING")?.code, "NO-VAT-STD");
});

test("Norway rate schedules are contiguous and every sourceId resolves", () => {
  assert.deepEqual(Object.keys(NORWAY_TAX_PACK.returnPackTaxCodes), ["NO_MVA_MELDING"]);
  const sourceIds = new Set(NORWAY_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(NORWAY_TAX_PACK, "NO_MVA_MELDING")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
  }
});

test("Norway MVA is national with no subnational VAT jurisdictions", () => {
  assert.equal(NORWAY_TAX_PACK.jurisdictions.length, 0);
});
