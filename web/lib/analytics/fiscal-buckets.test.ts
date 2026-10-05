import assert from "node:assert/strict";
import test from "node:test";

const { fiscalMonthlyBoxes } = await import("./fiscal-buckets.ts");

const periods = [
  { fiscalYear: 2026, periodNumber: 1, name: "P1", from: "2026-02-01", to: "2026-03-01" },
  { fiscalYear: 2026, periodNumber: 2, name: "P2", from: "2026-03-02", to: "2026-03-29" },
];

test("declared periods keep their own names and zero-fill empty boxes", () => {
  const boxes = fiscalMonthlyBoxes(
    periods,
    "2026-01-01",
    "2026-03-31",
    new Map([["2026-02-01", "100.0000"]]),
    "0",
    new Map(),
    (ym) => `M(${ym})`,
  );
  assert.deepEqual(boxes, [
    { month: "2026-02-01", label: "P1", spend: "100.0000" },
    { month: "2026-03-02", label: "P2", spend: "0" },
  ]);
});

test("spend outside declared coverage renders as labelled fallback boxes, never dropped", () => {
  const boxes = fiscalMonthlyBoxes(
    periods,
    "2026-01-01",
    "2026-03-31",
    new Map([
      ["2026-03-02", "50.0000"],
      ["2026-01", "25.0000"],
    ]),
    "0",
    new Map([["2026-03-02", "P2 special"]]),
    (ym) => `M(${ym})`,
  );
  assert.deepEqual(boxes, [
    { month: "2026-02-01", label: "P1", spend: "0" },
    { month: "2026-03-02", label: "P2 special", spend: "50.0000" },
    { month: "2026-01", label: "M(2026-01)", spend: "25.0000" },
  ]);
});
