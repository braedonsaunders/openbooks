import assert from "node:assert/strict";
import test from "node:test";
import { findingSummaryLine } from "./summary";

const t = (key: string, values?: Record<string, string | number>) =>
  key === "summary.records" ? `${values?.count} records` : key === "summary.review" ? "review" : key;

test("finding summary line prefers account, scenario, period, count", () => {
  assert.equal(
    findingSummaryLine(t, { accountNumber: "1000", accountName: "Bank" }),
    "1000 · Bank",
  );
  assert.equal(findingSummaryLine(t, { scenarioName: "FY26" }), "FY26");
  assert.equal(
    findingSummaryLine(t, { currentPeriod: "2026-07", priorPeriod: "2026-06" }),
    "2026-07 / 2026-06",
  );
  assert.equal(findingSummaryLine(t, { count: 4 }), "4 records");
  assert.equal(findingSummaryLine(t, {}), "review");
});
