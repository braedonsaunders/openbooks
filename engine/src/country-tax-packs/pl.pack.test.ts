import assert from "node:assert/strict";
import test from "node:test";
import { POLAND_TAX_PACK } from "./pl.ts";
import type { CountryTaxCodeDefinition, EffectiveTaxRate } from "./types.ts";

function isTaxCodeSet(
  entry: CountryTaxCodeDefinition | readonly CountryTaxCodeDefinition[],
): entry is readonly CountryTaxCodeDefinition[] {
  return Array.isArray(entry);
}

function codesForReturn(packCode: string): readonly CountryTaxCodeDefinition[] {
  const entry = POLAND_TAX_PACK.returnPackTaxCodes[packCode];
  assert.ok(entry, `no tax codes declared for ${packCode}`);
  return isTaxCodeSet(entry) ? entry : [entry];
}

function assertContiguous(rates: readonly EffectiveTaxRate[], code: string): void {
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1]!;
    const current = rates[index]!;
    assert.ok(prior.effectiveTo, `${code}: rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10));
  }
}

test("Poland pack is a single-return JPK_V7M pack", () => {
  assert.equal(POLAND_TAX_PACK.country, "PL");
  assert.equal(POLAND_TAX_PACK.code, "PL_INDIRECT_TAX");
  assert.equal(POLAND_TAX_PACK.version, "2026.08.01");
  assert.equal(POLAND_TAX_PACK.returnPacks.length, 1);
  assert.equal(POLAND_TAX_PACK.parentReturnPackCode, "PL_JPK_V7M");
  assert.deepEqual(POLAND_TAX_PACK.jurisdictions, []);
});

test("Poland return pack carries the real JPK_V7M declaration boxes", () => {
  const [pack] = POLAND_TAX_PACK.returnPacks;
  assert.equal(pack!.code, "PL_JPK_V7M");
  assert.equal(pack!.defaultFrequency, "monthly");
  assert.deepEqual(
    pack!.boxes.map((box) => box.lineCode),
    ["P_19", "P_20", "P_17", "P_18", "P_15", "P_16", "P_13", "P_38", "P_48", "P_51", "P_62", "OB_OUTPUT", "OB_INPUT"],
  );
  const workpapers = pack!.boxes.filter((box) => box.lineCode.startsWith("OB_"));
  assert.deepEqual(
    workpapers.map((box) => [box.lineCode, box.basis, box.glMap]),
    [
      ["OB_OUTPUT", "tax_collected", "sales"],
      ["OB_INPUT", "tax_paid", "purchases"],
    ],
  );
});

test("Poland declares four rate bands with contiguous source-backed histories", () => {
  const codes = codesForReturn("PL_JPK_V7M");
  assert.deepEqual(
    codes.map((code) => [code.code, code.role, code.ratePercent]),
    [
      ["PL-VAT-STD", "standard", 23],
      ["PL-VAT-RED8", "reduced", 8],
      ["PL-VAT-RED5", "reduced", 5],
      ["PL-VAT-ZERO", "zero", 0],
    ],
  );
  const sourceIds = new Set(POLAND_TAX_PACK.sources.map((source) => source.id));
  for (const code of codes) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must declare rates`);
    for (const rate of code.rates!) {
      assert.ok(sourceIds.has(rate.sourceId), `${code.code} cites unknown source ${rate.sourceId}`);
    }
    assertContiguous(code.rates!, code.code);
  }
  const primary = codes.find((code) => code.role === "standard") ?? codes[0]!;
  assert.equal(primary.code, "PL-VAT-STD");
});
