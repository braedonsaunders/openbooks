import assert from "node:assert/strict";
import test from "node:test";
import { homeFiscalWindow } from "./fiscal-window.ts";

const FY_2026 = { from: "2026-01-01", to: "2026-12-31" };

test("an open fiscal year is cut at the business day and names it", () => {
  assert.deepEqual(homeFiscalWindow(FY_2026, "2026-10-11"), {
    from: "2026-01-01",
    to: "2026-10-11",
    throughDate: "2026-10-11",
  });
});

test("a fiscal year ending on the business day is complete through that day", () => {
  assert.deepEqual(homeFiscalWindow(FY_2026, "2026-12-31"), {
    from: "2026-01-01",
    to: "2026-12-31",
    throughDate: "2026-12-31",
  });
});

test("a closed fiscal year keeps its own end and carries no cut-off", () => {
  assert.deepEqual(homeFiscalWindow({ from: "2025-01-01", to: "2025-12-31" }, "2026-10-11"), {
    from: "2025-01-01",
    to: "2025-12-31",
    throughDate: null,
  });
});

test("a business day before the window start refuses instead of summing an inverted range", () => {
  assert.throws(() => homeFiscalWindow(FY_2026, "2025-06-30"), /precedes the fiscal window/);
});
