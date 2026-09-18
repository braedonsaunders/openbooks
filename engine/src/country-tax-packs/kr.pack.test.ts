import assert from "node:assert/strict";
import test from "node:test";
import { packTaxCodesForReturn } from "./index.ts";
import { KOREA_TAX_PACK } from "./kr.ts";
import type { CountryTaxCodeDefinition, EffectiveTaxRate } from "./types.ts";

function codesFor(returnPackCode: string): readonly CountryTaxCodeDefinition[] {
  const codes = packTaxCodesForReturn(KOREA_TAX_PACK, returnPackCode);
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

test("Korea pack is found by country with one return pack and the version pin", () => {
  assert.equal(KOREA_TAX_PACK.country, "KR");
  assert.equal(KOREA_TAX_PACK.code, "KR_INDIRECT_TAX");
  assert.equal(KOREA_TAX_PACK.version, "2026.08.01");
  assert.equal(KOREA_TAX_PACK.returnPacks.length, 1);
  assert.equal(KOREA_TAX_PACK.parentReturnPackCode, "KR_VAT_RETURN");
  assert.equal(KOREA_TAX_PACK.returnPacks[0]!.code, "KR_VAT_RETURN");
});

test("Korea VAT return carries the real return lines plus the OB workpaper boxes", () => {
  const boxes = KOREA_TAX_PACK.returnPacks[0]!.boxes;
  assert.deepEqual(boxes.map((box) => box.lineCode), [
    "OUTPUT_TAX",
    "ZERO_RATED_SUPPLIES",
    "INPUT_TAX",
    "TAX_PAYABLE_REFUNDABLE",
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

test("Korea lodges quarterly preliminary returns through Hometax, not a simple quarterly VAT", () => {
  const returnPack = KOREA_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "quarterly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /nts\.go\.kr/);
});

test("every Korea sourceId resolves to a sources[] entry", () => {
  const ids = new Set(KOREA_TAX_PACK.sources.map((source) => source.id));
  for (const code of codesFor("KR_VAT_RETURN")) {
    for (const rate of code.rates ?? []) {
      assert.ok(ids.has(rate.sourceId), `${code.code} cites unknown source ${rate.sourceId}`);
    }
  }
});

test("Korea rate history is contiguous and the primary code is the 10% standard one", () => {
  const codes = codesFor("KR_VAT_RETURN");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["KR-VAT-STD", "standard", 10],
    ["KR-VAT-ZERO", "zero", 0],
  ]);
  for (const code of codes) {
    assertContiguous(code.rates ?? [], code.code);
    assert.equal(code.rates![0]!.ratePercent, code.ratePercent);
  }
  const primary = codes.length <= 1 ? codes[0]! : (codes.find((code) => code.role === "standard") ?? codes[0]!);
  assert.equal(primary.code, "KR-VAT-STD");
});

test("Korea VAT is national — no subnational jurisdictions declared", () => {
  assert.equal(KOREA_TAX_PACK.jurisdictions.length, 0);
});
