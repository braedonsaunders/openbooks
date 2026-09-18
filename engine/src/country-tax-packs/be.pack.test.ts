import assert from "node:assert/strict";
import test from "node:test";
import { packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { BELGIUM_TAX_PACK } from "./be.ts";
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

test("Belgium pack is found by country with one return pack and the version pin", () => {
  assert.equal(BELGIUM_TAX_PACK.country, "BE");
  assert.equal(BELGIUM_TAX_PACK.code, "BE_INDIRECT_TAX");
  assert.equal(BELGIUM_TAX_PACK.version, "2026.08.01");
  assert.equal(BELGIUM_TAX_PACK.returnPacks.length, 1);
  assert.equal(BELGIUM_TAX_PACK.parentReturnPackCode, "BE_VAT_PERIODIC");
  assert.equal(BELGIUM_TAX_PACK.returnPacks[0]!.code, "BE_VAT_PERIODIC");
});

test("Belgium periodic return carries the real grille boxes plus workpapers", () => {
  const codes = new Set(BELGIUM_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode));
  for (const code of ["01", "02", "03", "54", "59", "71", "72", "OB_OUTPUT", "OB_INPUT"]) {
    assert.ok(codes.has(code), `missing box ${code}`);
  }
  const output = BELGIUM_TAX_PACK.returnPacks[0]!.boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  const input = BELGIUM_TAX_PACK.returnPacks[0]!.boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
  assert.equal(BELGIUM_TAX_PACK.returnPacks[0]!.defaultFrequency, "monthly");
  assert.equal(BELGIUM_TAX_PACK.returnPacks[0]!.submissionChannel, "file_upload");
  assert.equal(BELGIUM_TAX_PACK.returnPacks[0]!.governmentFormat, "certified_file");
});

test("Belgium declares three rate bands with resolving sources and contiguous history", () => {
  const codes = packTaxCodesForReturn(BELGIUM_TAX_PACK, "BE_VAT_PERIODIC");
  assert.deepEqual(
    codes.map((code) => [code.code, code.role, code.ratePercent]),
    [
      ["BE-VAT-STD", "standard", 21],
      ["BE-VAT-RED12", "reduced", 12],
      ["BE-VAT-RED6", "reduced", 6],
    ],
  );
  const sourceIds = new Set(BELGIUM_TAX_PACK.sources.map((source) => source.id));
  for (const code of codes) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a schedule`);
    for (const rate of code.rates!) {
      assert.ok(sourceIds.has(rate.sourceId), `${code.code} sourceId ${rate.sourceId} must resolve`);
    }
    assertContiguous(code.rates!);
  }
  assert.deepEqual(
    codes.find((code) => code.code === "BE-VAT-STD")!.rates,
    [{ ratePercent: 21, effectiveFrom: "2026-09-18", sourceId: "fps_vat_rates" }],
  );
});

test("Belgium primary code is the standard band and VAT is federal", () => {
  assert.equal(primaryPackTaxCode(BELGIUM_TAX_PACK, "BE_VAT_PERIODIC")?.code, "BE-VAT-STD");
  assert.equal(BELGIUM_TAX_PACK.jurisdictions.length, 0);
});
