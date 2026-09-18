import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { SAUDI_ARABIA_TAX_PACK } from "./sa.ts";
import type { EffectiveTaxRate } from "./types.ts";

const pack = SAUDI_ARABIA_TAX_PACK;
const RETURN_CODE = "SA_VAT_RETURN";

function assertContiguous(rates: readonly EffectiveTaxRate[]): void {
  for (let index = 1; index < rates.length; index += 1) {
    const prior = rates[index - 1]!;
    const current = rates[index]!;
    assert.ok(prior.effectiveTo, `rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10), "rates must be contiguous");
  }
}

describe("Saudi Arabia VAT pack", () => {
  it("is found by country with one return pack and the version pin", () => {
    assert.equal(pack.country, "SA");
    assert.equal(pack.code, "SA_INDIRECT_TAX");
    assert.equal(pack.version, "2026.08.01");
    assert.equal(pack.countryTaxType, "vat");
    assert.equal(pack.parentReturnPackCode, RETURN_CODE);
    assert.equal(pack.returnPacks.length, 1);
    assert.equal(pack.returnPacks[0]!.code, RETURN_CODE);
  });

  it("declares the real ZATCA return boxes plus the OB workpaper boxes", () => {
    const lineCodes = new Set(pack.returnPacks[0]!.boxes.map((box) => box.lineCode));
    for (const required of ["1", "3", "4", "5", "7", "9", "16", "OB_OUTPUT", "OB_INPUT"]) {
      assert.ok(lineCodes.has(required), `missing box ${required}`);
    }
    // Full portal return: fields 1–16.
    for (let field = 1; field <= 16; field += 1) {
      assert.ok(lineCodes.has(String(field)), `missing portal field ${field}`);
    }
  });

  it("files monthly through the portal", () => {
    const ret = pack.returnPacks[0]!;
    assert.equal(ret.defaultFrequency, "monthly");
    assert.equal(ret.submissionChannel, "portal_manual");
    assert.equal(ret.governmentFormat, "portal_entry");
    assert.ok(ret.submissionUrl.startsWith("https://zatca.gov.sa/"));
  });

  it("carries the 5%-to-15% standard-rate history contiguously", () => {
    const codes = packTaxCodesForReturn(pack, RETURN_CODE);
    const standard = codes.find((code) => code.code === "SA-VAT-STD");
    assert.ok(standard);
    assert.equal(standard.role, "standard");
    assert.equal(standard.ratePercent, 15);
    assert.deepEqual(
      (standard.rates ?? []).map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]),
      [
        ["2018-01-01", "2020-06-30", 5],
        ["2020-07-01", null, 15],
      ],
    );
    assertContiguous(standard.rates ?? []);
  });

  it("declares zero-rating without a reduced rate and without modelling exempt as 0%", () => {
    const codes = packTaxCodesForReturn(pack, RETURN_CODE);
    const zero = codes.find((code) => code.code === "SA-VAT-ZERO");
    assert.ok(zero);
    assert.equal(zero.role, "zero");
    assert.equal(zero.ratePercent, 0);
    assertContiguous(zero.rates ?? []);
    assert.ok(!codes.some((code) => code.role === "reduced"), "Saudi VAT has no reduced rate");
    assert.ok(!codes.some((code) => code.role === "exempt"), "exempt supplies are not a 0% code");
  });

  it("resolves every rate sourceId to a sources[] entry", () => {
    const sourceIds = new Set(pack.sources.map((source) => source.id));
    for (const code of packTaxCodesForReturn(pack, RETURN_CODE)) {
      for (const rate of code.rates ?? []) {
        assert.ok(sourceIds.has(rate.sourceId), `${code.code} references unknown source ${rate.sourceId}`);
      }
    }
  });

  it("keys tax codes by its own return pack and leaves jurisdictions empty", () => {
    assert.deepEqual(packReturnCodesWithTaxCodes(pack), [RETURN_CODE]);
    assert.equal(pack.jurisdictions.length, 0);
    assert.equal(primaryPackTaxCode(pack, RETURN_CODE)?.code, "SA-VAT-STD");
  });
});
