import assert from "node:assert/strict";
import test from "node:test";
import { packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { PORTUGAL_TAX_PACK } from "./pt.ts";
import type { EffectiveTaxRate } from "./types.ts";

const pack = PORTUGAL_TAX_PACK;

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

test("Portugal pack is found by country with one return pack and the version pin", () => {
  assert.equal(pack.country, "PT");
  assert.equal(pack.code, "PT_INDIRECT_TAX");
  assert.equal(pack.version, "2026.08.01");
  assert.equal(pack.countryTaxType, "vat");
  assert.equal(pack.parentReturnPackCode, "PT_IVA_DP");
  assert.equal(pack.returnPacks.length, 1);
  assert.equal(pack.returnPacks[0]!.code, "PT_IVA_DP");
});

test("PT_IVA_DP is a monthly Portal das Finanças return", () => {
  const ret = pack.returnPacks[0]!;
  assert.equal(ret.defaultFrequency, "monthly");
  assert.equal(ret.submissionChannel, "portal_manual");
  assert.equal(ret.governmentFormat, "portal_entry");
  assert.ok(ret.submissionUrl.includes("portaldasfinancas.gov.pt"));
});

test("PT_IVA_DP carries the real declaração periódica box line codes", () => {
  const codes = new Set(pack.returnPacks[0]!.boxes.map((box) => box.lineCode));
  for (const code of ["1", "2", "5", "6", "3", "4"]) assert.ok(codes.has(code), `missing rate-band box ${code}`);
  for (const code of ["20", "21", "22", "23", "24", "40", "41", "61", "81"]) assert.ok(codes.has(code), `missing deductible box ${code}`);
  for (const code of ["65", "66", "67", "68"]) assert.ok(codes.has(code), `missing ANEXO R box ${code}`);
  for (const code of ["90", "91", "92", "93", "94", "95", "96"]) assert.ok(codes.has(code), `missing result box ${code}`);
  assert.ok(codes.has("OB_OUTPUT"));
  assert.ok(codes.has("OB_INPUT"));
  const output = pack.returnPacks[0]!.boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  const input = pack.returnPacks[0]!.boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("PT_IVA_DP declares nine region-banded codes with roles and contiguous histories", () => {
  const codes = packTaxCodesForReturn(pack, "PT_IVA_DP");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["PT-VAT-STD", "standard", 23],
    ["PT-VAT-INT", "reduced", 13],
    ["PT-VAT-RED", "reduced", 6],
    ["PT-MAD-VAT-STD", "standard", 22],
    ["PT-MAD-VAT-INT", "reduced", 12],
    ["PT-MAD-VAT-RED", "reduced", 4],
    ["PT-AZO-VAT-STD", "standard", 16],
    ["PT-AZO-VAT-INT", "reduced", 9],
    ["PT-AZO-VAT-RED", "reduced", 4],
  ]);
  assert.deepEqual(packTaxCodesForReturn(pack, "PT_IVA_DP").find((code) => code.code === "PT-VAT-STD")!.rates, [
    { ratePercent: 21, effectiveFrom: "2010-07-01", effectiveTo: "2010-12-31", sourceId: "dsiva_oc30118_2010_aplicabilidade" },
    { ratePercent: 23, effectiveFrom: "2011-01-01", sourceId: "dsiva_oc30121_2010_taxa_normal" },
  ]);
  assert.deepEqual(packTaxCodesForReturn(pack, "PT_IVA_DP").find((code) => code.code === "PT-AZO-VAT-STD")!.rates, [
    { ratePercent: 16, effectiveFrom: "2021-07-01", sourceId: "at_oc30237_2021_acores" },
  ]);
  assert.deepEqual(packTaxCodesForReturn(pack, "PT_IVA_DP").find((code) => code.code === "PT-MAD-VAT-RED")!.rates, [
    { ratePercent: 4, effectiveFrom: "2024-10-01", sourceId: "at_oc25045_2024_madeira" },
  ]);
  for (const code of codes) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must declare a rate schedule`);
    assertContiguous(code.rates!);
  }
});

test("every PT rate sourceId resolves to a sources entry", () => {
  const ids = new Set(pack.sources.map((source) => source.id));
  assert.ok(ids.size > 0);
  for (const code of packTaxCodesForReturn(pack, "PT_IVA_DP")) {
    for (const rate of code.rates ?? []) assert.ok(ids.has(rate.sourceId), `${code.code} references unknown source ${rate.sourceId}`);
  }
});

test("primary PT_IVA_DP code is the mainland standard and regions share the return", () => {
  assert.equal(primaryPackTaxCode(pack, "PT_IVA_DP")?.code, "PT-VAT-STD");
  assert.deepEqual(pack.jurisdictions, []);
});
