import assert from "node:assert/strict";
import test from "node:test";
import { CHILE_TAX_PACK } from "./cl.ts";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import type { EffectiveTaxRate } from "./types.ts";

const RETURN_CODE = "CL_F29";

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

test("Chile pack declares the CL_F29 monthly return", () => {
  assert.equal(CHILE_TAX_PACK.country, "CL");
  assert.equal(CHILE_TAX_PACK.code, "CL_INDIRECT_TAX");
  assert.equal(CHILE_TAX_PACK.countryTaxType, "vat");
  assert.equal(CHILE_TAX_PACK.parentReturnPackCode, RETURN_CODE);
  assert.equal(CHILE_TAX_PACK.returnPacks.length, 1);
  const returnPack = CHILE_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.code, RETURN_CODE);
  assert.equal(returnPack.defaultFrequency, "monthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /^https:\/\/www\.sii\.cl\//);
});

test("Chile pack carries the maintained-pack version pin", () => {
  assert.equal(CHILE_TAX_PACK.version, "2026.08.01");
});

test("CL_F29 boxes carry the real débito, crédito, and amount-to-pay códigos", () => {
  const returnPack = CHILE_TAX_PACK.returnPacks[0]!;
  assert.deepEqual(returnPack.boxes.map((box) => box.lineCode), [
    "502", "111", "513", "510", "709", "517", "501", "154", "518", "538",
    "520", "525", "528", "532", "535", "553", "504", "593", "594", "592",
    "539", "164", "127", "544", "523", "537",
    "77", "89", "91",
    "OB_OUTPUT", "OB_INPUT",
  ]);
  const byCode = new Map(returnPack.boxes.map((box) => [box.lineCode, box]));
  assert.equal(byCode.get("538")!.label, "Línea 13 — Total débitos (código 538)");
  assert.equal(byCode.get("537")!.label, "Línea 33 — Total créditos (código 537)");
  assert.equal(byCode.get("89")!.formula, "538 - 537");
  assert.equal(byCode.get("77")!.label, "Línea 34 — Remanente de crédito fiscal para el período siguiente (código 77)");
  assert.equal(byCode.get("91")!.label, "Línea 98 — Total a pagar en plazo legal (código 91)");
  assert.equal(byCode.get("OB_OUTPUT")!.basis, "tax_collected");
  assert.equal(byCode.get("OB_OUTPUT")!.glMap, "sales");
  assert.equal(byCode.get("OB_INPUT")!.basis, "tax_paid");
  assert.equal(byCode.get("OB_INPUT")!.glMap, "purchases");
});

test("every rate sourceId resolves to a declared source", () => {
  const knownSources = new Set(CHILE_TAX_PACK.sources.map((source) => source.id));
  assert.ok(knownSources.size > 0, "Chile pack declares no sources");
  for (const code of packReturnCodesWithTaxCodes(CHILE_TAX_PACK)) {
    for (const definition of packTaxCodesForReturn(CHILE_TAX_PACK, code)) {
      assert.ok(definition.rates?.length, `${code} declares no effective-dated rates`);
      for (const rate of definition.rates ?? []) {
        assert.ok(knownSources.has(rate.sourceId), `${code} references unknown source ${rate.sourceId}`);
      }
    }
  }
});

test("CL-VAT-STD is a single left-truncated 19% tail from 1 October 2003", () => {
  const codes = packTaxCodesForReturn(CHILE_TAX_PACK, RETURN_CODE);
  assert.equal(codes.length, 1, `${RETURN_CODE} must declare exactly one tax code`);
  const standard = codes[0]!;
  assert.equal(standard.code, "CL-VAT-STD");
  assert.equal(standard.role, "standard");
  assert.equal(standard.ratePercent, 19);
  assertContiguous(standard.rates ?? []);
  assert.deepEqual(standard.rates, [
    { ratePercent: 19, effectiveFrom: "2003-10-01", sourceId: "contraloria_19888_oct2003" },
  ]);
  assert.equal(CHILE_TAX_PACK.completeness.standardRates, "partial");
});

test("primary code for CL_F29 is the standard 19% code", () => {
  const primary = primaryPackTaxCode(CHILE_TAX_PACK, RETURN_CODE);
  assert.ok(primary, `${RETURN_CODE} declares no tax codes`);
  assert.equal(primary.code, "CL-VAT-STD");
  assert.equal(primary.role, "standard");
  assert.equal(primary.ratePercent, 19);
});

test("Chile declares no subnational IVA jurisdictions", () => {
  assert.equal(CHILE_TAX_PACK.jurisdictions.length, 0);
  assert.equal(CHILE_TAX_PACK.completeness.jurisdictions, "not_applicable");
  assert.equal(CHILE_TAX_PACK.completeness.localRates, "not_applicable");
});

test("Chile evidence stays on official hosts over https", () => {
  const officialHosts = new Set(["www.sii.cl", "www.contraloria.cl"]);
  for (const source of CHILE_TAX_PACK.sources) {
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:");
    assert.ok(officialHosts.has(url.hostname), `${source.id} is not an approved primary-source host`);
  }
});
