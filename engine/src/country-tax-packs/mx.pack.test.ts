import assert from "node:assert/strict";
import test from "node:test";
import { assertPackCodeRateSchedule, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { MEXICO_TAX_PACK } from "./mx.ts";
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

test("Mexico IVA pack files the monthly definitiva through the SAT portal", () => {
  assert.equal(MEXICO_TAX_PACK.country, "MX");
  assert.equal(MEXICO_TAX_PACK.code, "MX_INDIRECT_TAX");
  assert.equal(MEXICO_TAX_PACK.version, "2026.08.01");
  assert.equal(MEXICO_TAX_PACK.countryTaxType, "vat");
  assert.equal(MEXICO_TAX_PACK.parentReturnPackCode, "MX_IVA_MENSUAL");
  assert.equal(MEXICO_TAX_PACK.returnPacks.length, 1);
  const returnPack = MEXICO_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.code, "MX_IVA_MENSUAL");
  assert.equal(returnPack.defaultFrequency, "monthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  const codes = new Set(returnPack.boxes.map((box) => box.lineCode));
  for (const code of ["IVA-CAUSADO", "IVA-ACREDITABLE", "IVA-CARGO", "IVA-FAVOR", "OB_OUTPUT", "OB_INPUT"]) {
    assert.ok(codes.has(code), `missing box ${code}`);
  }
  const output = returnPack.boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  const input = returnPack.boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("Mexico IVA codes carry sourced, contiguous rate histories with the standard code primary", () => {
  const sourceIds = new Set(MEXICO_TAX_PACK.sources.map((source) => source.id));
  const codes = packTaxCodesForReturn(MEXICO_TAX_PACK, "MX_IVA_MENSUAL");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["MX-VAT-STD", "standard", 16],
    ["MX-VAT-NORTH-8", "reduced", 8],
    ["MX-VAT-SOUTH-8", "reduced", 8],
    ["MX-VAT-ZERO", "zero", 0],
  ]);
  for (const code of codes) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a rate history`);
    for (const rate of code.rates!) {
      assert.ok(sourceIds.has(rate.sourceId), `${code.code} cites unknown source ${rate.sourceId}`);
    }
    assertContiguous(code.rates!);
  }
  assert.equal(primaryPackTaxCode(MEXICO_TAX_PACK, "MX_IVA_MENSUAL")?.code, "MX-VAT-STD");
  const north = codes.find((code) => code.code === "MX-VAT-NORTH-8")!;
  assert.equal(north.rates![0]!.effectiveFrom, "2019-01-01");
  const south = codes.find((code) => code.code === "MX-VAT-SOUTH-8")!;
  assert.equal(south.rates![0]!.effectiveFrom, "2021-01-01");
  for (const code of [north, south]) {
    assert.equal(code.rates![code.rates!.length - 1]!.effectiveTo, "2026-12-31");
  }
});

test("Mexico border stimulus bands cover a pinned date inside the 2026 window and name the missing successor after it", () => {
  const codes = packTaxCodesForReturn(MEXICO_TAX_PACK, "MX_IVA_MENSUAL");
  for (const code of ["MX-VAT-NORTH-8", "MX-VAT-SOUTH-8"]) {
    const definition = codes.find((entry) => entry.code === code)!;
    assertPackCodeRateSchedule(`MX_INDIRECT_TAX/MX_IVA_MENSUAL/${code}`, definition, "2026-09-18");
    assert.throws(
      () => assertPackCodeRateSchedule(`MX_INDIRECT_TAX/MX_IVA_MENSUAL/${code}`, definition, "2027-01-01"),
      /successor rate/,
    );
  }
});

test("Mexico declares no subnational IVA jurisdictions", () => {
  assert.deepEqual(MEXICO_TAX_PACK.jurisdictions, []);
  assert.equal(MEXICO_TAX_PACK.completeness.localRates, "not_applicable");
});
