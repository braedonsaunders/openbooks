import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  bandPlacement,
  compaQuartile,
  compaRatio,
  evaluateFormula,
  fitUnexplainedGap,
  meanAndMedian,
  ordinaryLeastSquares,
  resolveMatrixGuideline,
  solveLinearSystem,
} from "./compensation-math.ts";
import { CompensationError } from "./errors.ts";

describe("compa-ratio", () => {
  test("rate over target to ten places", () => {
    assert.equal(compaRatio("85000", "100000"), "0.8500000000");
  });

  test("division is exact, never a binary float", () => {
    // 106497.9938 / 172193.2558 is 0.6184794713... — (r/t).toFixed(10)
    // through JS Number prints 0.6184794712, and that wrong digit is what
    // used to be stored and fed to guideline resolution.
    assert.equal(compaRatio("106497.9938", "172193.2558"), "0.6184794713");
    assert.equal(compaRatio("1", "3"), "0.3333333333");
    assert.equal(compaRatio("2", "3"), "0.6666666667");
    assert.equal(compaRatio("9999999999999.9999", "1"), "9999999999999.9999000000");
  });

  test("non-decimal rates are refused, never coerced", () => {
    assert.throws(() => compaRatio("abc", "100000"), (e: unknown) => {
      assert.ok(e instanceof CompensationError);
      assert.match(e.message, /rate "abc" is not a finite decimal/);
      return true;
    });
  });

  test("zero target refuses by name instead of dividing", () => {
    assert.throws(() => compaRatio("85000", "0"), (e: unknown) => {
      assert.ok(e instanceof CompensationError);
      assert.match(e.message, /band target 0 is not positive/);
      return true;
    });
  });

  test("placement names the side of the range", () => {
    assert.equal(bandPlacement("70000", "80000", "100000", "120000").placement, "below_min");
    assert.equal(bandPlacement("100000", "80000", "100000", "120000").placement, "in_range");
    assert.equal(bandPlacement("130000", "80000", "100000", "120000").placement, "above_max");
  });

  test("quartile boundaries belong to the higher quartile", () => {
    assert.equal(compaQuartile("0.7999"), "q1");
    assert.equal(compaQuartile("0.8"), "q2");
    assert.equal(compaQuartile("0.95"), "q3");
    assert.equal(compaQuartile("1.1"), "q4");
  });

  test("quartile boundaries hold at full ratio precision", () => {
    assert.equal(compaQuartile("0.7999999999"), "q1");
    assert.equal(compaQuartile("0.8000000000"), "q2");
    assert.equal(compaQuartile("0.9499999999"), "q2");
    assert.equal(compaQuartile("1.0999999999"), "q3");
    assert.equal(compaQuartile("1.1000000000"), "q4");
  });
});

describe("matrix guideline", () => {
  const matrix = {
    rows: ["exceeds", "meets"],
    cols: ["q1", "q2", "q3", "q4"],
    cells: {
      exceeds: { q1: { min: 5, max: 8 }, q2: { min: 4, max: 6 }, q3: { min: 3, max: 5 }, q4: { min: 0, max: 3 } },
      meets: { q1: { min: 3, max: 5 }, q2: { min: 2, max: 4 }, q3: { min: 1, max: 3 }, q4: { min: 0, max: 2 } },
    },
    unratedRow: "meets",
  };

  test("rating plus quartile selects the cell", () => {
    assert.deepEqual(resolveMatrixGuideline(matrix, "exceeds", "0.75"), { min: 5, max: 8 });
    assert.deepEqual(resolveMatrixGuideline(matrix, "meets", "1.2"), { min: 0, max: 2 });
  });

  test("no shared review falls back to the unrated row, never a colleague's rating", () => {
    assert.deepEqual(resolveMatrixGuideline(matrix, null, "0.75"), { min: 3, max: 5 });
  });

  test("an unknown rating key falls back instead of refusing", () => {
    assert.deepEqual(resolveMatrixGuideline(matrix, "mystery", "0.75"), { min: 3, max: 5 });
  });

  test("a missing cell refuses by name", () => {
    const hollow = { ...matrix, cells: { ...matrix.cells, meets: {} } };
    assert.throws(() => resolveMatrixGuideline(hollow, null, "0.75"), /no usable cell for performance "meets" in quartile q1/);
  });
});

describe("formula evaluator", () => {
  test("arithmetic with precedence over the three variables", () => {
    assert.equal(evaluateFormula("rating * 2 + compa_ratio", { rating: 3, compaRatio: 0.9, tenureYears: 2 }), 6.9);
    assert.equal(evaluateFormula("2 * (rating + 1)", { rating: 3, compaRatio: 1, tenureYears: 1 }), 8);
    assert.equal(evaluateFormula("clamp(rating + tenure_years, 0, 6)", { rating: 4, compaRatio: 1, tenureYears: 5 }), 6);
    assert.equal(evaluateFormula("max(rating, 3) + min(compa_ratio, 1)", { rating: 2, compaRatio: 1.2, tenureYears: 0 }), 4);
  });

  test("an unknown identifier refuses by name", () => {
    assert.throws(() => evaluateFormula("salary * 2", { rating: 3, compaRatio: 1, tenureYears: 1 }), /names "salary" — only rating, compa_ratio and tenure_years exist/);
  });

  test("a function that does not exist refuses", () => {
    assert.throws(() => evaluateFormula("pow(rating, 2)", { rating: 3, compaRatio: 1, tenureYears: 1 }), /calls "pow" — only min, max and clamp exist/);
  });

  test("property access is not an expression", () => {
    assert.throws(() => evaluateFormula("rating.toString", { rating: 3, compaRatio: 1, tenureYears: 1 }), /contains "\."/);
  });

  test("division by zero refuses instead of yielding Infinity", () => {
    assert.throws(() => evaluateFormula("rating / (compa_ratio - compa_ratio)", { rating: 3, compaRatio: 1, tenureYears: 1 }), /divides by zero/);
  });

  test("a formula needing a rating refuses for an unrated line", () => {
    assert.throws(() => evaluateFormula("rating * 2", { rating: null, compaRatio: 1, tenureYears: 1 }), /needs a rating but this line has no shared review/);
  });

  test("an empty formula refuses", () => {
    assert.throws(() => evaluateFormula("  ", { rating: 3, compaRatio: 1, tenureYears: 1 }), /formula is empty/);
  });
});

