import assert from "node:assert/strict";
import { test } from "node:test";
import { syntheticRoles } from "./role-bindings.ts";
import { syntheticRoles } from "./roles.ts";
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
