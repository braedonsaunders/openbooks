import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveRequirementPerUnit,
  pairBomRevisionLines,
  type BomRevisionLine,
} from "./bom-lines";

test("the effective requirement is quantity times one plus scrap, computed by the engine", () => {
  assert.equal(
    effectiveRequirementPerUnit({
      quantityPer: "0.893",
      scrapPct: "16",
      quantityBasis: "per_unit",
    }),
    "1.0359",
  );
  assert.equal(
    effectiveRequirementPerUnit({ quantityPer: "2", scrapPct: "0", quantityBasis: "per_unit" }),
    "2.0000",
  );
  assert.equal(
    effectiveRequirementPerUnit({ quantityPer: "2", scrapPct: "", quantityBasis: "per_unit" }),
    "2.0000",
  );
  assert.equal(effectiveRequirementPerUnit({ quantityPer: "2", scrapPct: null }), "2.0000");
});

test("the preview refuses an incomplete or malformed line instead of guessing", () => {
  assert.equal(effectiveRequirementPerUnit({ quantityPer: "", scrapPct: "5" }), null);
  assert.equal(effectiveRequirementPerUnit({ quantityPer: "-1", scrapPct: "5" }), null);
  assert.equal(effectiveRequirementPerUnit({ quantityPer: "1", scrapPct: "abc" }), null);
  assert.equal(effectiveRequirementPerUnit({ quantityPer: "1", scrapPct: "100" }), null);
  assert.equal(effectiveRequirementPerUnit({ quantityPer: "1", scrapPct: "1e3" }), null);
});

test("a formula line previews its requirement per parent unit with its output denominator", () => {
  assert.equal(
    effectiveRequirementPerUnit({
      quantityPer: "5",
      scrapPct: "0",
      quantityBasis: "per_formula",
      formulaOutputQuantity: "10",
    }),
    "0.5000",
  );
  assert.equal(
    effectiveRequirementPerUnit({
      quantityPer: "5",
      quantityBasis: "per_formula",
      formulaOutputQuantity: "0",
    }),
    null,
  );
});

const steel = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const bracket = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const gasket = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function line(componentItemId: string, overrides: BomRevisionLine = {}): BomRevisionLine {
  return {
    componentItemId,
    quantityPer: "1",
    quantityBasis: "per_unit",
    formulaOutputQuantity: "1",
    scrapPct: null,
    operationSeq: null,
    isByproduct: false,
    outputCostWeight: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

test("lines pair by component item and report only the fields that changed", () => {
  const [pair] = pairBomRevisionLines(
    [line(steel, { quantityPer: "16", scrapPct: "0" })],
    [line(steel, { quantityPer: "18", scrapPct: "0" })],
  );
  assert.equal(pair?.kind, "changed");
  assert.deepEqual(pair?.changedFields, ["quantityPer"]);
});

test("an operation or window change is a change to the same component, not a removal and an addition", () => {
  const pairs = pairBomRevisionLines(
    [line(steel, { operationSeq: 10 })],
    [line(steel, { operationSeq: 20 })],
  );
  assert.deepEqual(
    pairs.map((pair) => pair.kind),
    ["changed"],
  );
  assert.deepEqual(pairs[0]?.changedFields, ["operationSeq"]);
});

test("equal quantities and an absent scrap percentage read as unchanged", () => {
  const [pair] = pairBomRevisionLines(
    [line(steel, { quantityPer: "16", scrapPct: null, formulaOutputQuantity: null })],
    [line(steel, { quantityPer: "16.0000", scrapPct: "0.0000", formulaOutputQuantity: "1.0000" })],
  );
  assert.equal(pair?.kind, "unchanged");
  assert.deepEqual(pair?.changedFields, []);
});

test("a repeated component pairs its nth occurrence with the nth occurrence", () => {
  const pairs = pairBomRevisionLines(
    [line(steel, { quantityPer: "1" }), line(steel, { quantityPer: "2" })],
    [line(steel, { quantityPer: "1" }), line(steel, { quantityPer: "5" })],
  );
  assert.deepEqual(
    pairs.map((pair) => pair.kind),
    ["unchanged", "changed"],
  );
  assert.equal(pairs[1]?.before?.quantityPer, "2");
  assert.equal(pairs[1]?.after?.quantityPer, "5");
});

test("added and removed components are retained, with removed lines after the proposed ones", () => {
  const pairs = pairBomRevisionLines([line(steel), line(bracket)], [line(steel), line(gasket)]);
  assert.deepEqual(
    pairs.map((pair) => [pair.componentItemId, pair.kind]),
    [
      [steel, "unchanged"],
      [gasket, "added"],
      [bracket, "removed"],
    ],
  );
});

test("the pairing never mutates the stored lines it reads", () => {
  const before = [line(steel, { quantityPer: "16" })];
  const after = [line(steel, { quantityPer: "18" })];
  pairBomRevisionLines(before, after);
  assert.equal(before[0]?.quantityPer, "16");
  assert.equal(after[0]?.quantityPer, "18");
});
