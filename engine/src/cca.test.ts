import assert from "node:assert/strict";
import test from "node:test";
import { CCA_CLASSES, computeCcaYear, type CcaYearInput } from "./cca.ts";

const run = (over: Partial<CcaYearInput>): ReturnType<typeof computeCcaYear> =>
  computeCcaYear({ uccOpen: "0", additions: "0", dispositions: "0", rate: 0.2, ...over });

test("half-year rule: only 50% of net additions depreciate in year 1", () => {
  // Class 8 (20%), 10,000 addition → base 5,000 → CCA 1,000.
  const r = run({ additions: "10000" });
  assert.equal(r.ccaBase, "5000.00");
  assert.equal(r.ccaClaimed, "1000.00");
  assert.equal(r.uccClose, "9000.00");
});

test("year 2 depreciates the full opening UCC (no half-year)", () => {
  const r = run({ uccOpen: "9000", additions: "0" });
  assert.equal(r.ccaClaimed, "1800.00"); // 9000 * 20%
  assert.equal(r.uccClose, "7200.00");
});

test("AII suspends the half-year rule and boosts year-1 CCA", () => {
  // 1.5× multiplier: base = 10000 + 0.5*10000 = 15000 → CCA 3000 (vs 1000).
  const r = run({ additions: "10000", aiiMultiplier: 1.5 });
  assert.equal(r.ccaBase, "15000.00");
  assert.equal(r.ccaClaimed, "3000.00");
});

test("half-year-exempt class takes the full rate in year 1", () => {
  // Class 12 (100%), no half-year → fully written off.
  const r = run({ additions: "5000", rate: 1.0, halfYearRule: false });
  assert.equal(r.ccaClaimed, "5000.00");
  assert.equal(r.uccClose, "0.00");
});

test("recapture: proceeds exceed the pool → income, UCC resets to 0", () => {
  const r = run({ uccOpen: "2000", dispositions: "5000" });
  assert.equal(r.recapture, "3000.00");
  assert.equal(r.ccaClaimed, "0.00");
  assert.equal(r.uccClose, "0.00");
});

test("terminal loss: class emptied with UCC remaining → deduction", () => {
  const r = run({ uccOpen: "3000", classHasAssetsAtYearEnd: false });
  assert.equal(r.terminalLoss, "3000.00");
  assert.equal(r.uccClose, "0.00");
});

test("short fiscal year prorates the CCA", () => {
  const r = run({ uccOpen: "10000", rate: 0.3, shortYearFactor: 0.5 });
  assert.equal(r.ccaClaimed, "1500.00"); // 10000 * 30% * 0.5
});

test("discretionary claim cap limits the CCA (and preserves UCC)", () => {
  const r = run({ uccOpen: "10000", claimCap: "500" });
  assert.equal(r.ccaClaimed, "500.00");
  assert.equal(r.uccClose, "9500.00");
});

test("Class 10.1: a disposal never recaptures", () => {
  const r = run({ uccOpen: "1000", dispositions: "5000", noRecapture: true });
  assert.equal(r.recapture, "0.00");
  assert.equal(r.uccClose, "0.00");
});

test("immediate expensing fully deducts, leaving nothing for the rate", () => {
  const r = run({ additions: "100000", immediateExpense: "100000", rate: 0.55 });
  assert.equal(r.immediateExpense, "100000.00");
  assert.equal(r.ccaClaimed, "0.00");
  assert.equal(r.uccClose, "0.00");
});

test("class table has the headline rates", () => {
  assert.equal(CCA_CLASSES["8"]!.rate, 0.2);
  assert.equal(CCA_CLASSES["10"]!.rate, 0.3);
  assert.equal(CCA_CLASSES["50"]!.rate, 0.55);
  assert.equal(CCA_CLASSES["10.1"]!.noRecapture, true);
});
