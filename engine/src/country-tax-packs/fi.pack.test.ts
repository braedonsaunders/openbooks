import assert from "node:assert/strict";
import test from "node:test";
import {
  packReturnCodesWithTaxCodes,
  packTaxCodesForReturn,
  primaryPackTaxCode,
} from "./index.ts";
import { FINLAND_TAX_PACK } from "./fi.ts";
import type { EffectiveTaxRate } from "./types.ts";

const pack = FINLAND_TAX_PACK;

function assertContiguous(rates: readonly EffectiveTaxRate[], code: string): void {
  assert.ok(rates.length > 0, `${code} needs an effective-dated schedule`);
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1]!;
    const current = rates[index]!;
    assert.ok(prior.effectiveTo, `${code}: rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10), `${code} schedule has a gap or overlap`);
  }
  assert.equal(rates.at(-1)!.effectiveTo, undefined, `${code} must end open`);
}

test("Finland declares the OmaVero ALV return as its single monthly filing", () => {
  assert.equal(pack.country, "FI");
  assert.equal(pack.code, "FI_INDIRECT_TAX");
  assert.equal(pack.version, "2026.08.01");
  assert.equal(pack.countryTaxType, "vat");
  assert.equal(pack.parentReturnPackCode, "FI_ALV");
  assert.equal(pack.returnPacks.length, 1);
  assert.deepEqual(pack.jurisdictions, []);
  const ret = pack.returnPacks[0]!;
  assert.equal(ret.code, "FI_ALV");
  assert.equal(ret.defaultFrequency, "monthly");
  assert.equal(ret.submissionChannel, "portal_manual");
  assert.equal(ret.governmentFormat, "portal_entry");
  assert.equal(
    ret.submissionUrl,
    "https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/when-to-file-and-pay/",
  );
});

test("ALV boxes carry the real VSRALVKV field codes plus the ledger workpapers", () => {
  const ret = pack.returnPacks[0]!;
  assert.deepEqual(
    ret.boxes.map((box) => box.lineCode),
    ["301", "302", "303", "305", "306", "307", "308", "OB_OUTPUT", "OB_INPUT"],
  );
  const payable = ret.boxes.find((box) => box.lineCode === "308")!;
  assert.equal(payable.formula, "301 + 302 + 303 + 305 + 306 - 307");
  const output = ret.boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  const input = ret.boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("every rate cites a declared source and every schedule is contiguous and current", () => {
  const knownSources = new Set(pack.sources.map((source) => source.id));
  assert.deepEqual(packReturnCodesWithTaxCodes(pack), ["FI_ALV"]);
  const codes = packTaxCodesForReturn(pack, "FI_ALV");
  assert.equal(new Set(codes.map((definition) => definition.code)).size, codes.length);
  for (const definition of codes) {
    const rates = definition.rates ?? [];
    for (const rate of rates) {
      assert.ok(knownSources.has(rate.sourceId), `${definition.code} cites unknown source ${rate.sourceId}`);
    }
    assertContiguous(rates, definition.code);
    assert.equal(definition.ratePercent, rates.at(-1)!.ratePercent, `${definition.code} headline rate is stale`);
  }
});

test("the primary code is the standard band and the post-2026 bands are current", () => {
  const primary = primaryPackTaxCode(pack, "FI_ALV");
  assert.equal(primary?.code, "FI-VAT-STD");
  assert.equal(primary?.role, "standard");
  const byCode = new Map(packTaxCodesForReturn(pack, "FI_ALV").map((definition) => [definition.code, definition] as const));
  assert.equal(byCode.get("FI-VAT-STD")?.ratePercent, 25.5);
  assert.equal(byCode.get("FI-VAT-RED135")?.ratePercent, 13.5);
  assert.equal(byCode.get("FI-VAT-RED135")?.role, "reduced");
  assert.equal(byCode.get("FI-VAT-RED10")?.ratePercent, 10);
  assert.equal(byCode.get("FI-VAT-RED10")?.role, "reduced");
  assert.equal(byCode.get("FI-VAT-ZERO")?.ratePercent, 0);
  assert.equal(byCode.get("FI-VAT-ZERO")?.role, "zero");
});

test("Finland evidence stays on vero.fi hosts with well-formed metadata", () => {
  assert.ok(pack.sources.length > 0);
  for (const source of pack.sources) {
    assert.ok(new URL(source.url).hostname.endsWith("vero.fi"), `${source.id} is not a vero.fi source`);
    assert.match(source.asOf, /^\d{4}-\d{2}-\d{2}$/);
  }
});
