import assert from "node:assert/strict";
import test from "node:test";
import { isTaxProvisionSelection, PACK_DEFAULT_CODES, supportedTaxCountries } from "../tax-pack-provisioning.ts";
import { COUNTRY_TAX_PACKS } from "./index.ts";
import type { CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";

const maintainedCountries = ["IN", "ZA", "AE", "JP"] as const;

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

test("third-wave maintained country packs are directly provisionable", () => {
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

test("India exposes only the sourced combined 18% schedule and makes classification limits explicit", () => {
  const definition = pack("IN");
  assert.deepEqual(PACK_DEFAULT_CODES.IN_GSTR3B?.rates, [
    { ratePercent: 18, effectiveFrom: "2017-07-01", sourceId: "cbic_gst_rate_schedule" },
  ]);
  assert.match(PACK_DEFAULT_CODES.IN_GSTR3B!.name, /classification required/i);
  assert.equal(definition.completeness.jurisdictions, "partial");
  assert.equal(definition.completeness.standardRates, "partial");
  assert.equal(definition.completeness.localRates, "partial");
  assert.match(definition.returnPacks[0]!.watermark, /IGST\/CGST\/SGST\/UTGST/);
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "3.1(a)", "3.1(b)", "3.1(c)", "3.1(d)", "3.1(e)", "3.1.1(i)", "3.1.1(ii)", "3.2",
    "4(A)", "4(B)", "4(C)", "4(D)", "5", "5.1", "6.1", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("South Africa preserves the complete SARS standard-rate history and VAT201 Fields 1 through 20", () => {
  const definition = pack("ZA");
  const rates = PACK_DEFAULT_CODES.ZA_VAT201?.rates ?? [];
  assert.deepEqual(rates, [
    { ratePercent: 10, effectiveFrom: "1991-09-30", effectiveTo: "1993-04-06", sourceId: "sars_vat_rate_history" },
    { ratePercent: 14, effectiveFrom: "1993-04-07", effectiveTo: "2018-03-31", sourceId: "sars_vat_rate_history" },
    { ratePercent: 15, effectiveFrom: "2018-04-01", sourceId: "sars_vat_current" },
  ]);
  assertContiguous(rates);
  assert.equal(definition.completeness.standardRates, "complete");
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "1", "1A", "2", "2A", "3", "4", "4A", "5", "6", "7", "8", "9", "10", "11", "12",
    "13", "14", "14A", "15", "15A", "16", "17", "18", "19", "20",
  ]);
  assert.equal(definition.returnPacks[0]!.boxes.find((box) => box.lineCode === "20")?.formula, "13 - 19");
});

test("United Arab Emirates installs only the federal 5% rate and preserves all fourteen VAT201 boxes", () => {
  const definition = pack("AE");
  assert.deepEqual(PACK_DEFAULT_CODES.AE_VAT201?.rates, [
    { ratePercent: 5, effectiveFrom: "2018-01-01", sourceId: "fta_vat_introduction" },
  ]);
  assert.equal(definition.completeness.standardRates, "complete");
  assert.equal(definition.completeness.localRates, "not_applicable");
  assert.match(definition.returnPacks[0]!.boxes[0]!.label, /each Emirate/);
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14",
  ]);
});

test("Japan preserves all combined standard-rate eras while leaving reduced-rate classification manual", () => {
  const definition = pack("JP");
  const rates = PACK_DEFAULT_CODES.JP_CONSUMPTION?.rates ?? [];
  assert.deepEqual(rates.map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]), [
    ["1989-04-01", "1997-03-31", 3],
    ["1997-04-01", "2014-03-31", 5],
    ["2014-04-01", "2019-09-30", 8],
    ["2019-10-01", null, 10],
  ]);
  assertContiguous(rates);
  assert.equal(definition.completeness.standardRates, "complete");
  assert.match(definition.returnPacks[0]!.watermark, /standard and reduced rates/);
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "26", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("third-wave evidence remains restricted to official government and tax-authority hosts", () => {
  const officialHosts = new Set([
    "cbic-gst.gov.in",
    "tutorial.gst.gov.in",
    "www.sars.gov.za",
    "www.tax.gov.ae",
    "tax.gov.ae",
    "www.nta.go.jp",
  ]);
  for (const country of maintainedCountries) {
    for (const source of pack(country).sources) {
      assert.ok(officialHosts.has(new URL(source.url).hostname), `${source.id} is not an approved primary-source host`);
    }
  }
});
