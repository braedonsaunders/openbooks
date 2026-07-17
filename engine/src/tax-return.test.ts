import assert from "node:assert/strict";
import test from "node:test";
import { assembleReturn, evalFormula, TaxReturnError, type TaxReturnBoxDef } from "./tax-return.ts";

const codes = (...c: string[]) => new Set(c);

test("evalFormula treats numeric line codes as box references, not literals", () => {
  const values = new Map([["105", "13000.0000"], ["108", "4000.0000"]]);
  assert.equal(evalFormula("105 - 108", values, codes("105", "108")), "9000.0000");
});

test("evalFormula handles parentheses, unary minus, and true numeric literals", () => {
  const values = new Map([["105", "9000.0000"], ["108", "4000.0000"]]);
  assert.equal(evalFormula("(105 - 108) + 100", values, codes("105", "108")), "5100.0000");
  assert.equal(evalFormula("-105", values, codes("105")), "-9000.0000");
  // 200 is not a box code → a literal
  assert.equal(evalFormula("108 + 200", values, codes("105", "108")), "4200.0000");
});

test("evalFormula rejects unsupported operators and unknown boxes", () => {
  assert.throws(() => evalFormula("105 * 2", new Map(), codes("105")), TaxReturnError);
  assert.throws(() => evalFormula("105 - 108", new Map([["105", "1.0000"]]), codes("105", "108")), /not-yet-computed box "108"/);
  assert.throws(() => evalFormula("105 +", new Map([["105", "1.0000"]]), codes("105")), TaxReturnError);
});

// A realistic GST34: 101 sales, 103 GST/HST collected (a credit in the ledger,
// sign -1 → positive on the return), 106 ITCs (a debit, sign +1), then computed
// totals: 105 = 103, 108 = 106, net tax 109 = 105 - 108.
const GST34: TaxReturnBoxDef[] = [
  { lineCode: "101", label: "Sales", sign: 1, sequence: 1, formula: null },
  { lineCode: "103", label: "GST/HST collected", sign: -1, sequence: 2, formula: null },
  { lineCode: "106", label: "Input tax credits", sign: 1, sequence: 3, formula: null },
  { lineCode: "105", label: "Total GST/HST", sign: 1, sequence: 4, formula: "103" },
  { lineCode: "108", label: "Total ITCs", sign: 1, sequence: 5, formula: "106" },
  { lineCode: "109", label: "Net tax", sign: 1, sequence: 6, formula: "105 - 108" },
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
    { lineCode: "109", label: "Net", sign: 1, sequence: 1, formula: "105" },
    { lineCode: "105", label: "Total", sign: 1, sequence: 2, formula: null },
  ];
  assert.throws(() => assembleReturn(bad, new Map([["105", "1.0000"]])), /not-yet-computed box "105"/);
});

test("a GL-mapped box with no ledger activity is zero, not missing", () => {
  const boxes = assembleReturn(GST34, new Map([["103", "-5000.0000"]]));
  assert.equal(boxes.find((b) => b.lineCode === "101")!.value, "0.0000");
  assert.equal(boxes.find((b) => b.lineCode === "109")!.value, "5000.0000");
});
