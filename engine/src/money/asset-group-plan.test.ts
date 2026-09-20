import assert from "node:assert/strict";
import test from "node:test";
import { groupAssetPlan } from "./asset-group-plan.ts";
import { splitDepreciationPlan } from "./depreciation-plan.ts";
const original = [
  { startsOn: "2026-08-01", date: "2026-08-31", amount: "310" },
  { startsOn: "2026-09-01", date: "2026-09-30", amount: "300" },
];
test("a group valuation preserves service earned before its effective cutover", () => {
  const result = groupAssetPlan(original, [
    {
      effectiveOn: "2026-08-16",
      fullDelta: "-100",
      buyerDelta: "-120",
      heldNumerator: "1",
      heldDenominator: "1",
      fullPlan: [
        { startsOn: "2026-08-16", date: "2026-08-31", amount: "160" },
        { startsOn: "2026-09-01", date: "2026-09-30", amount: "200" },
      ],
    },
  ]);
  assert.equal(result.accumulatedDelta, "100.0000");
  assert.equal(
    splitDepreciationPlan(result.plan, "2026-08-16").accrued,
    "150.0000",
  );
  assert.equal(
    splitDepreciationPlan(result.plan, "2026-10-01").accrued,
    "510.0000",
  );
  assert.deepEqual(original[0], {
    startsOn: "2026-08-01",
    date: "2026-08-31",
    amount: "310",
  });
});
test("a valuation after posted month-end depreciation changes only subsequent service", () => {
  const result = groupAssetPlan(original, [
    {
      effectiveOn: "2026-08-31",
      serviceFrom: "2026-09-01",
      fullDelta: "-100",
      buyerDelta: "-120",
      heldNumerator: "1",
      heldDenominator: "1",
      fullPlan: [{ startsOn: "2026-09-01", date: "2026-09-30", amount: "200" }],
    },
  ]);
  assert.equal(
    splitDepreciationPlan(result.plan, "2026-09-01").accrued,
    "310.0000",
  );
  assert.equal(
    splitDepreciationPlan(result.plan, "2026-10-01").accrued,
    "510.0000",
  );
});
