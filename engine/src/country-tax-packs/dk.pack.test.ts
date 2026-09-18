import assert from "node:assert/strict";
import test from "node:test";
import { DENMARK_TAX_PACK } from "./dk.ts";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import type { EffectiveTaxRate } from "./types.ts";

const pack = DENMARK_TAX_PACK;

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

test("Denmark pack is found by country and carries exactly one return pack", () => {
  assert.equal(pack.country, "DK");
  assert.equal(pack.code, "DK_INDIRECT_TAX");
  assert.equal(pack.returnPacks.length, 1);
  assert.equal(pack.parentReturnPackCode, "DK_MOMS");
  assert.equal(pack.returnPacks[0]!.code, "DK_MOMS");
});

test("Denmark pack carries the maintained version pin and no subnational jurisdictions", () => {
  assert.equal(pack.version, "2026.08.01");
  assert.deepEqual(pack.jurisdictions, []);
});

test("Denmark moms return declares the real portal fields plus the OpenBooks workpapers", () => {
  assert.deepEqual(pack.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "SALGSMOMS",
    "EU_VAREKOEB_MOMS",
    "UDLAND_YDELSER_MOMS",
    "KOEBSMOMS",
    "MOMSRESULTAT",
    "OB_OUTPUT",
    "OB_INPUT",
  ]);
});

test("every Denmark rate sourceId resolves to a sources entry", () => {
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  for (const returnCode of packReturnCodesWithTaxCodes(pack)) {
    const definitions = packTaxCodesForReturn(pack, returnCode);
    assert.ok(definitions.length > 0, `${returnCode} declares no tax codes`);
    for (const definition of definitions) {
      for (const rate of definition.rates ?? []) {
        assert.ok(sourceIds.has(rate.sourceId), `${definition.code} cites unknown source ${rate.sourceId}`);
      }
    }
  }
});

test("Denmark rate history is contiguous", () => {
  for (const returnCode of packReturnCodesWithTaxCodes(pack)) {
    for (const definition of packTaxCodesForReturn(pack, returnCode)) {
      assertContiguous(definition.rates ?? []);
    }
  }
});

test("Denmark single 25% band runs back to 1992 as one open row", () => {
  const definitions = packTaxCodesForReturn(pack, "DK_MOMS");
  assert.equal(definitions.length, 1);
  assert.deepEqual(definitions[0]!.rates, [
    { ratePercent: 25, effectiveFrom: "1992-01-01", sourceId: "dst_skatter_avgifter_1999" },
  ]);
});

test("Denmark primary code is the 25% standard moms code", () => {
  const definitions = packTaxCodesForReturn(pack, "DK_MOMS");
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]!.code, "DK-VAT-STD");
  assert.equal(definitions[0]!.role, "standard");
  assert.equal(definitions[0]!.ratePercent, 25);
  assert.equal(primaryPackTaxCode(pack, "DK_MOMS")?.code, "DK-VAT-STD");
});
