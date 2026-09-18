import assert from "node:assert/strict";
import test from "node:test";
import { packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { TURKIYE_TAX_PACK } from "./tr.ts";
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

test("Türkiye KDV pack declares the monthly KDV1 return with pinned version", () => {
  assert.equal(TURKIYE_TAX_PACK.country, "TR");
  assert.equal(TURKIYE_TAX_PACK.code, "TR_INDIRECT_TAX");
  assert.equal(TURKIYE_TAX_PACK.version, "2026.08.01");
  assert.equal(TURKIYE_TAX_PACK.countryTaxType, "vat");
  assert.equal(TURKIYE_TAX_PACK.parentReturnPackCode, "TR_KDV1");
  assert.equal(TURKIYE_TAX_PACK.returnPacks.length, 1);
  assert.equal(TURKIYE_TAX_PACK.returnPacks[0]!.code, "TR_KDV1");
  assert.equal(TURKIYE_TAX_PACK.jurisdictions.length, 0);
});

test("TR_KDV1 is a monthly portal-filed return with real beyanname boxes", () => {
  const pack = TURKIYE_TAX_PACK.returnPacks[0]!;
  assert.equal(pack.defaultFrequency, "monthly");
  assert.equal(pack.submissionChannel, "portal_manual");
  assert.equal(pack.governmentFormat, "portal_entry");
  assert.equal(pack.submissionUrl, "https://dijital.gib.gov.tr/");
  const codes = new Set(pack.boxes.map((box) => box.lineCode));
  for (const code of [
    "MATRAH-20",
    "HESAPLANAN-20",
    "MATRAH-10",
    "HESAPLANAN-10",
    "MATRAH-1",
    "HESAPLANAN-1",
    "INDIRILECEK-KDV",
    "ODENECEK-KDV",
    "OB_OUTPUT",
    "OB_INPUT",
  ]) {
    assert.ok(codes.has(code), `missing box ${code}`);
  }
  const output = pack.boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  const input = pack.boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("Türkiye carries all three KDV bands with the July 2023 increase transcribed", () => {
  const set = packTaxCodesForReturn(TURKIYE_TAX_PACK, "TR_KDV1");
  assert.deepEqual(set.map((entry) => [entry.code, entry.role ?? null, entry.ratePercent]), [
    ["TR-VAT-STD", "standard", 20],
    ["TR-VAT-RED10", "reduced", 10],
    ["TR-VAT-RED1", "reduced", 1],
  ]);
  const std = set.find((entry) => entry.code === "TR-VAT-STD")!;
  assert.deepEqual(std.rates, [
    { ratePercent: 18, effectiveFrom: "2007-12-31", effectiveTo: "2023-07-09", sourceId: "rg_2007_13033_baseline" },
    { ratePercent: 20, effectiveFrom: "2023-07-10", sourceId: "rg_7346_kdv_2023" },
  ]);
  assertContiguous(std.rates ?? []);
  const red10 = set.find((entry) => entry.code === "TR-VAT-RED10")!;
  assert.deepEqual(red10.rates, [
    { ratePercent: 8, effectiveFrom: "2007-12-31", effectiveTo: "2023-07-09", sourceId: "rg_2007_13033_baseline" },
    { ratePercent: 10, effectiveFrom: "2023-07-10", sourceId: "rg_7346_kdv_2023" },
  ]);
  assertContiguous(red10.rates ?? []);
  // The 2023 decision left the 1% liste-I band untouched: one open band.
  const red1 = set.find((entry) => entry.code === "TR-VAT-RED1")!;
  assert.deepEqual(red1.rates, [
    { ratePercent: 1, effectiveFrom: "2007-12-31", sourceId: "rg_2007_13033_baseline" },
  ]);
  assertContiguous(red1.rates ?? []);
  assert.equal(primaryPackTaxCode(TURKIYE_TAX_PACK, "TR_KDV1")?.code, "TR-VAT-STD");
});

test("every Türkiye rate source pointer resolves to a declared source", () => {
  const ids = new Set(TURKIYE_TAX_PACK.sources.map((source) => source.id));
  for (const entry of packTaxCodesForReturn(TURKIYE_TAX_PACK, "TR_KDV1")) {
    for (const rate of entry.rates ?? []) {
      assert.ok(ids.has(rate.sourceId), `unresolved pointer ${rate.sourceId}`);
    }
  }
  for (const id of ["rg_7346_kdv_2023", "rg_2007_13033_baseline", "gib_dvd_portal", "gib_ebeyan_doc"]) {
    assert.ok(ids.has(id), `missing source ${id}`);
  }
  for (const id of ["sovos_tr_kdv_july2023", "trustus_tr_kdv_table", "kdv1_v41_duyuru_mirror", "sirkuler_2008_03_baseline"]) {
    assert.ok(!ids.has(id), `orphaned vendor source still declared: ${id}`);
  }
});

test("Türkiye sources live only on gazette and tax-authority hosts", () => {
  for (const source of TURKIYE_TAX_PACK.sources) {
    const host = new URL(source.url).hostname;
    const official = host === "www.resmigazete.gov.tr" || host.endsWith(".gib.gov.tr") || host === "gib.gov.tr";
    assert.ok(official, `non-authority host for ${source.id}: ${host}`);
  }
});
