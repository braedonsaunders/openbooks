import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateQuestion,
  computeEnps,
  driverScores,
  heatmap,
  type ResultAnswer,
} from "./results.ts";

function scale(questionId: string, driver: string | null, value: number, segment: string | null): ResultAnswer {
  return { questionId, kind: "scale", driverKey: driver, value, raw: value, segment };
}

test("eNPS arithmetic: promoters minus detractors in points", () => {
  // 2 promoters (9,10), 1 passive (8), 1 detractor (5): 50 − 25 = 25.
  const result = computeEnps([9, 10, 8, 5]);
  assert.equal(result.score, 25);
  assert.equal(result.promoters, 2);
  assert.equal(result.passives, 1);
  assert.equal(result.detractors, 1);
});

test("eNPS ignores out-of-range values and is null when empty", () => {
  assert.equal(computeEnps([11, -1]).score, null);
  assert.equal(computeEnps([]).score, null);
});

test("question aggregates count and mean numerics", () => {
  const agg = aggregateQuestion("q1", "scale", [
    scale("q1", "growth", 4, "eng"),
    scale("q1", "growth", 2, "eng"),
  ]);
  assert.equal(agg.responses, 2);
  assert.equal(agg.mean, 3);
});

test("heatmap suppresses cells below min_group_size with null, never a number", () => {
  const answers = [
    scale("q1", "growth", 5, "eng"),
    scale("q1", "growth", 4, "eng"),
    scale("q1", "growth", 1, "sales"),
  ];
  const map = heatmap(answers, 2);
  assert.equal(map.cells["growth"]!["eng"]!.suppressed, false);
  assert.equal(map.cells["growth"]!["eng"]!.mean, 4.5);
  // min_group_size − 1: the cell exists but carries null, flagged.
  assert.equal(map.cells["growth"]!["sales"]!.suppressed, true);
  assert.equal(map.cells["growth"]!["sales"]!.mean, null);
});

test("driver scores average scale answers per driver", () => {
  const scores = driverScores([scale("q1", "growth", 5, null), scale("q2", "growth", 3, null)]);
  assert.equal(scores.length, 1);
  assert.equal(scores[0]!.mean, 4);
  assert.equal(scores[0]!.responses, 2);
});
