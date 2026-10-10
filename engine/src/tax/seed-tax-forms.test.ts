import assert from "node:assert/strict";
import test from "node:test";
import { assembleReturn, type TaxReturnBoxDef } from "../tax-returns/return.ts";
import { TAX_RETURN_PACKS, taxRegistrationFormProblem } from "./seed-tax-forms.ts";

function defs(code: string): TaxReturnBoxDef[] {
  const pack = TAX_RETURN_PACKS.find((candidate) => candidate.code === code);
  assert.ok(pack);
  return pack.boxes.map((box) => ({
    lineCode: box.lineCode,
    label: box.label,
    sign: box.sign,
    sequence: box.sequence,
    formula: box.formula ?? null,
    editable: !box.formula && !box.glMap,
    pdfField: null,
  }));
}

test("every tax return library pack has unique, evaluable box definitions", () => {
  assert.equal(new Set(TAX_RETURN_PACKS.map((pack) => pack.code)).size, TAX_RETURN_PACKS.length);
  for (const pack of TAX_RETURN_PACKS) {
    assert.equal(new Set(pack.boxes.map((box) => box.lineCode)).size, pack.boxes.length, pack.code);
    assert.doesNotThrow(() => assembleReturn(defs(pack.code), new Map()), pack.code);
  }
});

test("Canada GST34 library pack balances collected tax, adjustments and ITCs", () => {
  const result = assembleReturn(
    defs("CA_GST34"),
    new Map([["101", "100000.0000"], ["103", "-13000.0000"], ["106", "4000.0000"]]),
    new Map([["104", "500.0000"], ["107", "200.0000"]]),
  );
  const value = (code: string) => result.find((box) => box.lineCode === code)?.value;
  assert.equal(value("101"), "100000.0000");
  assert.equal(value("109"), "9300.0000");
  assert.equal(value("113A"), "9300.0000");
  assert.equal(value("113C"), "9300.0000");
  assert.equal(value("115"), "9300.0000");
});

test("UK and New Zealand packs report unsigned payable-or-refund differences", () => {
  const uk = assembleReturn(defs("GB_VAT100"), new Map([["1", "-2000.0000"], ["4", "2750.0000"]]));
  assert.equal(uk.find((box) => box.lineCode === "5")?.value, "750.0000");

  const nz = assembleReturn(defs("NZ_GST101A"), new Map([["8", "-1200.0000"], ["12", "1800.0000"]]));
  assert.equal(nz.find((box) => box.lineCode === "15")?.value, "600.0000");
});

test("Australia BAS maps ledger tax while preserving filer-entered reporting labels", () => {
  const result = assembleReturn(
    defs("AU_BAS_GST"),
    new Map([["1A", "-1100.0000"], ["1B", "450.0000"]]),
    new Map([["G1", "12100.0000"], ["G10", "3300.0000"]]),
  );
  const value = (code: string) => result.find((box) => box.lineCode === code)?.value;
  assert.equal(value("G1"), "12100.0000");
  assert.equal(value("G10"), "3300.0000");
  assert.equal(value("1A"), "1100.0000");
  assert.equal(value("1B"), "450.0000");
});

test("Washington combined return totals B&O, state, local, and use tax less the small business credit", () => {
  const pack = TAX_RETURN_PACKS.find((candidate) => candidate.code === "US_WA_CET");
  assert.ok(pack);
  assert.equal(pack.jurisdiction.code, "US-WA");
  const empty = assembleReturn(defs("US_WA_CET"), new Map(), new Map());
  assert.equal(empty.find((box) => box.lineCode === "TOTAL_DUE")?.value, "0.0000");
  const result = assembleReturn(
    defs("US_WA_CET"),
    new Map([["WA_GROSS", "20000.0000"], ["WA_TAX", "-737.1000"]]),
    new Map([
      ["ST_TAX", "650.0000"],
      ["USE_TAX", "0.0000"],
      ["LOCAL_TAX", "40.0000"],
      ["BO_RET", "47.1000"],
      ["BO_WHO", "0.0000"],
      ["BO_MFG", "0.0000"],
      ["BO_SVC", "0.0000"],
      ["BO_SVC1M", "0.0000"],
      ["BO_SVC5M", "0.0000"],
      ["SBC_CREDIT", "10.0000"],
    ]),
  );
  assert.equal(result.find((box) => box.lineCode === "TOTAL_DUE")?.value, "727.1000");
});

test("a Washington registration files the Washington return, not the national workpaper", () => {
  assert.equal(
    taxRegistrationFormProblem({
      registrationLabel: "WA Excise",
      registrationJurisdictionCode: "US-WA",
      formCode: "US_WA_CET",
    }),
    null,
  );
  assert.match(
    taxRegistrationFormProblem({
      registrationLabel: "WA Excise",
      registrationJurisdictionCode: "US-WA",
      formCode: "US_SALES_TAX_WORKPAPER",
    }) ?? "",
    /US-WA.*US_SALES_TAX_WORKPAPER.*choose a form for "US-WA"/,
  );
  assert.equal(
    taxRegistrationFormProblem({
      registrationLabel: "CA Seller",
      registrationJurisdictionCode: "US-CA",
      formCode: "US_CA_CDTFA401",
    }),
    null,
  );
});

test("United States pack is an adaptable workpaper, not a fake federal return", () => {
  const pack = TAX_RETURN_PACKS.find((candidate) => candidate.code === "US_SALES_TAX_WORKPAPER");
  assert.ok(pack);
  assert.match(pack.name, /Workpaper/);
  assert.match(pack.watermark, /Not a government return/);
  const result = assembleReturn(
    defs(pack.code),
    new Map([["TAXABLE_SALES", "20000.0000"], ["TAX_COLLECTED", "-1650.0000"]]),
    new Map([["ADJUSTMENTS", "25.0000"]]),
  );
  assert.equal(result.find((box) => box.lineCode === "TAX_DUE")?.value, "1675.0000");
});
