import assert from "node:assert/strict";
import test from "node:test";
import { isTaxProvisionSelection, PACK_DEFAULT_CODES } from "../tax-pack-provisioning.ts";
import { NETHERLANDS_TAX_PACK } from "./nl.ts";
import { packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";

test("NL_OB carries standard and reduced codes with honest roles", () => {
  const codes = packTaxCodesForReturn(NETHERLANDS_TAX_PACK, "NL_OB");
  assert.deepEqual(codes.map((code) => code.code), ["NL-VAT-STD", "NL-VAT-RED"]);
  assert.deepEqual(codes.map((code) => code.role), ["standard", "reduced"]);
});

test("NL reduced VAT is 6% through 2018 and 9% from 2019-01-01", () => {
  const reduced = packTaxCodesForReturn(NETHERLANDS_TAX_PACK, "NL_OB").find((code) => code.code === "NL-VAT-RED");
  assert.ok(reduced);
  assert.equal(reduced.ratePercent, 9);
  assert.deepEqual(reduced.rates, [
    { ratePercent: 6, effectiveFrom: "2005-01-01", effectiveTo: "2018-12-31", sourceId: "wet_ob_1968_article_9_reduced_6" },
    { ratePercent: 9, effectiveFrom: "2019-01-01", sourceId: "netherlands_vat_reduced_9_2019" },
  ]);
});

test("NL reduced-rate sources are official Dutch publications", () => {
  const six = NETHERLANDS_TAX_PACK.sources.find((entry) => entry.id === "wet_ob_1968_article_9_reduced_6");
  assert.ok(six);
  assert.match(six.url, /^https:\/\/wetten\.overheid\.nl\/BWBR0002629\//);
  const nine = NETHERLANDS_TAX_PACK.sources.find((entry) => entry.id === "netherlands_vat_reduced_9_2019");
  assert.ok(nine);
  assert.equal(nine.url, "https://zoek.officielebekendmakingen.nl/stb-2018-504.html");
  for (const source of [six, nine]) assert.equal(source.asOf, "2026-09-18");
});

test("NL default code stays the standard rate", () => {
  assert.equal(primaryPackTaxCode(NETHERLANDS_TAX_PACK, "NL_OB")?.code, "NL-VAT-STD");
  assert.deepEqual(PACK_DEFAULT_CODES.NL_OB?.rates, [
    { ratePercent: 17.5, effectiveFrom: "1992-10-01", effectiveTo: "2000-12-31", sourceId: "netherlands_standard_rate_history" },
    { ratePercent: 19, effectiveFrom: "2001-01-01", effectiveTo: "2012-09-30", sourceId: "netherlands_standard_rate_history" },
    { ratePercent: 21, effectiveFrom: "2012-10-01", sourceId: "netherlands_vat_21_2012" },
  ]);
  assert.ok(isTaxProvisionSelection("NL_OB"));
});
