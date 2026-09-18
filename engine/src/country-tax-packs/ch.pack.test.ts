import assert from "node:assert/strict";
import test from "node:test";
import { SWITZERLAND_TAX_PACK } from "./ch.ts";
import type { CountryTaxCodeDefinition, EffectiveTaxRate } from "./types.ts";

const pack = SWITZERLAND_TAX_PACK;
const RETURN_CODE = "CH_MWST_ABRECHNUNG";

function isTaxCodeSet(
  entry: CountryTaxCodeDefinition | readonly CountryTaxCodeDefinition[],
): entry is readonly CountryTaxCodeDefinition[] {
  return Array.isArray(entry);
}

function codesForReturn(): readonly CountryTaxCodeDefinition[] {
  const entry: CountryTaxCodeDefinition | readonly CountryTaxCodeDefinition[] | undefined =
    pack.returnPackTaxCodes[RETURN_CODE];
  if (!entry) throw new Error(`missing returnPackTaxCodes for ${RETURN_CODE}`);
  if (isTaxCodeSet(entry)) return entry;
  return [entry];
}

function assertContiguous(rates: readonly EffectiveTaxRate[], code: string): void {
  assert.ok(rates.length > 0, `${code} must carry at least one rate`);
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1]!;
    const current = rates[index]!;
    assert.ok(prior.effectiveTo, `${code}: rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10), `${code}: gap before ${current.effectiveFrom}`);
  }
  const last = rates[rates.length - 1]!;
  assert.ok(!last.effectiveTo, `${code}: current rate must stay open`);
}

test("swiss pack is found by country and carries one quarterly return pack", () => {
  assert.equal(pack.country, "CH");
  assert.equal(pack.code, "CH_INDIRECT_TAX");
  assert.equal(pack.version, "2026.08.01");
  assert.equal(pack.parentReturnPackCode, RETURN_CODE);
  assert.equal(pack.returnPacks.length, 1);
  const ret = pack.returnPacks[0]!;
  assert.equal(ret.code, RETURN_CODE);
  assert.equal(ret.defaultFrequency, "quarterly");
  assert.equal(ret.submissionChannel, "portal_manual");
  assert.equal(ret.governmentFormat, "portal_entry");
});

test("swiss return carries the real Abrechnung box Ziffern plus OB workpapers", () => {
  const ret = pack.returnPacks[0]!;
  const boxes = new Map(ret.boxes.map((box) => [box.lineCode, box]));
  for (const lineCode of [
    "200", "205", "220", "221", "225", "230", "235", "280", "289", "299",
    "303", "302", "313", "312", "343", "342", "383", "382", "399",
    "400", "405", "410", "415", "420", "479", "500", "510",
    "OB_OUTPUT", "OB_INPUT",
  ]) {
    assert.ok(boxes.has(lineCode), `missing box ${lineCode}`);
  }
  const output = boxes.get("OB_OUTPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  const input = boxes.get("OB_INPUT")!;
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("every rate sourceId resolves to a pack source", () => {
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  assert.ok(sourceIds.size > 0, "pack must cite sources");
  for (const code of codesForReturn()) {
    for (const rate of code.rates ?? []) {
      assert.ok(sourceIds.has(rate.sourceId), `${code.code}: unknown sourceId ${rate.sourceId}`);
    }
  }
});

test("all three MWST bands have contiguous histories ending in the 2024 rates", () => {
  const codes = codesForReturn();
  assert.equal(codes.length, 3);
  const byCode = new Map(codes.map((code) => [code.code, code]));
  const std = byCode.get("CH-VAT-STD")!;
  const red = byCode.get("CH-VAT-RED")!;
  const lodging = byCode.get("CH-VAT-LODGING")!;
  assert.equal(std.role, "standard");
  assert.equal(std.ratePercent, 8.1);
  assert.equal(red.role, "reduced");
  assert.equal(red.ratePercent, 2.6);
  assert.equal(lodging.role, "reduced");
  assert.equal(lodging.ratePercent, 3.8);
  for (const code of [std, red, lodging]) {
    assertContiguous(code.rates ?? [], code.code);
    const last = code.rates![code.rates!.length - 1]!;
    assert.equal(last.effectiveFrom, "2024-01-01");
    assert.equal(last.ratePercent, code.ratePercent);
  }
  assert.equal(std.rates![0]!.ratePercent, 7.6);
  assert.equal(std.rates![0]!.effectiveFrom, "2001-01-01");
});

test("MWST is federal: no subnational jurisdictions", () => {
  assert.deepEqual([...pack.jurisdictions], []);
});
