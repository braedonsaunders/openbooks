import assert from "node:assert/strict";
import test from "node:test";
import { isTaxProvisionSelection, PACK_DEFAULT_CODES, supportedTaxCountries } from "../tax-pack-provisioning.ts";
import { COUNTRY_TAX_PACKS, packTaxCodesForReturn } from "./index.ts";
import type { CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";

const maintainedCountries = ["AU", "NZ", "GB", "DE", "FR"] as const;

function pack(country: (typeof maintainedCountries)[number]): CountryTaxPackDefinition {
  const value = COUNTRY_TAX_PACKS.find((entry) => entry.country === country);
  assert.ok(value, `missing ${country} country pack`);
  return value;
}

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

test("maintained international country packs are directly provisionable", () => {
  const countries = new Map(supportedTaxCountries().map((entry) => [entry.country, entry]));
  for (const country of maintainedCountries) {
    const definition = pack(country);
    const catalog = countries.get(country);
    assert.ok(catalog, `${country} is absent from setup`);
    assert.equal(catalog.countryStatus, "ready");
    assert.equal(catalog.countryPack, definition.parentReturnPackCode);
    assert.equal(definition.returnPacks.length, 1);
    assert.equal(isTaxProvisionSelection(definition.parentReturnPackCode!), true);
    assert.equal(definition.version, "2026.08.01");
    assert.equal(definition.jurisdictions.length, 0, `${country} must not invent subnational indirect-tax jurisdictions`);
  }
});

test("Australia GST has a source-backed schedule from commencement and official BAS labels", () => {
  assert.deepEqual(PACK_DEFAULT_CODES.AU_BAS_GST?.rates, [
    { ratePercent: 10, effectiveFrom: "2000-07-01", sourceId: "ato_gst_commencement" },
  ]);
  assert.deepEqual(pack("AU").returnPacks[0]!.boxes.map((box) => box.lineCode), ["G1", "G2", "G3", "G10", "G11", "1A", "1B"]);
});

test("New Zealand GST preserves all three statutory rate eras and the GST101A calculation order", () => {
  const rates = PACK_DEFAULT_CODES.NZ_GST101A?.rates ?? [];
  assert.deepEqual(rates, [
    { ratePercent: 10, effectiveFrom: "1986-10-01", effectiveTo: "1989-06-30", sourceId: "nz_gst_rate_history" },
    { ratePercent: 12.5, effectiveFrom: "1989-07-01", effectiveTo: "2010-09-30", sourceId: "nz_gst_rate_history" },
    { ratePercent: 15, effectiveFrom: "2010-10-01", sourceId: "nz_gst_2010_increase" },
  ]);
  assertContiguous(rates);
  const boxes = pack("NZ").returnPacks[0]!.boxes;
  assert.deepEqual(boxes.map((box) => box.lineCode), ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
  assert.equal(boxes.find((box) => box.lineCode === "15")?.formula, "abs(10 - 14)");
});

test("United Kingdom VAT carries HMRC's complete standard-rate history and current Northern Ireland box wording", () => {
  const rates = PACK_DEFAULT_CODES.GB_VAT100?.rates ?? [];
  assert.deepEqual(rates.map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]), [
    ["1973-04-01", "1974-07-28", 10],
    ["1974-07-29", "1979-06-17", 8],
    ["1979-06-18", "1991-03-31", 15],
    ["1991-04-01", "2008-11-30", 17.5],
    ["2008-12-01", "2009-12-31", 15],
    ["2010-01-01", "2011-01-03", 17.5],
    ["2011-01-04", null, 20],
  ]);
  assertContiguous(rates);
  const boxes = pack("GB").returnPacks[0]!.boxes;
  assert.match(boxes.find((box) => box.lineCode === "2")!.label, /Northern Ireland/);
  assert.match(boxes.find((box) => box.lineCode === "8")!.label, /Northern Ireland/);
  assert.match(boxes.find((box) => box.lineCode === "9")!.label, /Northern Ireland/);
});

