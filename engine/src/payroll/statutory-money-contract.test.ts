import assert from "node:assert/strict";
import test from "node:test";
import { toCents } from "../money.ts";
import { calculateNlStatutory } from "./nl/loonheffing.ts";
import { calculateSgStatutory } from "./sg/cpf.ts";

/**
 * THE MONEY CONTRACT, pinned.
 *
 * `calculateStub` (engine/src/payroll-run.ts) sums earning lines with
 * money.ts `sum`, so the `income`, `nonPeriodic`, `pensionable` and
 * `insurable` every pack's `computeStatutory` receives ALWAYS arrive as
 * canonical numeric(19,4) strings — "0.0000" for an empty base, "999.0000"
 * for a € 999 wage. The NL pack once parsed those with its own 1-or-2-decimal
 * regex, so a whole country could not be paid while every unit test (which
 * called the engine with 2dp strings) stayed green.
 *
 * The contract (documented on `PayrollStatutoryComputeContext`): packs parse
 * pipeline money with money.ts — `toUnits`, or `toCents` for cent-based
 * publications — and never a pack-local decimal regex. These tests pin the
 * shared boundary and every pack that has been converged onto it, so the
 * next pack cannot drift off it without going red here first.
 */

test("the shared boundary accepts every shape the ledger emits", () => {
  // The pipeline's canonical output, trailing zeros included.
  assert.equal(toCents("0.0000"), 0n);
  assert.equal(toCents("999.0000"), 99900n);
  assert.equal(toCents("2002.5000"), 200250n);
  // Forgiving inputs the ledger never emits but operators and fixtures type.
  assert.equal(toCents("0"), 0n);
  assert.equal(toCents("0.00"), 0n);
  assert.equal(toCents("13.83"), 1383n);
  assert.equal(toCents("999"), 99900n);
});

test("sub-cent fractions round half-up to the cent", () => {
  // A quantity-times-rate intermediate carried at 4dp: the publications'
  // own "rekenkundig" rule, not truncation and not banker's rounding.
  assert.equal(toCents("10.0050"), 1001n);
  assert.equal(toCents("10.0049"), 1000n);
  assert.equal(toCents("0.0050"), 1n);
});

test("the shared boundary refuses what is not money", () => {
  for (const bad of ["", " ", "abc", "1.23456", "--1", "1,000.00"]) {
    assert.throws(() => toCents(bad), Error, JSON.stringify(bad));
  }
});

test("the NL engine prices pipeline-shaped money", () => {
  // € 999,00 zonder korting: the witte maandtabel's "zonder" column reads
  // 357,08 — the same figure the 2dp goldens pin, now through 4dp inputs.
  const four = calculateNlStatutory({
    income: "999.0000",
    periodsPerYear: 12,
    applyKorting: false,
    awfLow: true,
    aofHigh: false,
    whkPercent: "1.25",
    nonPeriodic: "0.0000",
  });
  assert.equal(four.periodicCents, 35708n);
  const two = calculateNlStatutory({
    income: "999.00",
    periodsPerYear: 12,
    applyKorting: false,
    awfLow: true,
    aofHigh: false,
    whkPercent: "1.25",
    nonPeriodic: "0",
  });
  assert.deepEqual(
    { ...four, periodicCents: String(four.periodicCents) },
    { ...two, periodicCents: String(two.periodicCents) },
    "4dp pipeline money prices identically to 2dp",
  );
  // Negatives stay refused by name at the pack boundary.
  assert.throws(
    () => calculateNlStatutory({
      income: "-1.0000",
      periodsPerYear: 12,
      applyKorting: false,
      awfLow: true,
      aofHigh: false,
      whkPercent: "1.25",
    }),
    /not a non-negative money amount/,
  );
});

test("the SG engine prices pipeline-shaped money", () => {
  // The CPF Board's own example ($4,500 OW → $765 employer / $900
  // employee), priced identically through 4dp and 2dp inputs.
  const four = calculateSgStatutory({ cpfStatus: "citizen", ageBand: "le55", ordinaryWages: "4500.0000" });
  const two = calculateSgStatutory({ cpfStatus: "citizen", ageBand: "le55", ordinaryWages: "4500.00" });
  assert.equal(four.employeeCents, 90000n);
  assert.equal(four.employerCents, 76500n);
  assert.deepEqual(four, two);
  assert.throws(
    () => calculateSgStatutory({ cpfStatus: "citizen", ageBand: "le55", ordinaryWages: "-1.0000" }),
    /not a non-negative money amount/,
  );
});
