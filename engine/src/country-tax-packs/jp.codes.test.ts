import assert from "node:assert/strict";
import test from "node:test";
import { packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import { JAPAN_TAX_PACK } from "./jp.ts";
import { PACK_DEFAULT_CODES } from "../tax-pack-provisioning.ts";

test("Japan declares standard and reduced combined consumption-tax codes on one return", () => {
  const codes = packTaxCodesForReturn(JAPAN_TAX_PACK, "JP_CONSUMPTION");
  assert.equal(codes.length, 2);
  assert.deepEqual(codes.map((code) => code.code), ["JP-CT-STD", "JP-CT-RED"]);
  assert.deepEqual(codes.map((code) => code.role), ["standard", "reduced"]);
  assert.deepEqual(
    codes.map((code) => code.code),
    [...new Set(codes.map((code) => code.code))],
    "codes must be unique within the return",
  );
});

test("Japan standard code preserves the full combined-rate history", () => {
  const codes = packTaxCodesForReturn(JAPAN_TAX_PACK, "JP_CONSUMPTION");
  const standard = codes.find((code) => code.code === "JP-CT-STD");
  assert.ok(standard);
  assert.equal(standard.ratePercent, 10);
  assert.deepEqual(
    (standard.rates ?? []).map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]),
    [
      ["1989-04-01", "1997-03-31", 3],
      ["1997-04-01", "2014-03-31", 5],
      ["2014-04-01", "2019-09-30", 8],
      ["2019-10-01", null, 10],
    ],
  );
});

test("Japan reduced code carries the sourced combined 8% from 2019-10-01", () => {
  const codes = packTaxCodesForReturn(JAPAN_TAX_PACK, "JP_CONSUMPTION");
  const reduced = codes.find((code) => code.code === "JP-CT-RED");
  assert.ok(reduced);
  assert.equal(reduced.ratePercent, 8);
  assert.deepEqual(reduced.rates, [
    { ratePercent: 8, effectiveFrom: "2019-10-01", sourceId: "nta_consumption_tax_reduced" },
  ]);
  const source = JAPAN_TAX_PACK.sources.find((entry) => entry.id === "nta_consumption_tax_reduced");
  assert.ok(source);
  assert.equal(source.url, "https://www.nta.go.jp/english/taxes/consumption_tax/01.htm");
  assert.equal(source.asOf, "2026-09-18");
});

test("every Japan code rate resolves to a declared pack source", () => {
  const sourceIds = new Set(JAPAN_TAX_PACK.sources.map((source) => source.id));
  for (const code of packTaxCodesForReturn(JAPAN_TAX_PACK, "JP_CONSUMPTION")) {
    assert.ok(code.rates?.length, `${code.code} must declare rates`);
    for (const rate of code.rates ?? []) {
      assert.ok(sourceIds.has(rate.sourceId), `${code.code} references unknown source ${rate.sourceId}`);
    }
  }
});

test("Japan headline code stays the standard 10%", () => {
  assert.equal(primaryPackTaxCode(JAPAN_TAX_PACK, "JP_CONSUMPTION")?.code, "JP-CT-STD");
  assert.equal(PACK_DEFAULT_CODES.JP_CONSUMPTION?.code, "JP-CT-STD");
  assert.equal(PACK_DEFAULT_CODES.JP_CONSUMPTION?.ratePercent, 10);
});
