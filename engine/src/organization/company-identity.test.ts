import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompanyAddress,
  formatTaxIds,
  LEGAL_FORMS,
  luhnValid,
  normalizeCompanyAddress,
  normalizeTaxIds,
  payerTaxIdentifier,
  readTaxIds,
  taxClassificationsFor,
  taxIdScheme,
  taxIdSchemesFor,
} from "./company-identity.ts";

const isCountry = (code: string) => /^[A-Z]{2}$/.test(code);

test("identifiers normalize to their canonical form and refuse malformed numbers", () => {
  const normalize = (key: string, raw: string, country: string) => taxIdScheme(key)!.normalize(raw, country);
  assert.equal(normalize("us_ein", "123456789", "US"), "12-3456789");
  assert.equal(normalize("us_ein", "12-345678", "US"), null, "an EIN has nine digits");
  assert.equal(normalize("us_ein", "00-1234567", "US"), null, "no EIN is issued with prefix 00");
  // The CRA's published example business number passes its check digit.
  assert.equal(normalize("ca_bn", "123 456 782", "CA"), "123456782");
  assert.equal(normalize("ca_bn", "123456789", "CA"), null, "a business number must pass its check digit");
  assert.equal(normalize("ca_gst_hst", "123456782 rt 0001", "CA"), "123456782RT0001");
  assert.equal(normalize("ca_gst_hst", "123456789RT0001", "CA"), null);
  assert.equal(normalize("ca_qst", "1234567890 TQ 0001", "CA"), "1234567890TQ0001");
  assert.equal(normalize("gb_vat", "123 4567 89", "GB"), "GB123456789");
  assert.equal(normalize("eu_vat", "123456789", "DE"), "DE123456789", "the member state prefix is supplied");
  assert.equal(normalize("eu_vat", "EL123456789", "GR"), "EL123456789", "Greece files under EL");
  assert.equal(normalize("eu_vat", "FR12345678901", "DE"), null, "another member state's number is refused");
  // The ATO's published example ABN passes its weighted checksum.
  assert.equal(normalize("au_abn", "51 824 753 556", "AU"), "51824753556");
  assert.equal(normalize("au_abn", "51824753557", "AU"), null);
  assert.equal(luhnValid("123456782"), true);
  assert.equal(luhnValid("12345678A"), false);
});

test("each jurisdiction offers its own schemes and the generic numbers it lacks", () => {
  const keys = (country: string) => taxIdSchemesFor(country).map((scheme) => scheme.key);
  assert.deepEqual(keys("US"), ["us_ein", "tax_id", "registration"]);
  assert.deepEqual(keys("CA"), ["ca_bn", "ca_gst_hst", "ca_qst", "tax_id", "registration"]);
  assert.deepEqual(keys("GB"), ["gb_vat", "gb_crn"]);
  assert.deepEqual(keys("FR"), ["eu_vat", "registration"]);
  assert.deepEqual(keys("JP"), ["tax_id", "registration"]);
});

test("a full identifier map validates against the company's country", () => {
  const ok = normalizeTaxIds({ us_ein: "123456789", tax_id: "", registration: null }, "US", {});
  assert.deepEqual(ok, { ok: true, taxIds: { us_ein: "12-3456789" } }, "blanks remove an identifier");
  assert.deepEqual(normalizeTaxIds({ us_ein: "12" }, "US", {}), { ok: false, problem: { scheme: "us_ein", reason: "invalid" } });
  assert.deepEqual(normalizeTaxIds({ ca_bn: "123456782" }, "US", {}), {
    ok: false,
    problem: { scheme: "ca_bn", reason: "not_in_country" },
  });
  assert.deepEqual(normalizeTaxIds({ ssn: "x" }, "US", {}), { ok: false, problem: { scheme: "ssn", reason: "unknown_scheme" } });
  // A company that moved keeps a stored identifier resubmitted unchanged.
  assert.deepEqual(normalizeTaxIds({ ca_bn: "123456782", us_ein: "12-3456789" }, "US", { ca_bn: "123456782" }), {
    ok: true,
    taxIds: { ca_bn: "123456782", us_ein: "12-3456789" },
  });
});

test("legal forms constrain their tax classification, and S status is US only", () => {
  assert.deepEqual(taxClassificationsFor("sole_proprietorship", "US"), ["individual"]);
  assert.deepEqual(taxClassificationsFor("llc", "US"), ["individual", "partnership", "corporation", "s_corporation"]);
  assert.deepEqual(taxClassificationsFor("llc", "CA"), ["individual", "partnership", "corporation"]);
  assert.deepEqual(taxClassificationsFor("corporation", "GB"), ["corporation"]);
  for (const form of LEGAL_FORMS) assert.ok(taxClassificationsFor(form, "US").length > 0, `${form} has a treatment`);
});

test("addresses trim, require a street and city, and print on one line", () => {
  const result = normalizeCompanyAddress(
    { line1: " 400  King St W ", line2: "Suite 300", city: "Toronto", region: "ON", postalCode: "m5v 1k2", country: "ca" },
    isCountry,
  );
  assert.ok(result.ok);
  assert.equal(formatCompanyAddress(result.address), "400 King St W, Suite 300, Toronto, ON M5V 1K2, CA");
  assert.deepEqual(normalizeCompanyAddress({ line1: "", city: "" }, isCountry), { ok: true, address: null });
  assert.deepEqual(normalizeCompanyAddress({ line1: "1 Main", country: "US" }, isCountry), {
    ok: false,
    problem: { field: "city", reason: "required" },
  });
  assert.deepEqual(normalizeCompanyAddress({ line1: "1 Main", city: "Austin", country: "USA" }, isCountry), {
    ok: false,
    problem: { field: "country", reason: "invalid_country" },
  });
});

test("printed identifiers follow registry order and name the payer's federal number", () => {
  const ids = readTaxIds({ ca_gst_hst: "123456782RT0001", ca_bn: "123456782", unknown: "x", empty: "" });
  assert.deepEqual(ids, { ca_gst_hst: "123456782RT0001", ca_bn: "123456782" });
  assert.equal(formatTaxIds(ids), "BN 123456782 · GST/HST 123456782RT0001");
  assert.equal(payerTaxIdentifier(ids), "123456782");
  assert.equal(payerTaxIdentifier({ us_ein: "12-3456789", tax_id: "X" }), "12-3456789");
  assert.equal(payerTaxIdentifier({}), null);
});
