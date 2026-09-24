import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { ARGENTINA_TAX_PACK } from "./ar.ts";
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

test("Argentina pack is found by country with one F2002 return and the maintained version pin", () => {
  assert.equal(ARGENTINA_TAX_PACK.country, "AR");
  assert.equal(ARGENTINA_TAX_PACK.code, "AR_INDIRECT_TAX");
  assert.equal(ARGENTINA_TAX_PACK.countryTaxType, "vat");
  assert.equal(ARGENTINA_TAX_PACK.version, "2026.08.01");
  assert.equal(ARGENTINA_TAX_PACK.returnPacks.length, 1);
  assert.equal(ARGENTINA_TAX_PACK.parentReturnPackCode, "AR_F2002");
  assert.equal(ARGENTINA_TAX_PACK.returnPacks[0]!.code, "AR_F2002");
});

test("Argentina return carries the real F2002 lines plus the two OB workpaper boxes", () => {
  assert.deepEqual(ARGENTINA_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "DF_ALIC_21", "DF_ALIC_105", "DF_ALIC_27", "CF_TOTAL", "SALDO_AFIP", "SALDO_CONTRIB", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Argentina filing is monthly portal entry through the ARCA responsables inscriptos page", () => {
  const returnPack = ARGENTINA_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "monthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /arca\.gob\.ar/);
});

test("Argentina declares the 21/10.5/27 bands with the surcharge band carrying no role", () => {
  const codes = packTaxCodesForReturn(ARGENTINA_TAX_PACK, "AR_F2002");
  assert.deepEqual(codes.map((code) => [code.code, code.role ?? null, code.ratePercent]), [
    ["AR-VAT-STD", "standard", 21],
    ["AR-VAT-RED105", "reduced", 10.5],
    ["AR-VAT-INC27", null, 27],
  ]);
  assert.ok(!codes.some((code) => code.role === "zero"), "exentas carry no tax, so no zero code");
});

test("Argentina primary code is the standard 21% band", () => {
  assert.equal(primaryPackTaxCode(ARGENTINA_TAX_PACK, "AR_F2002")?.code, "AR-VAT-STD");
});

test("Argentina rate schedules are contiguous and every sourceId resolves", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(ARGENTINA_TAX_PACK), ["AR_F2002"]);
  const sourceIds = new Set(ARGENTINA_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(ARGENTINA_TAX_PACK, "AR_F2002")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
  }
});

test("Argentina IVA is national with no subnational jurisdictions", () => {
  assert.equal(ARGENTINA_TAX_PACK.jurisdictions.length, 0);
});

test("Argentina 27% band opens at the sourced 1992 differential, not at the fetch date", () => {
  const codes = packTaxCodesForReturn(ARGENTINA_TAX_PACK, "AR_F2002");
  const increased = codes.find((entry) => entry.code === "AR-VAT-INC27")!;
  // Infoleg's EVOLUCION table restores the 27% differential alongside the
  // 18% general rate under Ley 23.966 (note 2): a fetch-dated opening here
  // refuses every real pre-2026 document priced at 27%.
  assert.deepEqual(
    increased.rates!.map((rate) => [rate.ratePercent, rate.effectiveFrom, rate.effectiveTo ?? null]),
    [[27, "1992-03-01", null]],
  );
});

test("Argentina standard band runs back to 1992 with the one-year grant, restoration and 2002 window kept", () => {
  const codes = packTaxCodesForReturn(ARGENTINA_TAX_PACK, "AR_F2002");
  assert.deepEqual(
    codes.find((entry) => entry.code === "AR-VAT-STD")!.rates!.map((rate) => [rate.ratePercent, rate.effectiveFrom, rate.effectiveTo ?? null]),
    [
      [18, "1992-03-01", "1995-03-31"],
      [21, "1995-04-01", "1996-03-31"],
      [21, "1996-04-01", "2002-11-17"],
      [19, "2002-11-18", "2003-01-17"],
      [21, "2003-01-18", null],
    ],
  );
  assert.deepEqual(
    codes.find((entry) => entry.code === "AR-VAT-RED105")!.rates!.map((rate) => [rate.ratePercent, rate.effectiveFrom, rate.effectiveTo ?? null]),
    [
      [9.5, "2002-11-18", "2003-01-17"],
      [10.5, "2003-01-18", null],
    ],
  );
});
