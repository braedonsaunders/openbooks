import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAnalyticsRatio } from "./analytics-ratio";

test("analytics ratios use the reports rational formula evaluator", () => {
  const cases = [
    { name: "fractional percentage", numerator: "1", denominator: "3", format: "percent" as const, scale: 2, expected: "33.33" },
    { name: "fractional ratio", numerator: "1", denominator: "3", format: "ratio" as const, scale: 4, expected: "0.3333" },
    { name: "negative percentage", numerator: "-1", denominator: "3", format: "percent" as const, scale: 2, expected: "-33.33" },
  ];
  for (const entry of cases) {
    assert.equal(
      evaluateAnalyticsRatio(entry.numerator, entry.denominator, entry.format, entry.scale),
      entry.expected,
      entry.name,
    );
  }
  assert.equal(evaluateAnalyticsRatio("1", "0", "percent", 2), null);
});
