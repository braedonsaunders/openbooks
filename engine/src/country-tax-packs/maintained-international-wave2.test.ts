import assert from "node:assert/strict";
import test from "node:test";
import { isTaxProvisionSelection, PACK_DEFAULT_CODES, supportedTaxCountries } from "../tax-pack-provisioning.ts";
import { COUNTRY_TAX_PACKS } from "./index.ts";
import type { CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";

const maintainedCountries = ["ES", "IT", "NL", "IE", "SG"] as const;

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

test("second-wave maintained country packs are directly provisionable", () => {
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

test("Spain provisions only the sourced IVA-territory standard rate and declares territorial scope partial", () => {
  const definition = pack("ES");
  assert.deepEqual(PACK_DEFAULT_CODES.ES_MODELO303?.rates, [
    { ratePercent: 21, effectiveFrom: "2012-09-01", sourceId: "aeat_2012_standard_rate_change" },
  ]);
  assert.equal(definition.completeness.jurisdictions, "partial");
  assert.equal(definition.completeness.standardRates, "partial");
  assert.equal(definition.completeness.localRates, "partial");
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "07", "08", "09", "27", "28", "29", "45", "46", "OB_OUTPUT", "OB_INPUT",
  ]);
});

test("Italy uses the official LIPE VP fields without inventing automatic credit or advance calculations", () => {
  const definition = pack("IT");
  assert.deepEqual(PACK_DEFAULT_CODES.IT_LIPE?.rates, [
    { ratePercent: 22, effectiveFrom: "2013-10-01", sourceId: "italy_vat_22_from_2013" },
  ]);
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "VP2", "VP3", "VP4", "VP5", "VP6", "VP7", "VP8", "VP9", "VP10", "VP11", "VP12", "VP13", "VP14",
  ]);
  assert.equal(definition.returnPacks[0]!.boxes.find((box) => box.lineCode === "VP14")?.formula, undefined);
});

test("Netherlands carries the sourced 1992-present standard-rate schedule and current 2026 rubrieken", () => {
  const definition = pack("NL");
  const rates = PACK_DEFAULT_CODES.NL_OB?.rates ?? [];
  assert.deepEqual(rates, [
    { ratePercent: 17.5, effectiveFrom: "1992-10-01", effectiveTo: "2000-12-31", sourceId: "netherlands_standard_rate_history" },
    { ratePercent: 19, effectiveFrom: "2001-01-01", effectiveTo: "2012-09-30", sourceId: "netherlands_standard_rate_history" },
    { ratePercent: 21, effectiveFrom: "2012-10-01", sourceId: "netherlands_vat_21_2012" },
  ]);
  assertContiguous(rates);
  assert.equal(definition.completeness.standardRates, "partial");
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "1a", "1b", "1c", "1d", "1e", "2a", "3a", "3b", "3c", "4a", "4b", "5a", "5b",
  ]);
  assert.ok(definition.sources.some((source) => source.id === "belastingdienst_vat_return_2026" && source.url.includes("t62fd.pdf")));
});

test("Ireland preserves Revenue's complete standard-rate history and current VAT3 fields", () => {
  const definition = pack("IE");
  const rates = PACK_DEFAULT_CODES.IE_VAT3?.rates ?? [];
  assert.equal(rates.length, 17);
  assert.deepEqual(rates[0], {
    ratePercent: 16.37,
    effectiveFrom: "1972-11-01",
    effectiveTo: "1973-09-02",
    sourceId: "revenue_historical_vat_rates_2026",
  });
  assert.deepEqual(rates.at(-1), {
    ratePercent: 23,
    effectiveFrom: "2021-03-01",
    sourceId: "revenue_historical_vat_rates_2026",
  });
  assertContiguous(rates);
  assert.equal(definition.completeness.standardRates, "complete");
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "T1", "T2", "T3", "T4", "E1", "E2", "ES1", "ES2", "PA1",
  ]);
  assert.equal(definition.returnPacks[0]!.boxes.find((box) => box.lineCode === "T3")?.formula, undefined);
  assert.equal(definition.returnPacks[0]!.boxes.find((box) => box.lineCode === "T4")?.formula, undefined);
});

test("Singapore preserves every GST rate era and the fifteen current core F5 boxes", () => {
  const definition = pack("SG");
  const rates = PACK_DEFAULT_CODES.SG_GSTF5?.rates ?? [];
  assert.deepEqual(rates.map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]), [
    ["1994-04-01", "2002-12-31", 3],
    ["2003-01-01", "2003-12-31", 4],
    ["2004-01-01", "2007-06-30", 5],
    ["2007-07-01", "2022-12-31", 7],
    ["2023-01-01", "2023-12-31", 8],
    ["2024-01-01", null, 9],
  ]);
  assertContiguous(rates);
  assert.equal(definition.completeness.standardRates, "complete");
  assert.deepEqual(definition.returnPacks[0]!.boxes.map((box) => box.lineCode), [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15",
  ]);
});

test("second-wave maintained sources remain restricted to official government and tax-authority hosts", () => {
  const officialHosts = new Set([
    "sede.agenciatributaria.gob.es",
    "www.gazzettaufficiale.it",
    "def.finanze.it",
    "www1.agenziaentrate.gov.it",
    "www.belastingdienst.nl",
    "download.belastingdienst.nl",
    "zoek.officielebekendmakingen.nl",
    "www.revenue.ie",
    "www.iras.gov.sg",
    "apisandbox.iras.gov.sg",
  ]);
  for (const country of maintainedCountries) {
    for (const source of pack(country).sources) {
      assert.ok(officialHosts.has(new URL(source.url).hostname), `${source.id} is not an approved primary-source host`);
    }
  }
});
