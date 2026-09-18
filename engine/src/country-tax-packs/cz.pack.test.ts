import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { CZECHIA_TAX_PACK } from "./cz.ts";
import type { EffectiveTaxRate } from "./types.ts";

const pack = CZECHIA_TAX_PACK;

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

test("Czechia pack declares the CZ_DPH return with the maintained version pin", () => {
  assert.equal(pack.country, "CZ");
  assert.equal(pack.code, "CZ_INDIRECT_TAX");
  assert.equal(pack.version, "2026.08.01");
  assert.equal(pack.countryTaxType, "vat");
  assert.equal(pack.parentReturnPackCode, "CZ_DPH");
  assert.equal(pack.returnPacks.length, 1);
  assert.equal(pack.returnPacks[0]!.code, "CZ_DPH");
  assert.equal(pack.jurisdictions.length, 0, "CZ DPH is national — no subnational jurisdictions");
});

test("Czechia return carries the authority-form radky plus the two workpaper boxes", () => {
  assert.deepEqual(pack.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "1", "2", "20", "OB_OUTPUT", "40", "41", "46", "OB_INPUT", "62", "63", "64", "65",
  ]);
  const output = pack.returnPacks[0]!.boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  const input = pack.returnPacks[0]!.boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("Czechia declares 21 / 12 / 0 with no current 10% band", () => {
  const codes = packTaxCodesForReturn(pack, "CZ_DPH");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent, code.rates?.[0]?.effectiveFrom]), [
    ["CZ-VAT-STD", "standard", 21, "2024-01-01"],
    ["CZ-VAT-RED12", "reduced", 12, "2024-01-01"],
    ["CZ-VAT-ZERO", "zero", 0, "2024-01-01"],
  ]);
  assert.equal(primaryPackTaxCode(pack, "CZ_DPH")?.code, "CZ-VAT-STD");
  for (const code of codes) {
    for (const rate of code.rates ?? []) {
      assert.notEqual(rate.ratePercent, 10, `${code.code} must not carry a 10% band as current`);
      assert.notEqual(rate.ratePercent, 15, `${code.code} must not carry a 15% band as current`);
    }
    assertContiguous(code.rates ?? []);
  }
});

test("Czechia rate schedules resolve every source and file electronically through MOJE dane", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(pack), ["CZ_DPH"]);
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(pack, "CZ_DPH")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    for (const rate of code.rates) {
      assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} has no sources entry`);
    }
  }
  for (const source of pack.sources) {
    assert.match(source.url, /^https:\/\//, `${source.id} must be fetched over https`);
  }
  const filing = pack.returnPacks[0]!;
  assert.equal(filing.defaultFrequency, "monthly");
  assert.equal(filing.submissionChannel, "file_upload");
  assert.equal(filing.governmentFormat, "certified_file");
  assert.match(filing.watermark, /kontrolní hlášení/);
  assert.match(filing.watermark, /CZK/);
});

test("Czechia cites only the Czech tax authority's own hosts", () => {
  for (const source of pack.sources) {
    assert.match(
      source.url,
      /^https:\/\/(financnisprava\.gov\.cz|adisspr\.mfcr\.cz)\//,
      `${source.id} must be attested by the authority itself, never a vendor page`,
    );
  }
});
