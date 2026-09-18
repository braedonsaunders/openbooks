import assert from "node:assert/strict";
import test from "node:test";
import { PACK_DEFAULT_CODES } from "../tax-pack-provisioning.ts";
import { packTaxCodesForReturn } from "./index.ts";
import { IRELAND_TAX_PACK } from "./ie.ts";
import type { EffectiveTaxRate } from "./types.ts";

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

test("IE_VAT3 carries standard, reduced and second-reduced codes from Revenue history", () => {
  const codes = packTaxCodesForReturn(IRELAND_TAX_PACK, "IE_VAT3");
  assert.deepEqual(codes.map((code) => code.code), ["IE-VAT-STD", "IE-VAT-RED", "IE-VAT-RED2"]);
  assert.deepEqual(codes.map((code) => code.role), ["standard", "reduced", "reduced"]);
  const seen = new Set(codes.map((code) => code.code));
  assert.equal(seen.size, codes.length, "codes must be unique within the return");
  const sourceIds = new Set(IRELAND_TAX_PACK.sources.map((source) => source.id));
  for (const code of codes) {
    assert.ok(code.rates?.length, `${code.code} must declare a rate schedule`);
    for (const rate of code.rates!) {
      assert.ok(sourceIds.has(rate.sourceId), `${code.code} rate cites unknown source ${rate.sourceId}`);
    }
  }
});

test("IE reduced band transcribes the full Revenue reduced-rate column", () => {
  const codes = packTaxCodesForReturn(IRELAND_TAX_PACK, "IE_VAT3");
  const reduced = codes.find((code) => code.code === "IE-VAT-RED")!;
  assert.ok(reduced, "missing IE-VAT-RED");
  assert.equal(reduced.ratePercent, 13.5);
  assert.deepEqual(
    reduced.rates!.map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]),
    [
      ["1972-11-01", "1973-09-02", 5.26],
      ["1973-09-03", "1976-02-29", 6.75],
      ["1976-03-01", "1981-08-31", 10],
      ["1981-09-01", "1982-04-30", 15],
      ["1982-05-01", "1983-02-28", 18],
      ["1983-03-01", "1985-02-28", 23],
      ["1985-03-01", "1991-02-28", 10],
      ["1991-03-01", "1992-02-29", 12.5],
      ["1992-03-01", "1993-02-28", 16],
      ["1993-03-01", "2002-12-31", 12.5],
      ["2003-01-01", null, 13.5],
    ],
  );
  assertContiguous(reduced.rates!);
});

test("IE second-reduced band covers only single-value eras and refuses the 1983-1985 multi-band", () => {
  const codes = packTaxCodesForReturn(IRELAND_TAX_PACK, "IE_VAT3");
  const second = codes.find((code) => code.code === "IE-VAT-RED2")!;
  assert.ok(second, "missing IE-VAT-RED2");
  assert.equal(second.ratePercent, 9);
  assert.deepEqual(
    second.rates!.map((rate) => [rate.effectiveFrom, rate.effectiveTo ?? null, rate.ratePercent]),
    [
      ["1988-03-01", "1990-02-28", 5],
      ["1992-03-01", "1993-02-28", 12.5],
      ["2011-07-01", null, 9],
    ],
  );
});

test("IE_VAT3 default stays the standard code", () => {
  const headline = PACK_DEFAULT_CODES.IE_VAT3;
  assert.ok(headline, "missing IE_VAT3 default");
  assert.equal(headline.code, "IE-VAT-STD");
  assert.equal(headline.ratePercent, 23);
  assert.equal(headline.rates?.length, 17);
});
