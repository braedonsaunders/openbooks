import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { COLOMBIA_TAX_PACK } from "./co.ts";
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

test("Colombia pack is found by country with one Formulario 300 return and the maintained version pin", () => {
  assert.equal(COLOMBIA_TAX_PACK.country, "CO");
  assert.equal(COLOMBIA_TAX_PACK.code, "CO_INDIRECT_TAX");
  assert.equal(COLOMBIA_TAX_PACK.countryTaxType, "vat");
  assert.equal(COLOMBIA_TAX_PACK.version, "2026.08.01");
  assert.equal(COLOMBIA_TAX_PACK.returnPacks.length, 1);
  assert.equal(COLOMBIA_TAX_PACK.parentReturnPackCode, "CO_F300");
  assert.equal(COLOMBIA_TAX_PACK.returnPacks[0]!.code, "CO_F300");
});

test("Colombia return carries the real Form 300 renglones plus the two OB workpaper boxes", () => {
  assert.deepEqual(COLOMBIA_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "27", "28", "35", "57", "58", "65", "75", "79", "80", "81", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Colombia files bimonthly through MUISCA as portal entry", () => {
  const returnPack = COLOMBIA_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "bimonthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /dian\.gov\.co/);
});

test("Colombia declares the 19/5/0 bands with honest roles and no excluidos code", () => {
  const codes = packTaxCodesForReturn(COLOMBIA_TAX_PACK, "CO_F300");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["CO-VAT-STD", "standard", 19],
    ["CO-VAT-RED5", "reduced", 5],
    ["CO-VAT-ZERO", "zero", 0],
  ]);
  assert.equal(codes.length, 3);
});

test("Colombia primary code is the standard 19% band", () => {
  assert.equal(primaryPackTaxCode(COLOMBIA_TAX_PACK, "CO_F300")?.code, "CO-VAT-STD");
});

test("Colombia rate schedules are contiguous and every sourceId resolves", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(COLOMBIA_TAX_PACK), ["CO_F300"]);
  const sourceIds = new Set(COLOMBIA_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(COLOMBIA_TAX_PACK, "CO_F300")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
  }
});

test("Colombia IVA is national with no subnational VAT jurisdictions", () => {
  assert.equal(COLOMBIA_TAX_PACK.jurisdictions.length, 0);
});
