import assert from "node:assert/strict";
import test from "node:test";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  parseMoney,
  rational,
  subtractRational,
  type Rational,
} from "./quantities.ts";
import { runWaterfall, type WaterfallClass, type WaterfallResult } from "./waterfall.ts";
import { piecewiseCurve, type CurvePoint } from "./waterfall-curve.ts";

const ONE = rational(1n);
const money = (value: string): Rational => parseMoney(value, "price");

const classes: WaterfallClass[] = [
  {
    shareClassId: "common",
    code: "CS",
    kind: "common",
    seniority: 0,
    liquidationMultiple: rational(0n),
    participation: "none",
    participationCapMultiple: null,
    originalIssuePrice: null,
    conversionRatio: ONE,
    holdings: [{ securityId: "s-founder", holderPartyId: "founder", shares: 4_000_000n }],
  },
  {
    shareClassId: "a",
    code: "A",
    kind: "preferred",
    seniority: 1,
    liquidationMultiple: ONE,
    participation: "none",
    participationCapMultiple: null,
    originalIssuePrice: rational(1n),
    conversionRatio: ONE,
    holdings: [{ securityId: "s-fund", holderPartyId: "fund", shares: 1_000_000n }],
  },
];

const evaluate = (exit: Rational): WaterfallResult =>
  runWaterfall({ exitValue: exit, classes, awards: [], convertibles: [], minorUnitScale: 2 });
const measures = (result: WaterfallResult) =>
  new Map(result.classes.map((row) => [row.shareClassId, money(row.total)]));
const tolerance = (result: WaterfallResult) =>
  rational(BigInt(result.payouts.length + result.classes.length + 1), 100n);
const fund = (result: WaterfallResult) =>
  money(result.classes.find((row) => row.shareClassId === "a")!.total);

/** The fund's payout read off the drawn polyline at `exit`. */
function drawn(points: CurvePoint<WaterfallResult>[], exit: Rational): Rational {
  const right = points.findIndex((point) => compareRational(point.exit, exit) >= 0);
  const b = points[right]!;
  if (compareRational(b.exit, exit) === 0 || right === 0) return fund(b.result);
  const a = points[right - 1]!;
  const weight = divideRational(subtractRational(exit, a.exit), subtractRational(b.exit, a.exit));
  return addRational(
    fund(a.result),
    multiplyRational(subtractRational(fund(b.result), fund(a.result)), weight),
  );
}

const within = (actual: Rational, expected: Rational, allowance: Rational) => {
  const gap = subtractRational(actual, expected);
  return (
    compareRational(gap, allowance) <= 0 &&
    compareRational(gap, subtractRational(rational(0n), allowance)) >= 0
  );
};

test("the drawn curve bends exactly where the preference fills, not at the next even sample", () => {
  // 17 even samples over 0–10M fall every 625,000: the preference fills at
  // 1,000,000, between the 625,000 and 1,250,000 samples.
  const points = piecewiseCurve({
    from: rational(0n),
    to: money("10000000"),
    points: 17,
    evaluate,
    measures,
    tolerance,
    resolution: ONE,
  });
  const nearFill = points.filter((point) => within(point.exit, money("1000000"), ONE));
  assert.ok(nearFill.length > 0, "a point lies within one unit of the bend");
  for (const point of nearFill)
    assert.ok(
      within(
        fund(point.result),
        compareRational(point.exit, money("1000000")) <= 0 ? point.exit : money("1000000"),
        rational(1n, 100n),
      ),
    );
  // Read anywhere, the polyline matches the waterfall itself.
  for (const exit of [
    "300000",
    "800000",
    "999999",
    "1000001",
    "1100000",
    "2500000",
    "4999999",
    "5000001",
    "7300000",
    "9999999",
  ]) {
    const value = money(exit);
    assert.ok(
      within(drawn(points, value), fund(evaluate(value)), rational(2n)),
      `drawn payout at ${exit}`,
    );
  }
});

test("a straight stretch adds no points beyond the even samples", () => {
  // Above 5,000,000 the preferred has converted: it takes a fifth of every exit.
  const points = piecewiseCurve({
    from: money("6000000"),
    to: money("10000000"),
    points: 5,
    evaluate,
    measures,
    tolerance,
    resolution: ONE,
  });
  assert.equal(points.length, 5);
  for (const point of points)
    assert.equal(compareRational(fund(point.result), divideRational(point.exit, rational(5n))), 0);
});

test("refinement respects its evaluation budget", () => {
  let evaluations = 0;
  const points = piecewiseCurve({
    from: rational(0n),
    to: money("10000000"),
    points: 3,
    measures,
    tolerance,
    resolution: ONE,
    maxEvaluations: 10,
    evaluate: (exit) => {
      evaluations += 1;
      return evaluate(exit);
    },
  });
  assert.ok(evaluations <= 13, "three even samples and at most ten refinements");
  assert.ok(points.length >= 3);
});
