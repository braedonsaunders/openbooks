import assert from "node:assert/strict";
import test from "node:test";
import { CANADA_RETURN_PACKS } from "./country-tax-packs/ca-returns.ts";
import { assembleReturn, evalFormula, planReturn, TaxReturnError, type TaxReturnBoxDef, type TaxReportLineRow } from "./tax-return.ts";

const codes = (...c: string[]) => new Set(c);

test("evalFormula treats numeric line codes as box references, not literals", () => {
  const values = new Map([["105", "13000.0000"], ["108", "4000.0000"]]);
  assert.equal(evalFormula("105 - 108", values, codes("105", "108")), "9000.0000");
});

test("evalFormula keeps digit-leading alphanumeric box codes whole (5a, 4C, 3.1A)", () => {
  const values = new Map([["5a", "2100.0000"], ["5b", "800.0000"], ["4A5", "300.0000"], ["4C", "300.0000"], ["OUT", "500.0000"]]);
  const boxes = codes("5a", "5b", "4A5", "4C", "OUT");
  assert.equal(evalFormula("5a - 5b", values, boxes), "1300.0000");
  assert.equal(evalFormula("4A5", values, boxes), "300.0000");
  assert.equal(evalFormula("OUT - 4C", values, boxes), "200.0000");
});

test("evalFormula handles parentheses, unary minus, and true numeric literals", () => {
  const values = new Map([["105", "9000.0000"], ["108", "4000.0000"]]);
  assert.equal(evalFormula("(105 - 108) + 100", values, codes("105", "108")), "5100.0000");
  assert.equal(evalFormula("-105", values, codes("105")), "-9000.0000");
  // 200 is not a box code → a literal
  assert.equal(evalFormula("108 + 200", values, codes("105", "108")), "4200.0000");
  assert.equal(evalFormula("abs(108 - 105)", values, codes("105", "108")), "5000.0000");
  assert.equal(evalFormula("max(105, 108)", values, codes("105", "108")), "9000.0000");
  assert.equal(evalFormula("max(-105, 108)", values, codes("105", "108")), "4000.0000");
  assert.equal(evalFormula("max(0, 0)", values, codes("105", "108")), "0.0000");
});

test("evalFormula rejects unsupported operators and unknown boxes", () => {
  assert.throws(() => evalFormula("105 * 2", new Map(), codes("105")), TaxReturnError);
  assert.throws(() => evalFormula("105 - 108", new Map([["105", "1.0000"]]), codes("105", "108")), /not-yet-computed box "108"/);
  assert.throws(() => evalFormula("105 +", new Map([["105", "1.0000"]]), codes("105")), TaxReturnError);
  assert.throws(() => evalFormula("abs 105", new Map([["105", "1.0000"]]), codes("105")), TaxReturnError);
  assert.throws(() => evalFormula("max(105)", new Map([["105", "1.0000"]]), codes("105")), TaxReturnError);
});

// A realistic GST34: 101 sales, 103 GST/HST collected (a credit in the ledger,
// sign -1 → positive on the return), 106 ITCs (a debit, sign +1), then computed
// totals: 105 = 103, 108 = 106, net tax 109 = 105 - 108.
const GST34: TaxReturnBoxDef[] = [
  { lineCode: "101", label: "Sales", sign: 1, sequence: 1, formula: null, editable: false, pdfField: null },
  { lineCode: "103", label: "GST/HST collected", sign: -1, sequence: 2, formula: null, editable: false, pdfField: null },
  { lineCode: "106", label: "Input tax credits", sign: 1, sequence: 3, formula: null, editable: false, pdfField: null },
  { lineCode: "105", label: "Total GST/HST", sign: 1, sequence: 4, formula: "103", editable: false, pdfField: null },
  { lineCode: "108", label: "Total ITCs", sign: 1, sequence: 5, formula: "106", editable: false, pdfField: null },
  { lineCode: "109", label: "Net tax", sign: 1, sequence: 6, formula: "105 - 108", editable: false, pdfField: null },
];

