import assert from "node:assert/strict";
import test from "node:test";
import { AUSTRIA_TAX_PACK } from "./at.ts";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn } from "./index.ts";
import type { CountryTaxCodeDefinition, EffectiveTaxRate } from "./types.ts";

const pack = AUSTRIA_TAX_PACK;
const RETURN_CODE = "AT_U30";

function theReturn(): (typeof pack.returnPacks)[number] {
  const value = pack.returnPacks[0];
  assert.ok(value, "AT pack must declare its U30 return");
  return value;
}

function byCode(): Map<string, CountryTaxCodeDefinition> {
  return new Map(packTaxCodesForReturn(pack, RETURN_CODE).map((code) => [code.code, code]));
}

test("AT pack is the maintained-pack shape: one return, pinned version", () => {
  assert.equal(pack.country, "AT");
  assert.equal(pack.code, "AT_INDIRECT_TAX");
  assert.equal(pack.version, "2026.08.01");
  assert.equal(pack.countryTaxType, "vat");
  assert.equal(pack.parentReturnPackCode, RETURN_CODE);
  assert.equal(pack.returnPacks.length, 1);

  const ret = theReturn();
  assert.equal(ret.code, RETURN_CODE);
  assert.equal(ret.defaultFrequency, "monthly");
  assert.equal(ret.submissionChannel, "portal_manual");
  assert.equal(ret.governmentFormat, "portal_entry");
  assert.ok(ret.submissionUrl.startsWith("https://"), "submissionUrl is https");
});

test("the U30 carries the real Kennzahlen plus the two OB workpaper boxes", () => {
  const boxes = new Map(theReturn().boxes.map((box) => [box.lineCode, box]));
  for (const kz of ["000", "022", "029", "006", "037", "060", "095", "OB_OUTPUT", "OB_INPUT"]) {
    assert.ok(boxes.has(kz), `box ${kz} present`);
  }
  // KZ 037 is the enclave 19% band's destination on the return.
  assert.ok(boxes.get("037")?.label.includes("19%"), "KZ 037 must carry the 19% base");
  assert.equal(boxes.get("OB_OUTPUT")?.basis, "tax_collected");
  assert.equal(boxes.get("OB_OUTPUT")?.glMap, "sales");
  assert.equal(boxes.get("OB_INPUT")?.basis, "tax_paid");
  assert.equal(boxes.get("OB_INPUT")?.glMap, "purchases");
});

test("USt is federal: no subnational jurisdictions", () => {
  assert.equal(pack.jurisdictions.length, 0);
});

test("the code set is keyed by the U30 and led by the standard band", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(pack), [RETURN_CODE]);
  const codes = packTaxCodesForReturn(pack, RETURN_CODE);
  assert.ok(codes.length > 0, "non-empty code set");

  const standard = codes[0];
  assert.ok(standard, "the set must lead with a code");
  assert.equal(standard.code, "AT-VAT-STD");
  assert.equal(standard.role, "standard");
  assert.equal(standard.ratePercent, 20);

  const map = byCode();
  assert.equal(map.get("AT-VAT-RED10")?.role, "reduced");
  assert.equal(map.get("AT-VAT-RED10")?.ratePercent, 10);
  assert.equal(map.get("AT-VAT-RED13")?.role, "reduced");
  assert.equal(map.get("AT-VAT-RED13")?.ratePercent, 13);
  // Jungholz/Mittelberg sit in the German customs union and are neither the
  // Austrian standard nor an Austrian reduced band, so they carry no role.
  assert.equal(map.get("AT-VAT-ENCLAVE")?.role, undefined);
  assert.equal(map.get("AT-VAT-ENCLAVE")?.ratePercent, 19);
});

test("every source is https with an asOf, and every sourceId resolves", () => {
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  assert.equal(sourceIds.size, pack.sources.length, "source ids unique");
  for (const source of pack.sources) {
    assert.ok(source.url.startsWith("https://"), `source ${source.id} url is https`);
    assert.ok(source.asOf.length > 0, `source ${source.id} has asOf`);
  }
  for (const code of packTaxCodesForReturn(pack, RETURN_CODE)) {
    const rates: readonly EffectiveTaxRate[] = code.rates ?? [];
    assert.ok(rates.length > 0, `${code.code} has rates`);
    for (const rate of rates) {
      assert.ok(sourceIds.has(rate.sourceId), `${code.code} sourceId ${rate.sourceId} resolves`);
    }
  }
});

test("each band's rate history is contiguous", () => {
  for (const code of packTaxCodesForReturn(pack, RETURN_CODE)) {
    const sorted = [...(code.rates ?? [])].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    for (let index = 0; index < sorted.length - 1; index++) {
      const current = sorted[index];
      const next = sorted[index + 1];
      assert.ok(current && next, "contiguity walk stays in bounds");
      assert.ok(current.effectiveTo, `${code.code} non-terminal rate has effectiveTo`);
      const dayAfter = new Date(`${current.effectiveTo}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      assert.equal(next.effectiveFrom, dayAfter.toISOString().slice(0, 10), `${code.code} history contiguous`);
    }
  }
});
