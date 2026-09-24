import assert from "node:assert/strict";
import test from "node:test";
import { assertPackCodeRateSchedule, packReturnCodesWithTaxCodes, packTaxCodesForReturn } from "./index.ts";
import { VIETNAM_TAX_PACK } from "./vn.ts";
import type { CountryTaxCodeDefinition, EffectiveTaxRate } from "./types.ts";

function codesFor(returnPackCode: string): readonly CountryTaxCodeDefinition[] {
  const codes = packTaxCodesForReturn(VIETNAM_TAX_PACK, returnPackCode);
  assert.ok(codes.length > 0, `no tax codes declared for ${returnPackCode}`);
  return codes;
}

function assertContiguous(rates: readonly EffectiveTaxRate[], code: string): void {
  assert.ok(rates.length > 0, `${code} declares no rates`);
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1]!;
    const current = rates[index]!;
    assert.ok(prior.effectiveTo, `${code}: rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10));
  }
}

test("Vietnam pack is found by country with one monthly 01/GTGT return and the version pin", () => {
  assert.equal(VIETNAM_TAX_PACK.country, "VN");
  assert.equal(VIETNAM_TAX_PACK.code, "VN_INDIRECT_TAX");
  assert.equal(VIETNAM_TAX_PACK.version, "2026.08.01");
  assert.equal(VIETNAM_TAX_PACK.returnPacks.length, 1);
  assert.equal(VIETNAM_TAX_PACK.parentReturnPackCode, "VN_GTGT_01");
  assert.equal(VIETNAM_TAX_PACK.returnPacks[0]!.code, "VN_GTGT_01");
  assert.deepEqual(packReturnCodesWithTaxCodes(VIETNAM_TAX_PACK), ["VN_GTGT_01"]);
});

test("Vietnam 01/GTGT return carries the real chi tieu boxes plus the OB workpaper boxes", () => {
  const boxes = VIETNAM_TAX_PACK.returnPacks[0]!.boxes;
  assert.deepEqual(boxes.map((box) => box.lineCode), [
    "27",
    "28",
    "29",
    "30",
    "31",
    "32",
    "33",
    "25",
    "36",
    "40",
    "PL08-I-05",
    "PL08-I-06",
    "PL08-II-07",
    "PL08-II-08",
    "PL08-III-09",
    "OB_OUTPUT",
    "OB_INPUT",
  ]);
  const output = boxes.find((box) => box.lineCode === "OB_OUTPUT")!;
  const input = boxes.find((box) => box.lineCode === "OB_INPUT")!;
  assert.equal(output.basis, "tax_collected");
  assert.equal(output.glMap, "sales");
  assert.equal(input.basis, "tax_paid");
  assert.equal(input.glMap, "purchases");
});

test("Vietnam files monthly through the e-tax portal, not a quarterly return", () => {
  const returnPack = VIETNAM_TAX_PACK.returnPacks[0]!;
  assert.equal(returnPack.defaultFrequency, "monthly");
  assert.equal(returnPack.submissionChannel, "portal_manual");
  assert.equal(returnPack.governmentFormat, "portal_entry");
  assert.match(returnPack.submissionUrl, /thuedientu\.gdt\.gov\.vn/);
});

test("every Vietnam sourceId resolves to a sources[] entry", () => {
  const ids = new Set(VIETNAM_TAX_PACK.sources.map((source) => source.id));
  for (const code of codesFor("VN_GTGT_01")) {
    for (const rate of code.rates ?? []) {
      assert.ok(ids.has(rate.sourceId), `${code.code} cites unknown source ${rate.sourceId}`);
    }
  }
});

test("Vietnam declares four rate bands with contiguous source-backed histories", () => {
  const codes = codesFor("VN_GTGT_01");
  assert.deepEqual(
    codes.map((code) => [code.code, code.role, code.ratePercent]),
    [
      ["VN-VAT-STD", "standard", 10],
      ["VN-VAT-RED8", "reduced", 8],
      ["VN-VAT-RED5", "reduced", 5],
      ["VN-VAT-ZERO", "zero", 0],
    ],
  );
  for (const code of codes) {
    assert.ok(code.rates && code.rates.length > 0, `${code.code} must declare rates`);
    assertContiguous(code.rates, code.code);
  }
  const primary = codes.find((code) => code.role === "standard") ?? codes[0]!;
  assert.equal(primary.code, "VN-VAT-STD");
});

test("the temporary 8% band covers the pinned date and carries its published expiry", () => {
  const pinnedToday = "2026-09-18";
  for (const code of codesFor("VN_GTGT_01")) {
    assertPackCodeRateSchedule(`VN_INDIRECT_TAX/VN_GTGT_01/${code.code}`, code, pinnedToday);
  }
  const reduced8 = codesFor("VN_GTGT_01").find((code) => code.code === "VN-VAT-RED8")!;
  assert.equal(reduced8.rates![0]!.effectiveFrom, "2025-07-01");
  assert.equal(reduced8.rates![0]!.effectiveTo, "2026-12-31");
});

test("Vietnam GTGT is national — no subnational jurisdictions declared", () => {
  assert.equal(VIETNAM_TAX_PACK.jurisdictions.length, 0);
});

test("the 8% band routes to the Phu luc III Mau 01 reduction schedule, not only the workpaper", () => {
  // ND 174/2025 Dieu 1 khoan 6: covered businesses file the 8% schedule
  // (Mau 01, Appendix III) with the GTGT return — section I totals [05]/[06]
  // for 8% purchases, section II totals [07]/[08] for 8% sales, [09]=[08]-[06].
  const boxes = new Map(VIETNAM_TAX_PACK.returnPacks[0]!.boxes.map((box) => [box.lineCode, box] as const));
  for (const line of ["PL08-I-05", "PL08-I-06", "PL08-II-07", "PL08-II-08", "PL08-III-09"]) {
    assert.ok(boxes.get(line)?.label.includes("8%"), `${line} must carry the 8% schedule amount`);
  }
  assert.equal(boxes.get("PL08-II-08")!.sign, -1);
});

test("Vietnam 10/5/0 bands run back to 2009 as single open rows, 8% window untouched", () => {
  const codes = codesFor("VN_GTGT_01");
  for (const [code, rate] of [["VN-VAT-STD", 10], ["VN-VAT-RED5", 5], ["VN-VAT-ZERO", 0]] as const) {
    assert.deepEqual(
      codes.find((entry) => entry.code === code)!.rates,
      [{ ratePercent: rate, effectiveFrom: "2009-01-01", sourceId: "tradeportal_law13_2008_rates" }],
    );
  }
  const reduced8 = codes.find((entry) => entry.code === "VN-VAT-RED8")!;
  assert.deepEqual(reduced8.rates, [
    { ratePercent: 8, effectiveFrom: "2025-07-01", effectiveTo: "2026-12-31", sourceId: "congbao_nd174_window" },
  ]);
});