test("assembleReturn computes a GST34 with sign flips and derived totals", () => {
  const gl = new Map([
    ["101", "100000.0000"], // sales base (debit-side base already positive)
    ["103", "-13000.0000"], // collected tax posts as a credit (negative)
    ["106", "4000.0000"], // ITCs post as a debit (positive)
  ]);
  const boxes = assembleReturn(GST34, gl);
  const v = (code: string) => boxes.find((b) => b.lineCode === code)!.value;
  assert.equal(v("101"), "100000.0000");
  assert.equal(v("103"), "13000.0000"); // sign -1 flips the credit to positive
  assert.equal(v("106"), "4000.0000");
  assert.equal(v("105"), "13000.0000"); // = 103
  assert.equal(v("108"), "4000.0000"); // = 106
  assert.equal(v("109"), "9000.0000"); // net tax owed = 13000 - 4000
});

test("GST34 puts a positive balance in payment or refund, never both", () => {
  const pack = CANADA_RETURN_PACKS.find((candidate) => candidate.code === "CA_GST34");
  assert.ok(pack);
  const defs: TaxReturnBoxDef[] = pack.boxes.map((box) => ({
    lineCode: box.lineCode,
    label: box.label,
    sign: box.sign,
    sequence: box.sequence,
    formula: box.formula ?? null,
    editable: !box.formula && !box.glMap,
    pdfField: null,
  }));
  const values = (raw: Map<string, string>) => {
    const result = assembleReturn(defs, raw);
    return (code: string) => result.find((box) => box.lineCode === code)!.value;
  };

  // Collected tax exceeds ITCs: the balance is payable in line 115 only.
  const payable = values(new Map([["103", "-13000.0000"], ["106", "4000.0000"]]));
  assert.equal(payable("113C"), "9000.0000");
  assert.equal(payable("114"), "0.0000");
  assert.equal(payable("115"), "9000.0000");

  // ITCs exceed collected tax: the balance is refundable in line 114 only.
  const refund = values(new Map([["103", "-4000.0000"], ["106", "13000.0000"]]));
  assert.equal(refund("113C"), "-9000.0000");
  assert.equal(refund("114"), "9000.0000");
  assert.equal(refund("115"), "0.0000");

  // A balanced return leaves both terminal boxes empty.
  const balanced = values(new Map([["103", "-4000.0000"], ["106", "4000.0000"]]));
  assert.equal(balanced("113C"), "0.0000");
  assert.equal(balanced("114"), "0.0000");
  assert.equal(balanced("115"), "0.0000");
});

test("assembleReturn marks computed vs GL-mapped boxes and preserves order", () => {
  const boxes = assembleReturn(GST34, new Map());
  assert.deepEqual(boxes.map((b) => b.lineCode), ["101", "103", "106", "105", "108", "109"]);
  assert.deepEqual(
    boxes.filter((b) => b.computed).map((b) => b.lineCode),
    ["105", "108", "109"],
  );
});

test("assembleReturn evaluates strictly in sequence order (a forward reference throws)", () => {
  // 109 references 105 but is sequenced BEFORE it → not-yet-computed.
  const bad: TaxReturnBoxDef[] = [
    { lineCode: "109", label: "Net", sign: 1, sequence: 1, formula: "105", editable: false, pdfField: null },
    { lineCode: "105", label: "Total", sign: 1, sequence: 2, formula: null, editable: false, pdfField: null },
  ];
  assert.throws(() => assembleReturn(bad, new Map([["105", "1.0000"]])), /not-yet-computed box "105"/);
});

// A GST34 with adjustment boxes (104 add / 107 deduct) feeding the totals.
const GST34_ADJ: TaxReturnBoxDef[] = [
  { lineCode: "103", label: "GST/HST collected", sign: -1, sequence: 20, formula: null, editable: false, pdfField: null },
  { lineCode: "104", label: "Adjustments (add)", sign: 1, sequence: 30, formula: null, editable: true, pdfField: null },
  { lineCode: "105", label: "Total GST/HST", sign: 1, sequence: 40, formula: "103 + 104", editable: false, pdfField: null },
  { lineCode: "106", label: "ITCs", sign: 1, sequence: 50, formula: null, editable: false, pdfField: null },
  { lineCode: "107", label: "Adjustments (deduct)", sign: 1, sequence: 60, formula: null, editable: true, pdfField: null },
  { lineCode: "108", label: "Total ITCs", sign: 1, sequence: 70, formula: "106 + 107", editable: false, pdfField: null },
  { lineCode: "109", label: "Net tax", sign: 1, sequence: 80, formula: "105 - 108", editable: false, pdfField: null },
];