test("United Kingdom VAT100 carries standard, reduced, and zero-rate codes from HMRC Notice 700", () => {
  const codes = packTaxCodesForReturn(pack("GB"), "GB_VAT100");
  assert.deepEqual(codes.map((code) => [code.code, code.role, code.ratePercent]), [
    ["GB-VAT-STD", "standard", 20],
    ["GB-VAT-RED", "reduced", 5],
    ["GB-VAT-ZERO", "zero", 0],
  ]);
  const reduced = codes.find((code) => code.code === "GB-VAT-RED")!;
  assert.deepEqual(reduced.rates, [
    { ratePercent: 8, effectiveFrom: "1994-04-01", effectiveTo: "1997-08-31", sourceId: "hmrc_vat_rate_history" },
    { ratePercent: 5, effectiveFrom: "1997-09-01", sourceId: "hmrc_vat_rate_history" },
  ]);
  assertContiguous(reduced.rates ?? []);
  const zero = codes.find((code) => code.code === "GB-VAT-ZERO")!;
  assert.deepEqual(zero.rates, [
    { ratePercent: 0, effectiveFrom: "1973-04-01", sourceId: "hmrc_vat_rate_history" },
  ]);
  assert.equal(PACK_DEFAULT_CODES.GB_VAT100?.code, "GB-VAT-STD");
});

test("Germany uses the official 2026 UStVA identifiers and preserves the temporary 2020 rate reduction", () => {
  const definition = pack("DE");
  const rates = PACK_DEFAULT_CODES.DE_USTVA?.rates ?? [];
  assert.equal(rates.find((rate) => rate.effectiveFrom === "2020-07-01")?.ratePercent, 16);
  assert.equal(rates.find((rate) => rate.effectiveFrom === "2021-01-01")?.ratePercent, 19);
  assertContiguous(rates);
  const codes = new Set(definition.returnPacks[0]!.boxes.map((box) => box.lineCode));
  for (const code of ["81", "86", "87", "41", "66", "61", "62", "67", "83"]) assert.ok(codes.has(code));
  assert.ok(definition.sources.some((source) => source.id === "bmf_ustva_2026" && source.url.includes("2025-12-29")));
  const deSet = packTaxCodesForReturn(definition, "DE_USTVA");
  assert.deepEqual(deSet.map((entry) => [entry.code, entry.role ?? null]), [
    ["DE-VAT-STD", "standard"],
    ["DE-VAT-RED", "reduced"],
  ]);
  const redRates = deSet[1]!.rates ?? [];
  assert.deepEqual(redRates.map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]), [
    ["1968-01-01", "1968-06-30", 5],
    ["1968-07-01", "1977-12-31", 5.5],
    ["1978-01-01", "1979-06-30", 6],
    ["1979-07-01", "1983-06-30", 6.5],
    ["1983-07-01", "2020-06-30", 7],
    ["2020-07-01", "2020-12-31", 5],
    ["2021-01-01", null, 7],
  ]);
  assertContiguous(redRates);
});

test("France is provisionable without overstating territorial completeness", () => {
  const definition = pack("FR");
  assert.equal(PACK_DEFAULT_CODES.FR_CA3?.ratePercent, 20);
  assert.equal(PACK_DEFAULT_CODES.FR_CA3?.name, "France metropolitan standard VAT");
  assert.deepEqual(PACK_DEFAULT_CODES.FR_CA3?.rates, [
    { ratePercent: 20, effectiveFrom: "2014-01-01", sourceId: "dgfip_standard_vat_2014" },
  ]);
  assert.equal(definition.completeness.jurisdictions, "partial");
  assert.equal(definition.completeness.standardRates, "partial");
  assert.equal(definition.completeness.localRates, "partial");
  assert.ok(definition.sources.some((source) => source.id === "dgfip_ca3_2026" && source.url.includes("/2026/")));
  const codes = new Set(definition.returnPacks[0]!.boxes.map((box) => box.lineCode));
  for (const code of ["A1", "E1", "08", "09", "9B", "16", "19", "20", "23", "25", "TD", "28"]) assert.ok(codes.has(code));
});

test("maintained sources remain restricted to official government and tax-authority hosts", () => {
  const officialHosts = new Set([
    "www.ato.gov.au",
    "www.ird.govt.nz",
    "www.taxtechnical.ird.govt.nz",
    "www.gov.uk",
    "www.bundesfinanzministerium.de",
    "www.elster.de",
    "bofip.impots.gouv.fr",
    "www.impots.gouv.fr",
  ]);
  for (const country of maintainedCountries) {
    for (const source of pack(country).sources) {
      assert.ok(officialHosts.has(new URL(source.url).hostname), `${source.id} is not an approved primary-source host`);
    }
  }
});
