import assert from "node:assert/strict";
import test from "node:test";
import { rankCostByAccountRows } from "./financials.ts";

// Regression for B-PRJ-08: cost-by-account rows filtered on
// Number(amount) !== 0 and sorted by Number differences over 4-decimal
// strings, so values beyond float precision misranked or vanished where
// the SQL HAVING and ORDER used to do it exactly. Ranking is exact
// decimal compare and sort (the money helpers), never floats.
test("amounts differing beyond float precision keep their exact order", () => {
  // 19 significant digits: both coerce to the same float64, so a Number()
  // sort ties them and keeps insertion order; exact compare ranks them.
  const smaller = { accountId: "a", amount: "123456789012345.6788" };
  const larger = { accountId: "b", amount: "123456789012345.6789" };
  assert.equal(Number(smaller.amount), Number(larger.amount));
  assert.deepEqual(
    rankCostByAccountRows([smaller, larger]).map((r) => r.accountId),
    ["b", "a"],
  );
});

test("exact zeros drop, including the translated '0' shape, and tiny nonzeros survive", () => {
  const rows = [
    { accountId: "zero4", amount: "0.0000" },
    { accountId: "tiny", amount: "0.0001" },
    { accountId: "zero1", amount: "0" },
    { accountId: "whole", amount: "20.0000" },
  ];
  assert.deepEqual(
    rankCostByAccountRows(rows).map((r) => r.accountId),
    ["whole", "tiny"],
  );
});

test("equal amounts keep a deterministic order", () => {
  const rows = [
    { accountId: "first", amount: "10.0000" },
    { accountId: "second", amount: "10.0000" },
  ];
  assert.deepEqual(
    rankCostByAccountRows(rows).map((r) => r.accountId),
    ["first", "second"],
  );
});
