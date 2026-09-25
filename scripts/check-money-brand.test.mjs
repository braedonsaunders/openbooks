import assert from "node:assert/strict";
import test from "node:test";
import { scanMoneyBrandViolations } from "./check-money-brand.mjs";

test("money brand check refuses Number() on a Money-annotated identifier", () => {
  const { brandViolations, heuristicViolations } = scanMoneyBrandViolations(`
    import type { Money } from "../engine/src/money/brands.ts";
    export function overdrawn(balance: Money): boolean { return Number(balance) < 0; }
  `, "engine/src/ledger/fixture.ts");
  assert.equal(brandViolations.length, 1);
  assert.match(brandViolations[0].detail, /branded identifier balance/);
  assert.deepEqual(heuristicViolations, []);
});

test("money brand check refuses parseFloat and unary plus on brand-maker results", () => {
  const { brandViolations } = scanMoneyBrandViolations(`
    import { parseMoney, sumMoney } from "../engine/src/money/brands.ts";
    const unit = parseMoney("12.50");
    export const approx = parseFloat(unit) + +sumMoney([]);
  `, "engine/src/ledger/fixture.ts");
  assert.equal(brandViolations.length, 2);
});

test("money brand check allows counts and exact-string formatting", () => {
  const { brandViolations, heuristicViolations } = scanMoneyBrandViolations(`
    export function render(row) { return [format.count(Number(row.hours)), String(row.total)]; }
  `, "engine/src/ledger/fixture.ts");
  assert.deepEqual(brandViolations, []);
  assert.deepEqual(heuristicViolations, []);
});
