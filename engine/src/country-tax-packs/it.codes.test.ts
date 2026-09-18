import assert from "node:assert/strict";
import test from "node:test";
// NOTE: PACK_DEFAULT_CODES (in ../tax-pack-provisioning.ts) derives its
// per-return entry from primaryPackTaxCode, so asserting the primary here
// proves the default stays STD without pulling drizzle/db into this test.
import { packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { ITALY_TAX_PACK } from "./it.ts";

const SOURCE_ID = "ade_vat_rates_applicability_2026";

test("IT_LIPE declares standard plus 10% ridotta and 4% minima codes", () => {
  const codes = packTaxCodesForReturn(ITALY_TAX_PACK, "IT_LIPE");
  assert.equal(codes.length, 3);
  assert.deepEqual(
    codes.map((code) => code.code),
    ["IT-VAT-STD", "IT-VAT-RED10", "IT-VAT-RED4"],
  );
  assert.deepEqual(
    codes.map((code) => code.role ?? "standard"),
    ["standard", "reduced", "reduced"],
  );
  assert.deepEqual(
    codes.map((code) => code.ratePercent),
    [22, 10, 4],
  );
});

test("new IT reduced rates link to the AdE applicability source", () => {
  const sources = new Map(ITALY_TAX_PACK.sources.map((source) => [source.id, source]));
  const codes = packTaxCodesForReturn(ITALY_TAX_PACK, "IT_LIPE");
  for (const code of codes.slice(1)) {
    const rates = code.rates ?? [];
    assert.equal(rates.length, 1);
    assert.equal(rates[0]!.ratePercent, code.ratePercent);
    assert.equal(rates[0]!.sourceId, SOURCE_ID);
    const source = sources.get(rates[0]!.sourceId);
    assert.ok(source, `${code.code} sourceId must resolve into sources[]`);
    assert.equal(source.url, "https://www.agenziaentrate.gov.it/portale/web/english/general-vat-rules-and-rates");
    assert.equal(source.asOf, "2026-09-18");
  }
});

test("IT default code stays the 22% standard", () => {
  const primary = primaryPackTaxCode(ITALY_TAX_PACK, "IT_LIPE");
  assert.equal(primary?.code, "IT-VAT-STD");
  assert.equal(primary?.ratePercent, 22);
});
