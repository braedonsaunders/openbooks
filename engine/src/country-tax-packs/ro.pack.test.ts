import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { ROMANIA_TAX_PACK } from "./ro.ts";
import type { EffectiveTaxRate } from "./types.ts";

const pack = ROMANIA_TAX_PACK;

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

test("Romania TVA pack identity: RO indirect tax, one D300 return, pinned version", () => {
  assert.equal(pack.code, "RO_INDIRECT_TAX");
  assert.equal(pack.country, "RO");
  assert.equal(pack.countryTaxType, "vat");
  assert.equal(pack.version, "2026.08.01");
  assert.equal(pack.parentReturnPackCode, "RO_D300");
  assert.equal(pack.returnPacks.length, 1);
  assert.equal(pack.returnPacks[0]!.code, "RO_D300");
  assert.deepEqual(pack.jurisdictions, []);
});

test("RO_D300 carries the real D300 rânduri plus the ledger workpapers", () => {
  const boxes = pack.returnPacks[0]!.boxes;
  assert.deepEqual(
    boxes.map((box) => box.lineCode),
    ["9", "10", "19", "24", "25", "31", "32", "36", "37", "38", "41", "44", "45", "46", "OB_OUTPUT", "OB_INPUT"],
  );
});

test("RO_D300 declares standard and reduced bands through the pack reader", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(pack), ["RO_D300"]);
  const codes = packTaxCodesForReturn(pack, "RO_D300");
  assert.deepEqual(
    codes.map((code) => [code.code, code.role, code.ratePercent]),
    [
      ["RO-VAT-STD", "standard", 21],
      ["RO-VAT-RED11", "reduced", 11],
    ],
  );
  assert.deepEqual(
    codes[0]!.rates,
    [
      { ratePercent: 19, effectiveFrom: "2017-01-01", effectiveTo: "2025-07-31", sourceId: "codul_fiscal_art291_19" },
      { ratePercent: 21, effectiveFrom: "2025-08-01", sourceId: "mo_826_2025_d300" },
    ],
  );
  assert.deepEqual(codes[1]!.rates, [{ ratePercent: 11, effectiveFrom: "2025-08-01", sourceId: "mo_826_2025_d300" }]);
  for (const code of codes) assertContiguous(code.rates ?? []);
});

test("every rate sourceId resolves to a declared source", () => {
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(pack, "RO_D300")) {
    for (const rate of code.rates ?? []) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} has no declared source`);
  }
});

test("primary code for RO_D300 is the standard 21% band", () => {
  assert.equal(primaryPackTaxCode(pack, "RO_D300")?.code, "RO-VAT-STD");
});

test("OB workpaper boxes tie the ledger on both sides", () => {
  const boxes = pack.returnPacks[0]!.boxes;
  assert.deepEqual(boxes.find((box) => box.lineCode === "OB_OUTPUT"), {
    lineCode: "OB_OUTPUT",
    label: "OpenBooks workpaper — output TVA from the ledger, all configured rates",
    sign: -1,
    sequence: 150,
    basis: "tax_collected",
    glMap: "sales",
  });
  assert.deepEqual(boxes.find((box) => box.lineCode === "OB_INPUT"), {
    lineCode: "OB_INPUT",
    label: "OpenBooks workpaper — input TVA from the ledger, all configured rates",
    sign: 1,
    sequence: 160,
    basis: "tax_paid",
    glMap: "purchases",
  });
});

test("RO_D300 files monthly as a certified file to ANAF", () => {
  const definition = pack.returnPacks[0]!;
  assert.equal(definition.defaultFrequency, "monthly");
  assert.equal(definition.submissionChannel, "file_upload");
  assert.equal(definition.governmentFormat, "certified_file");
  assert.ok(definition.submissionUrl.startsWith("https://www.anaf.ro"));
});
