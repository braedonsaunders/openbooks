/**
 * Supplemental-period arithmetic contract (2026 weekly, Ontario).
 *
 * A vacation payout and the week's wages arrive in two runs of one period.
 * Contributions price on the period-to-date base with the weekly exemption
 * applied ONCE: the first run withholds on its own base less the exemption,
 * the second on the combined base less the exemption, minus what the first
 * run already withheld. These hand-worked figures (CRA T4127 factor
 * rounding, half-up to the cent as each parenthesis resolves) pin the
 * engine's combining logic: run 1 of the week pays 300.00 of vacation
 * payout, run 2 pays 1,250.00 wages plus a 5.00 taxable (pensionable, not
 * insurable) benefit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { add, neg } from "../../money/money.ts";
import { calculateT4127 } from "./t4127.ts";

const ON_52 = {
  payDate: "2026-03-06",
  province: "ON",
  periodsPerYear: 52,
} as const;

test("supplemental-period example: first run withholds on its base less one exemption", () => {
  const first = calculateT4127({
    ...ON_52,
    income: "300.00",
    pensionable: "300.00",
    insurable: "300.00",
  });
  // (300.00 - 67.30) x 0.0595 = 13.85; 300.00 x 0.0163 = 4.89.
  assert.equal(first.cpp, "13.8500");
  assert.equal(first.ei, "4.8900");
});

test("supplemental-period example: combined base less one exemption, minus the first run", () => {
  const combined = calculateT4127({
    ...ON_52,
    income: "1555.00",
    pensionable: "1555.00",
    insurable: "1550.00",
  });
  // (300.00 + 1255.00 - 67.30) x 0.0595 = 88.52, not (1255.00 - 67.30) x 0.0595 = 70.68.
  assert.equal(combined.cpp, "88.5200");
  // (300.00 + 1250.00) x 0.0163 = 25.27.
  assert.equal(combined.ei, "25.2700");
  // Each run traces its own share, so the shares telescope to the total.
  assert.equal(add(combined.cpp, neg("13.8500")), "74.6700");
  assert.equal(add(combined.ei, neg("4.8900")), "20.3800");
});

test("supplemental-period example: pricing the second run standalone double-applies the exemption", () => {
  const standalone = calculateT4127({
    ...ON_52,
    income: "1255.00",
    pensionable: "1255.00",
    insurable: "1250.00",
  });
  // (1255.00 - 67.30) x 0.0595 = 70.67 — the 4.00 shortfall a per-run
  // exemption leaves against the correct 74.67.
  assert.equal(standalone.cpp, "70.6700");
  assert.equal(add(standalone.cpp, "13.8500"), "84.5200");
});