describe("ordinary least squares", () => {
  test("hand-computed fixture: y = 1 + 2x", () => {
    // Four points exactly on the line, so the fit must recover it.
    const fit = ordinaryLeastSquares([
      { y: 1, x: [0] },
      { y: 3, x: [1] },
      { y: 5, x: [2] },
      { y: 7, x: [3] },
    ]);
    assert.ok(Math.abs(fit.coefficients[0]! - 1) < 1e-9, `intercept ${fit.coefficients[0]}`);
    assert.ok(Math.abs(fit.coefficients[1]! - 2) < 1e-9, `slope ${fit.coefficients[1]}`);
    assert.ok(Math.abs(fit.rSquared - 1) < 1e-9);
  });

  test("hand-computed fixture with two regressors", () => {
    // y = 10 + 3x1 - 2x2 on six varied rows.
    const rows: Array<{ y: number; x: number[] }> = [
      { y: 10 + 0 - 0, x: [0, 0] },
      { y: 10 + 3 - 0, x: [1, 0] },
      { y: 10 + 0 - 2, x: [0, 1] },
      { y: 10 + 6 - 4, x: [2, 2] },
      { y: 10 + 9 - 2, x: [3, 1] },
      { y: 10 + 3 - 6, x: [1, 3] },
    ];
    const fit = ordinaryLeastSquares(rows);
    assert.ok(Math.abs(fit.coefficients[0]! - 10) < 1e-9, `intercept ${fit.coefficients[0]}`);
    assert.ok(Math.abs(fit.coefficients[1]! - 3) < 1e-9, `b1 ${fit.coefficients[1]}`);
    assert.ok(Math.abs(fit.coefficients[2]! + 2) < 1e-9, `b2 ${fit.coefficients[2]}`);
  });

  test("a singular system refuses instead of reporting a number", () => {
    // x1 === x2 on every row: the columns move together.
    assert.throws(
      () =>
        ordinaryLeastSquares([
          { y: 1, x: [0, 0] },
          { y: 2, x: [1, 1] },
          { y: 3, x: [2, 2] },
        ]),
      /singular for this category/,
    );
  });

  test("fewer rows than columns refuses", () => {
    assert.throws(() => ordinaryLeastSquares([{ y: 1, x: [0, 0] }]), /too thin to separate/);
  });

  test("solveLinearSystem refuses the non-square shape", () => {
    assert.throws(() => solveLinearSystem([[1, 2]], [1]), /square system/);
  });

  test("mean and median refuse the empty set", () => {
    assert.deepEqual(meanAndMedian([3, 1, 2], "wages"), { mean: 2, median: 2 });
    assert.throws(() => meanAndMedian([], "wages"), /has no records/);
  });
});

describe("unexplained gap fit", () => {
  test("constant controls drop to the raw group gap, named group_only", () => {
    const fitted = fitUnexplainedGap([
      { groupIsA: true, tenureYears: 5, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(100000) },
      { groupIsA: true, tenureYears: 5, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(100000) },
      { groupIsA: false, tenureYears: 5, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(80000) },
      { groupIsA: false, tenureYears: 5, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(80000) },
    ]);
    assert.equal(fitted.method, "group_only");
    assert.ok(Math.abs(fitted.unexplainedGapPct! - 25) < 0.001, `gap ${fitted.unexplainedGapPct}`);
  });

  test("balanced tenure partials out, named ols_log_rate", () => {
    const fitted = fitUnexplainedGap([
      { groupIsA: true, tenureYears: 2, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(100000) },
      { groupIsA: true, tenureYears: 6, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(100000) },
      { groupIsA: false, tenureYears: 2, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(80000) },
      { groupIsA: false, tenureYears: 6, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(80000) },
    ]);
    assert.equal(fitted.method, "ols_log_rate");
    assert.ok(Math.abs(fitted.unexplainedGapPct! - 25) < 0.001, `gap ${fitted.unexplainedGapPct}`);
  });

  test("a single-sided category cannot fit", () => {
    const fitted = fitUnexplainedGap([
      { groupIsA: true, tenureYears: 2, levelRank: 3, hoursBasis: 2080, subsidiaryIdx: 0, logRate: Math.log(100000) },
    ]);
    assert.equal(fitted.unexplainedGapPct, null);
    assert.equal(fitted.method, "insufficient_data");
  });
});
