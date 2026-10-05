import assert from "node:assert/strict";
import test from "node:test";

const { fiscalMonthlyBoxes, fiscalPeriodsPerYear, priorYearWindow } = await import("./fiscal-buckets.ts");

const periods = [
  { fiscalYear: 2026, periodNumber: 1, name: "P1", from: "2026-02-01", to: "2026-03-01" },
  { fiscalYear: 2026, periodNumber: 2, name: "P2", from: "2026-03-02", to: "2026-03-29" },
];

test("declared periods keep names and labels, fallback boxes never drop", () => {
  const boxes = fiscalMonthlyBoxes(
    periods,
    "2026-01-01",
    "2026-03-31",
    new Map([
      ["2026-02-01", "100.0000"],
      ["2026-01", "25.0000"],
    ]),
    "0",
    new Map([["2026-03-02", "P2 special"]]),
    (ym) => `M(${ym})`,
  );
  // Declared and fallback boxes interleave in chronological order: the
  // January fallback sorts ahead of the February period, never after the
  // run — and a resolved label wins over the period name.
  assert.deepEqual(boxes, [
    { month: "2026-01", label: "M(2026-01)", spend: "25.0000" },
    { month: "2026-02-01", label: "P1", spend: "100.0000" },
    { month: "2026-03-02", label: "P2 special", spend: "0" },
  ]);
});

test("a thirteen-period year annualises by thirteen, 4-4-5 by twelve", () => {
  const year = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      fiscalYear: 2026,
      periodNumber: i + 1,
      name: `P${i + 1}`,
      from: `2026-${String(i + 1).padStart(2, "0")}-01`,
      to: `2026-${String(i + 1).padStart(2, "0")}-28`,
    }));
  assert.equal(fiscalPeriodsPerYear(year(13), "2026-07-15"), 13);
  assert.equal(fiscalPeriodsPerYear(year(12), "2026-07-15"), 12);
  // Outside declared coverage the cadence is unknown, never silently twelve.
  assert.equal(fiscalPeriodsPerYear([], "2026-07-15"), null);
  assert.equal(fiscalPeriodsPerYear(year(12), "2027-01-01"), null);
});

test("the prior-year window spans the matched periods, never calendar -12 months", () => {
  const cal = [
    { fiscalYear: 2025, periodNumber: 2, name: "P2", from: "2025-03-01", to: "2025-04-06" },
    { fiscalYear: 2026, periodNumber: 2, name: "P2", from: "2026-03-02", to: "2026-04-05" },
  ];
  // Calendar -12 months would query 2025-03-02..2025-04-05, cutting the
  // matched period's first day and inventing one past its end.
  assert.deepEqual(priorYearWindow(cal, "2026-03-02", "2026-04-05"), {
    from: "2025-03-01",
    to: "2025-04-06",
  });
  assert.equal(priorYearWindow(cal, "2027-03-02", "2027-04-05"), null);
  assert.equal(priorYearWindow([], "2026-03-02", "2026-04-05"), null);
});

