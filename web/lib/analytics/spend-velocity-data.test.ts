import assert from "node:assert/strict";
import test from "node:test";

const { getSpendVelocityComparisonWindows, moneyCagr, monthsToCliffFor, priorYearCapFor, velocityAndAcceleration } = await import(
  "./spend-velocity-data.ts"
);

const fiscalPeriods = [
  { fiscalYear: 2026, periodNumber: 1, name: "P1", from: "2026-02-01", to: "2026-03-01" },
  { fiscalYear: 2026, periodNumber: 2, name: "P2", from: "2026-03-02", to: "2026-03-29" },
  { fiscalYear: 2026, periodNumber: 3, name: "P3", from: "2026-03-30", to: "2026-04-26" },
];

/**
 * Comparison windows: equal-length calendar shifts without declared
 * periods; whole-period runs on boundary-aligned windows; the same elapsed
 * length at the same day offset inside the preceding run for misaligned
 * windows (the run's start plus the days elapsed into the current run);
 * calendar shifts where no declared run precedes. A partial current window
 * must never compare its short span against whole prior periods.
 */
test("comparison windows snap, anchor, or shift by declared coverage", () => {
  const cases: Array<{ name: string; from: string; to: string; periods?: typeof fiscalPeriods; want: object }> = [
    {
      name: "calendar month",
      from: "2026-01-01",
      to: "2026-01-31",
      want: { periodDays: 31, priorFrom: "2025-12-01", priorTo: "2025-12-31", twoBackFrom: "2025-10-31", twoBackTo: "2025-11-30" },
    },
    {
      name: "one-day period",
      from: "2026-02-14",
      to: "2026-02-14",
      want: { periodDays: 1, priorFrom: "2026-02-13", priorTo: "2026-02-13", twoBackFrom: "2026-02-12", twoBackTo: "2026-02-12" },
    },
    {
      name: "aligned period",
      from: "2026-03-30",
      to: "2026-04-26",
      periods: fiscalPeriods,
      want: { periodDays: 28, priorFrom: "2026-03-02", priorTo: "2026-03-29", twoBackFrom: "2026-02-01", twoBackTo: "2026-03-01" },
    },
    {
      name: "period-to-date",
      from: "2026-03-30",
      to: "2026-04-10",
      periods: fiscalPeriods,
      want: { periodDays: 12, priorFrom: "2026-03-02", priorTo: "2026-03-13", twoBackFrom: "2026-02-18", twoBackTo: "2026-03-01" },
    },
    {
      name: "two-period run with one declared period behind",
      from: "2026-03-02",
      to: "2026-04-26",
      periods: fiscalPeriods,
      want: { periodDays: 56, priorFrom: "2026-01-05", priorTo: "2026-03-01", twoBackFrom: "2025-11-10", twoBackTo: "2026-01-04" },
    },
    {
      name: "mid-period window with no preceding run",
      from: "2026-03-10",
      to: "2026-04-10",
      periods: fiscalPeriods,
      want: { periodDays: 32, priorFrom: "2026-02-06", priorTo: "2026-03-09", twoBackFrom: "2026-01-05", twoBackTo: "2026-02-05" },
    },
  ];
  for (const c of cases) {
    assert.deepEqual(getSpendVelocityComparisonWindows(c.from, c.to, c.periods ?? []), c.want, c.name);
  }
});

/**
 * Prior-year cap: a report ending mid-bucket compares period-to-date with
 * period-to-date — the matched prior bucket caps at the same elapsed day
 * offset. A boundary-ending report or an unmatched last bucket needs no cap.
 */
test("a period-to-date report caps the matched prior-year bucket at the same offset", () => {
  const withPrior = [
    { fiscalYear: 2025, periodNumber: 3, name: "P3-25", from: "2025-03-31", to: "2025-04-27" },
    ...fiscalPeriods,
  ];
  // Eleven days into P3 (03-30..04-10) caps prior P3 eleven days in (03-31..04-11).
  assert.deepEqual(priorYearCapFor(withPrior, true, "2026-04-10"), { bucket: "2025-03-31", date: "2025-04-11" });
  // A report ending on the bucket boundary compares whole with whole.
  assert.equal(priorYearCapFor(withPrior, true, "2026-04-26"), null);
  // P2 has no prior-year match in this calendar: YoY stays unknown, no cap.
  assert.equal(priorYearCapFor(fiscalPeriods, true, "2026-03-10"), null);
  // Calendar mode caps the same month a year earlier at the same day offset.
  assert.deepEqual(priorYearCapFor([], false, "2026-04-10"), { bucket: "2025-04", date: "2025-04-10" });
  assert.equal(priorYearCapFor([], false, "2026-04-30"), null);
});

