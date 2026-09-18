import assert from "node:assert/strict";
import test from "node:test";
import { HUNGARY_TAX_PACK } from "./hu.ts";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import type { EffectiveTaxRate } from "./types.ts";

const pack = HUNGARY_TAX_PACK;

function assertContiguous(rates: readonly EffectiveTaxRate[]): void {
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1];
    const current = rates[index];
    assert.ok(prior && current);
    assert.ok(prior.effectiveTo, `rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10));
  }
}

test("Hungary pack is found by country with one return pack and the version pin", () => {
  assert.equal(pack.country, "HU");
  assert.equal(pack.code, "HU_INDIRECT_TAX");
  assert.equal(pack.version, "2026.08.01");
  assert.equal(pack.countryTaxType, "vat");
  assert.equal(pack.returnPacks.length, 1);
  const head = pack.returnPacks[0];
  assert.ok(head);
  assert.equal(head.code, "HU_AFA_65");
  assert.equal(pack.parentReturnPackCode, "HU_AFA_65");
});

test("Hungary return carries the real form-65 sor numbers plus workpaper boxes", () => {
  const head = pack.returnPacks[0];
  assert.ok(head);
  assert.deepEqual(
    head.boxes.map((box) => box.lineCode),
    ["05", "06", "07", "110", "36", "64", "65", "66", "111", "76", "83", "84", "85", "OB_OUTPUT", "OB_INPUT"],
  );
  const output = head.boxes.find((box) => box.lineCode === "OB_OUTPUT");
  const input = head.boxes.find((box) => box.lineCode === "OB_INPUT");
  assert.ok(output);
  assert.ok(input);
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("Hungary files monthly by default through the NAV validated upload channel", () => {
  const head = pack.returnPacks[0];
  assert.ok(head);
  assert.equal(head.defaultFrequency, "monthly");
  assert.equal(head.submissionChannel, "file_upload");
  assert.equal(head.governmentFormat, "certified_file");
  assert.ok(head.submissionUrl.startsWith("https://nav.gov.hu/"));
});

test("Hungary declares every band through the reader with resolving sources and contiguous history", () => {
  const declared = packReturnCodesWithTaxCodes(pack);
  assert.deepEqual(declared, ["HU_AFA_65"]);
  const codes = packTaxCodesForReturn(pack, "HU_AFA_65");
  assert.equal(codes.length, 4);
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  for (const code of codes) {
    assert.ok(code.role, `${code.code} must declare a band role`);
    const rates = code.rates;
    assert.ok(rates && rates.length > 0, `${code.code} must carry a sourced schedule`);
    for (const rate of rates) {
      assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} has no entry in sources`);
    }
    assertContiguous(rates);
  }
  assert.deepEqual(
    codes.map((code) => [code.code, code.role, code.ratePercent, code.rates?.[0]?.effectiveFrom]),
    [
      ["HU-VAT-STD", "standard", 27, "2012-01-01"],
      ["HU-VAT-RED18", "reduced", 18, "2012-01-01"],
      ["HU-VAT-RED5", "reduced", 5, "2012-01-01"],
      ["HU-VAT-ZERO", "zero", 0, "2012-01-01"],
    ],
  );
});

test("Hungary primary code is the 27% standard band and ÁFA stays national", () => {
  const primary = primaryPackTaxCode(pack, "HU_AFA_65");
  assert.ok(primary);
  assert.equal(primary.code, "HU-VAT-STD");
  assert.equal(primary.ratePercent, 27);
  assert.deepEqual(pack.jurisdictions, []);
});