test("adjustment boxes take the filer's amount and flow into the totals", () => {
  const gl = new Map([["103", "-13000.0000"], ["106", "4000.0000"]])
  const adj = new Map([["104", "500.0000"], ["107", "200.0000"]])
  const boxes = assembleReturn(GST34_ADJ, gl, adj)
  const v = (c: string) => boxes.find((b) => b.lineCode === c)!.value
  assert.equal(v("104"), "500.0000") // entered as displayed, no sign flip
  assert.equal(v("105"), "13500.0000") // 13000 + 500
  assert.equal(v("108"), "4200.0000") // 4000 + 200
  assert.equal(v("109"), "9300.0000") // 13500 - 4200
  assert.equal(boxes.find((b) => b.lineCode === "104")!.editable, true)
})

test("an omitted adjustment defaults to zero", () => {
  const boxes = assembleReturn(GST34_ADJ, new Map([["103", "-13000.0000"], ["106", "4000.0000"]]))
  assert.equal(boxes.find((b) => b.lineCode === "104")!.value, "0.0000")
  assert.equal(boxes.find((b) => b.lineCode === "109")!.value, "9000.0000")
})

test("planReturn marks manual boxes (no formula, no GL source) editable", () => {
  const rows: TaxReportLineRow[] = [
    { lineCode: "103", label: "Collected", sign: -1, sequence: 20, taxCodeId: "gst", basis: "tax_collected", formula: null },
    { lineCode: "104", label: "Adjustments", sign: 1, sequence: 30, taxCodeId: null, basis: null, formula: null },
    { lineCode: "105", label: "Total", sign: 1, sequence: 40, taxCodeId: null, basis: null, formula: "103 + 104" },
  ]
  const { boxes } = planReturn(rows)
  const byCode = new Map(boxes.map((b) => [b.lineCode, b]))
  assert.equal(byCode.get("104")!.editable, true) // manual → editable
  assert.equal(byCode.get("103")!.editable, false) // GL-mapped
  assert.equal(byCode.get("105")!.editable, false) // computed
})

test("planReturn collapses multi-code boxes and collects every GL source", () => {
  // Line 103 (GST/HST collected) sums two tax codes; 105 is computed.
  const rows: TaxReportLineRow[] = [
    { lineCode: "103", label: "GST/HST collected", sign: -1, sequence: 5, taxCodeId: "gst", basis: "tax_amount", formula: null },
    { lineCode: "103", label: "GST/HST collected", sign: -1, sequence: 2, taxCodeId: "hst-on", basis: "tax_amount", formula: null },
    { lineCode: "105", label: "Total", sign: 1, sequence: 6, taxCodeId: null, basis: null, formula: "103" },
  ];
  const { boxes, glSources } = planReturn(rows);
  // One box per line code; 103 takes the earliest sequence.
  assert.deepEqual(boxes.map((b) => b.lineCode).sort(), ["103", "105"]);
  assert.equal(boxes.find((b) => b.lineCode === "103")!.sequence, 2);
  // Both tax codes feed line 103; the computed box is not a GL source.
  assert.deepEqual(
    glSources.filter((s) => s.lineCode === "103").map((s) => s.taxCodeId).sort(),
    ["gst", "hst-on"],
  );
  assert.equal(glSources.length, 2);
});

test("a GL-mapped box with no ledger activity is zero, not missing", () => {
  const boxes = assembleReturn(GST34, new Map([["103", "-5000.0000"]]));
  assert.equal(boxes.find((b) => b.lineCode === "101")!.value, "0.0000");
  assert.equal(boxes.find((b) => b.lineCode === "109")!.value, "5000.0000");
});
