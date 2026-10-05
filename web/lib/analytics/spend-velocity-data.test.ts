import assert from "node:assert/strict";
import test from "node:test";

const { getSpendVelocityComparisonWindows, moneyCagr, monthsToCliffFor, velocityAndAcceleration } = await import(
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
 * length at the prior run's end for period-to-date windows; calendar shifts
 * where no declared run precedes. A partial current window must never
 * compare its short span against whole prior periods.
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
      want: { periodDays: 12, priorFrom: "2026-03-18", priorTo: "2026-03-29", twoBackFrom: "2026-03-06", twoBackTo: "2026-03-17" },
    },
  ];
  for (const c of cases) {
    assert.deepEqual(getSpendVelocityComparisonWindows(c.from, c.to, c.periods ?? []), c.want, c.name);
  }
  // A two-period run with only one declared period behind it keeps the
  // calendar behaviour rather than comparing a period and a half; a
  // mid-period window with no preceding run does the same.
  assert.equal(getSpendVelocityComparisonWindows("2026-03-02", "2026-04-26", fiscalPeriods).priorFrom, "2026-01-05");
  assert.equal(getSpendVelocityComparisonWindows("2026-03-10", "2026-04-10", fiscalPeriods).priorFrom, "2026-02-06");
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
