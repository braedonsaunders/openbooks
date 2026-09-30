import assert from "node:assert/strict";
import { test } from "node:test";
import { syntheticRoles } from "./role-bindings.ts";
import { SALES_TAX_CASES } from "./cases/sales-tax.ts";

// Independent published-rule expectation: changing the corpus expected values
// together with its inputs must not turn GST-inclusive QST into a green claim.
// Source: https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/collecting-gst-and-qst/calculating-the-taxes/
test("Québec conformance uses the selling price for both GST and QST", async () => {
  const cases = SALES_TAX_CASES.filter((kase) => kase.citations.some((citation) => citation.standard === "RQ QST"));
  assert.equal(cases.length, 1, "the QST rule must remain represented in the conformance corpus");
  const kase = cases[0]!;
  assert.equal(kase.support, "supported");
  assert.equal(kase.tier, "computation");
  assert.ok(kase.run, "QST conformance must execute the product calculator");
  const expected = { net: "100.0000", gst: "5.0000", qstBase: "100.0000", qst: "9.9800", total: "114.9800" };
  assert.deepEqual(kase.expected.values, expected, "published QST oracle must exclude GST from its base");
  const actual = await kase.run({ roles: syntheticRoles() });
  assert.deepEqual(actual.values, expected, "product calculation must match the independently transcribed QST rule");
  assert.ok(kase.citations.some((citation) => citation.reference.includes("https://www.revenuquebec.ca/")), "publish the primary source with the claim");
});

// Ordinary goods quotation uses the maintained schedules and the same rounded
// component calculator as document posting, including QST's GST-exclusive base.
test("native Canadian goods quotes retain dated provincial tax and refuse ambiguous input", async () => {
  const { quoteGoodsPlaceOfSupply, PlaceOfSupplyError } = await import('../tax/place-of-supply.ts');
  const input = { taxableAmount: '100.00', quotedOn: '2026-08-01', country: 'CA', deliveryProvince: 'QC', basis: 'ordinary_taxable_goods_sale' } as const;
  const quote = quoteGoodsPlaceOfSupply(input);
  assert.deepEqual(quote.components.map((row) => row.taxAmount), ['5.0000', '9.9800']);
  assert.equal(quote.taxAmount, '14.9800');
  assert.equal(quoteGoodsPlaceOfSupply({ ...input, deliveryProvince: 'NS', quotedOn: '2025-03-31' }).taxAmount, '15.0000');
  assert.equal(quoteGoodsPlaceOfSupply({ ...input, deliveryProvince: 'NS', quotedOn: '2025-04-01' }).taxAmount, '14.0000');
  assert.throws(() => quoteGoodsPlaceOfSupply({ ...input, taxableAmount: '100,00' }), PlaceOfSupplyError);
});