test("measured series score velocity, acceleration and trend from disjoint halves", () => {
  const cases: Array<{ name: string; amounts: number[]; want: { velocity: number | null; acceleration: number | null; trend: string } }> = [
    { name: "flat", amounts: [200, 200, 200, 200, 200, 200], want: { velocity: 0, acceleration: 0, trend: "stable" } },
    { name: "repeating", amounts: [100, 200, 100, 200], want: { velocity: 26, acceleration: 0, trend: "high" } },
    { name: "rising", amounts: [100, 100, 100, 200, 300, 500], want: { velocity: 38, acceleration: 58.1, trend: "accelerating" } },
    { name: "falling", amounts: [500, 300, 200, 100, 100, 100], want: { velocity: -27.5, acceleration: 36.8, trend: "declining" } },
  ];
  for (const c of cases) {
    assert.deepEqual(velocityAndAcceleration(c.amounts), c.want, c.name);
  }
});

test("a zero first bucket measures from the first positive month, not zero", () => {
  const thresholds = { velocityHighThreshold: 15, velocityMediumThreshold: 5, minBaseAmount: "" };
  // 0 → 100 → 200 scores the measurable 100 → 200 leg instead of a flat 0.
  // Three buckets hold no acceleration halves, so acceleration is unmeasured.
  assert.deepEqual(velocityAndAcceleration([0, 100, 200], thresholds), {
    velocity: 100,
    acceleration: null,
    trend: "high",
  });
  // Exact-string twin: a zero first bucket divides nothing and measures 100%.
  assert.equal(moneyCagr(["0.0000", "100.0000", "200.0000"], ""), 100);
  // A measured collapse to zero still reads −100.
  assert.equal(moneyCagr(["100.0000", "0.0000"], ""), -100);
});

test("a zero-only or single-bucket history has no velocity to report", () => {
  assert.equal(moneyCagr(["0.0000", "0.0000"], ""), null);
  assert.equal(moneyCagr(["100.0000"], ""), null);
  assert.equal(moneyCagr([], ""), null);
  // Every bucket below the configured floor is dust, not a base.
  assert.equal(moneyCagr(["5.0000", "8.0000"], "100.0000"), null);
});

test("months to cliff compounds the measured gap to the breached ratio", () => {
  // PO growing 10 points faster per period carries a 1.0 ratio past 1.5 in ~4 periods.
  assert.equal(monthsToCliffFor(10, 1.0, 1.5), 4);
  // An already-breached ratio is pressure now, not months out.
  assert.equal(monthsToCliffFor(10, 1.6, 1.5), 0);
  // No pace or no sales base compounds nothing.
  assert.equal(monthsToCliffFor(0, 1.0, 1.5), null);
  assert.equal(monthsToCliffFor(-5, 1.0, 1.5), null);
  assert.equal(monthsToCliffFor(10, 0, 1.5), null);
});

test("too little history measures nothing instead of a flat zero", () => {
  const engine = { velocityHighThreshold: 15, velocityMediumThreshold: 5, minBaseAmount: "" };
  assert.deepEqual(velocityAndAcceleration([], engine), { velocity: null, acceleration: null, trend: "stable" });
  assert.deepEqual(velocityAndAcceleration([0, 0], engine), { velocity: null, acceleration: null, trend: "stable" });
  assert.deepEqual(velocityAndAcceleration([5], engine), { velocity: null, acceleration: null, trend: "new" });
});

test("an unset minimum base scores dust series from their first month", () => {
  const dust = [5, 500, 600, 700, 800];
  const thresholds = { velocityHighThreshold: 15, velocityMediumThreshold: 5, minBaseAmount: "" };
  // No floor: 5 → 800 caps at the +200% ceiling instead of being skipped.
  assert.equal(velocityAndAcceleration(dust, thresholds).velocity, 200);
  // A configured floor skips the dust base and scores from the first real month.
  assert.equal(
    velocityAndAcceleration(dust, { ...thresholds, minBaseAmount: "100.0000" }).velocity,
    17,
  );
});
