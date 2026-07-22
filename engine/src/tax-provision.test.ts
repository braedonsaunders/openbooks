import assert from "node:assert/strict";
import test from "node:test";
import { PACK_DEFAULT_CODES, supportedTaxCountries } from "./tax-provision.ts";
import { TAX_RETURN_PACKS } from "./seed-tax-forms.ts";

test("every pack has a default tax code", () => {
  for (const pack of TAX_RETURN_PACKS) {
    assert.ok(PACK_DEFAULT_CODES[pack.code], `missing default code for ${pack.code}`);
  }
});

test("default tax codes are unique across packs", () => {
  const codes = Object.values(PACK_DEFAULT_CODES).map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
});

test("US groups the sales-tax workpaper as its country pack and states as subs", () => {
  const countries = supportedTaxCountries();
  const us = countries.find((c) => c.country === "US");
  assert.ok(us);
  assert.equal(us.countryPack, "US_SALES_TAX_WORKPAPER");
  const subPacks = us.subs.map((s) => s.packCode).sort();
  assert.deepEqual(subPacks, ["US_CA_CDTFA401", "US_FL_DR15", "US_NY_ST100", "US_TX_01114"]);
})

test("Canada exposes the federal GST34 plus provincial PST/QST returns as subs", () => {
  const countries = supportedTaxCountries();
  const ca = countries.find((c) => c.country === "CA");
  assert.ok(ca);
  assert.equal(ca.countryPack, "CA_GST34"); // federal GST/HST → CRA
  assert.equal(ca.name, "Canada");
  const subPacks = ca.subs.map((s) => s.packCode).sort();
  // BC/SK/MB provincial sales tax + Quebec QST remit to the province, not the CRA.
  assert.deepEqual(subPacks, ["CA_BC_PST", "CA_MB_RST", "CA_QC_QST", "CA_SK_PST"]);
});

test("truly single-jurisdiction countries expose a country pack and no subs", () => {
  const gb = supportedTaxCountries().find((c) => c.country === "GB");
  assert.ok(gb);
  assert.equal(gb.countryPack, "GB_VAT100");
  assert.equal(gb.subs.length, 0);
});
