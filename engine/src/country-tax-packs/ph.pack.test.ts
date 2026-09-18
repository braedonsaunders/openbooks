import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { PHILIPPINES_TAX_PACK } from "./ph.ts";
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

test("Philippines pack is found by country with one 2550Q return and the maintained version pin", () => {
  assert.equal(PHILIPPINES_TAX_PACK.country, "PH");
  assert.equal(PHILIPPINES_TAX_PACK.code, "PH_INDIRECT_TAX");
  assert.equal(PHILIPPINES_TAX_PACK.countryTaxType, "vat");
  assert.equal(PHILIPPINES_TAX_PACK.version, "2026.08.01");
  assert.equal(PHILIPPINES_TAX_PACK.returnPacks.length, 1);
  assert.equal(PHILIPPINES_TAX_PACK.parentReturnPackCode, "PH_BIR_2550Q");
  assert.equal(PHILIPPINES_TAX_PACK.returnPacks[0]!.code, "PH_BIR_2550Q");
});

test("Philippines return carries the real 2550Q Part IV boxes plus the two OB workpaper boxes", () => {
  assert.deepEqual(PHILIPPINES_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "31", "32", "34", "37", "60", "61", "OB_OUTPUT", "OB_INPUT",
  ]);
  assert.deepEqual(
    PHILIPPINES_TAX_PACK.returnPacks[0]!.boxes.filter((box) => box.lineCode.startsWith("OB_")).map((box) => [
      box.lineCode,
      box.basis,
      box.glMap,
    ]),
    [
      ["OB_OUTPUT", "tax_collected", "sales"],
      ["OB_INPUT", "tax_paid", "purchases"],
    ],
  );
});

test("Philippines filing is quarterly electronic filing through the BIR e-services", () => {
  const returnPack = PHILIPPINES_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "quarterly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /bir\.gov\.ph/);
});

test("Philippines declares the 12% standard and 0% zero bands with honest roles and no exempt code", () => {
  const codes = packTaxCodesForReturn(PHILIPPINES_TAX_PACK, "PH_BIR_2550Q");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["PH-VAT-STD", "standard", 12],
    ["PH-VAT-ZERO", "zero", 0],
  ]);
  assert.ok(!codes.some((code) => code.role === "exempt"), "Section 109 exempt sales carry no code");
  assert.ok(!codes.some((code) => code.role === "reduced"), "no reduced rate in Philippine VAT");
});

test("Philippines primary code is the standard 12% band", () => {
  assert.equal(primaryPackTaxCode(PHILIPPINES_TAX_PACK, "PH_BIR_2550Q")?.code, "PH-VAT-STD");
});

test("Philippines rate schedules are contiguous and every sourceId resolves", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(PHILIPPINES_TAX_PACK), ["PH_BIR_2550Q"]);
  const sourceIds = new Set(PHILIPPINES_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(PHILIPPINES_TAX_PACK, "PH_BIR_2550Q")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
  }
});

test("Philippines VAT is national with no subnational VAT jurisdictions", () => {
  assert.equal(PHILIPPINES_TAX_PACK.jurisdictions.length, 0);
});
