import assert from "node:assert/strict";
import test from "node:test";
import { packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { GREECE_TAX_PACK } from "./gr.ts";
import { assertPackCodeRateSchedule } from "./rate-schedule.ts";
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

test("Greece pack is found by country with one Φ2 return and the maintained version pin", () => {
  assert.equal(GREECE_TAX_PACK.country, "GR");
  assert.equal(GREECE_TAX_PACK.code, "GR_INDIRECT_TAX");
  assert.equal(GREECE_TAX_PACK.countryTaxType, "vat");
  assert.equal(GREECE_TAX_PACK.version, "2026.08.01");
  assert.equal(GREECE_TAX_PACK.returnPacks.length, 1);
  assert.equal(GREECE_TAX_PACK.parentReturnPackCode, "GR_FPA_F2");
  assert.equal(GREECE_TAX_PACK.returnPacks[0]!.code, "GR_FPA_F2");
});

test("Greece Φ2 carries the mainland, island, settlement and OB workpaper boxes", () => {
  assert.deepEqual(GREECE_TAX_PACK.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "301", "331", "302", "332", "303", "333", "308", "338",
    "304", "334", "305", "335", "306", "336", "309", "339",
    "307", "337", "367", "387", "430",
    "470", "480", "511", "502", "503",
    "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Greece filing defaults to quarterly portal entry through myAADE", () => {
  const returnPack = GREECE_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "quarterly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /aade\.gr/);
});

test("Greece declares mainland 24/13/6/4 bands plus the island 17/9/4/3 bands with honest roles", () => {
  const codes = packTaxCodesForReturn(GREECE_TAX_PACK, "GR_FPA_F2");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["GR-VAT-STD", "standard", 24],
    ["GR-VAT-RED13", "reduced", 13],
    ["GR-VAT-RED6", "reduced", 6],
    ["GR-VAT-RED4", "reduced", 4],
    ["GR-VAT-ISL17", "reduced", 17],
    ["GR-VAT-ISL9", "reduced", 9],
    ["GR-VAT-ISL4", "reduced", 4],
    ["GR-VAT-ISL3", "reduced", 3],
  ]);
  assert.ok(!codes.some((code) => code.role === "zero"), "no zero-rated band on the Φ2, so no zero code");
});

test("Greece primary code is the mainland standard 24% band", () => {
  assert.equal(primaryPackTaxCode(GREECE_TAX_PACK, "GR_FPA_F2")?.code, "GR-VAT-STD");
});

test("Greece rate schedules are contiguous, sourced, and each cover the pinned date", () => {
  assert.deepEqual(packReturnCodesWithTaxCodes(GREECE_TAX_PACK), ["GR_FPA_F2"]);
  const sourceIds = new Set(GREECE_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(GREECE_TAX_PACK, "GR_FPA_F2")) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must carry a sourced schedule`);
    assertContiguous(code.rates!);
    for (const rate of code.rates!) assert.ok(sourceIds.has(rate.sourceId), `${rate.sourceId} must resolve`);
    assertPackCodeRateSchedule(`GR_INDIRECT_TAX/GR_FPA_F2/${code.code}`, code, "2026-09-18");
  }
});

test("Greece island rates share the Φ2 with no subnational VAT jurisdictions", () => {
  assert.equal(GREECE_TAX_PACK.jurisdictions.length, 0);
});
