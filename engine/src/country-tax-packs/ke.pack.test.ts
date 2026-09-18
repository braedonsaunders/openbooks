import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn } from "./index.ts";
import { KENYA_TAX_PACK } from "./ke.ts";
import type { CountryTaxCodeDefinition, EffectiveTaxRate } from "./types.ts";

function codesFor(returnPackCode: string): readonly CountryTaxCodeDefinition[] {
  const codes = packTaxCodesForReturn(KENYA_TAX_PACK, returnPackCode);
  assert.ok(codes.length > 0, `missing tax codes for ${returnPackCode}`);
  return codes;
}

function assertContiguous(rates: readonly EffectiveTaxRate[], code: string): void {
  assert.ok(rates.length > 0, `${code} declares no rates`);
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1]!;
    const current = rates[index]!;
    assert.ok(prior.effectiveTo, `${code}: rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10));
  }
}

test("Kenya pack is found by country with one return pack and the version pin", () => {
  assert.equal(KENYA_TAX_PACK.country, "KE");
  assert.equal(KENYA_TAX_PACK.code, "KE_INDIRECT_TAX");
  assert.equal(KENYA_TAX_PACK.version, "2026.08.01");
  assert.equal(KENYA_TAX_PACK.countryTaxType, "vat");
  assert.equal(KENYA_TAX_PACK.returnPacks.length, 1);
  assert.equal(KENYA_TAX_PACK.parentReturnPackCode, "KE_VAT3");
  assert.equal(KENYA_TAX_PACK.returnPacks[0]!.code, "KE_VAT3");
  assert.deepEqual(packReturnCodesWithTaxCodes(KENYA_TAX_PACK), ["KE_VAT3"]);
});

test("Kenya VAT3 return carries the real return sections plus the OB workpaper boxes", () => {
  const boxes = KENYA_TAX_PACK.returnPacks[0]!.boxes;
  assert.deepEqual(boxes.map((box) => box.lineCode), [
    "OUTPUT_TAX",
    "ZERO_RATED_SUPPLIES",
    "INPUT_TAX",
    "WITHHOLDING_VAT",
    "EXCESS_INPUT_BF",
    "TAX_PAYABLE_CREDIT_CF",
    "OB_OUTPUT",
    "OB_INPUT",
  ]);
  const output = boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  const input = boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("Kenya VAT3 is a monthly portal return filed through iTax", () => {
  const returnPack = KENYA_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "monthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /itax\.kra\.go\.ke/);
});

test("every Kenya sourceId resolves to a sources[] entry", () => {
  const ids = new Set(KENYA_TAX_PACK.sources.map((source) => source.id));
  for (const code of codesFor("KE_VAT3")) {
    for (const rate of code.rates ?? []) {
      assert.ok(ids.has(rate.sourceId), `${code.code} cites unknown source ${rate.sourceId}`);
    }
  }
});

test("Kenya rate history is contiguous and the primary code is the 16% standard one", () => {
  const codes = codesFor("KE_VAT3");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["KE-VAT-STD", "standard", 16],
    ["KE-VAT-ZERO", "zero", 0],
  ]);
  for (const code of codes) {
    assertContiguous(code.rates ?? [], code.code);
  }
  // Multi-interval history: the headline rate is the CURRENT (open-ended)
  // rate, i.e. the last entry — not the first, which is the 14% window.
  const standard = codes.find((code) => code.role === "standard")!;
  const open = standard.rates![standard.rates!.length - 1]!;
  assert.equal(open.effectiveTo, undefined);
  assert.equal(open.ratePercent, standard.ratePercent);
  const primary = codes.length <= 1 ? codes[0]! : (codes.find((code) => code.role === "standard") ?? codes[0]!);
  assert.equal(primary.code, "KE-VAT-STD");
});

test("Kenya standard rate carries the sourced 14% COVID window inside 16%", () => {
  const standard = codesFor("KE_VAT3").find((code) => code.code === "KE-VAT-STD")!;
  assert.deepEqual(
    (standard.rates ?? []).map((rate) => [rate.ratePercent, rate.effectiveFrom, rate.effectiveTo ?? null]),
    [
      [14, "2020-04-01", "2020-12-31"],
      [16, "2021-01-01", null],
    ],
  );
});

test("Kenya declares no petroleum 8% code and no other bands", () => {
  const codes = codesFor("KE_VAT3");
  for (const code of codes) {
    for (const rate of code.rates ?? []) {
      assert.notEqual(rate.ratePercent, 8);
    }
  }
  assert.ok(!codes.some((code) => code.code.includes("PETRO") || code.code.includes("TOT") || code.code.includes("DST")));
});

test("Kenya VAT is national — no subnational jurisdictions declared", () => {
  assert.equal(KENYA_TAX_PACK.jurisdictions.length, 0);
});
