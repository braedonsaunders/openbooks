import assert from "node:assert/strict";
import test from "node:test";
import { PayrollPackError } from "../payroll-error.ts";
import { assessAuWorkersComp } from "./employer-levies.ts";

/**
 * The pure half of the AU workers'-compensation consumer: assessable wages
 * times the state insurer's premium fraction (kind "rate" — 0.012 for 1.2%,
 * never a percent), rounded once half-up to the cent.
 */
test("regional premiums price to the cent", () => {
  assert.deepEqual(assessAuWorkersComp("2400.0000", "0.012"), {
    amount: "28.8000", assessable: "2400.0000",
  });
  assert.deepEqual(assessAuWorkersComp("2400.0000", "0.014"), {
    amount: "33.6000", assessable: "2400.0000",
  });
  assert.deepEqual(assessAuWorkersComp("2400.0000", "0.011"), {
    amount: "26.4000", assessable: "2400.0000",
  });
});

test("half cents round up, below-half stays down", () => {
  // 100.00 × 0.01115 = 1.115 exactly.
  assert.equal(assessAuWorkersComp("100.0000", "0.01115").amount, "1.1200");
  // 10.00 × 0.01114 = 0.1114.
  assert.equal(assessAuWorkersComp("10.0000", "0.01114").amount, "0.1100");
});

test("the rounding is single: ledger precision never double-rounds", () => {
  // 83.3333 × 0.01206 = 1.004999598 — a round-to-4dp-first path prints
  // 1.0050 and then 1.01; the true half-up cent is 1.00.
  assert.equal(assessAuWorkersComp("83.3333", "0.01206").amount, "1.0000");
});

test("zero gross prices nothing", () => {
  assert.deepEqual(assessAuWorkersComp("0.0000", "0.012"), {
    amount: "0.0000", assessable: "0.0000",
  });
});

test("a rate above 100% is refused by name, never priced", () => {
  assert.throws(
    () => assessAuWorkersComp("2400.0000", "1.5"),
    (error: unknown) =>
      error instanceof PayrollPackError
      && /exceeds 1 \(100%\)/.test(error.message)
      && /au_workers_comp/.test(error.message),
  );
  assert.throws(
    () => assessAuWorkersComp("2400.0000", "twelve"),
    (error: unknown) =>
      error instanceof PayrollPackError && /not a decimal fraction/.test(error.message),
  );
});
