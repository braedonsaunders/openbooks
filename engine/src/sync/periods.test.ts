import assert from "node:assert/strict";
import test from "node:test";
import {
  allModules,
  fiscalYearsForEndingRule,
  fiscalYearsForRange,
  monthlySourcePeriods,
} from "./periods.ts";

test("fiscalYearsForRange labels a March year-end by its ending year", () => {
  assert.deepEqual(fiscalYearsForRange("2025-04-01", "2027-03-31", 4), [
    { key: "2026", fiscalYear: 2026, startsOn: "2025-04-01", endsOn: "2026-03-31" },
    { key: "2027", fiscalYear: 2027, startsOn: "2026-04-01", endsOn: "2027-03-31" },
  ]);
});

test("fiscalYearsForEndingRule preserves non-calendar year boundaries", () => {
  assert.deepEqual(fiscalYearsForEndingRule("2025-07-01", "2026-06-30", 6, 30), [
    { key: "2026", fiscalYear: 2026, startsOn: "2025-07-01", endsOn: "2026-06-30" },
  ]);
});

test("monthlySourcePeriods carries source lock state per module", () => {
  const rows = monthlySourcePeriods(
    "test",
    [{ key: "2026", fiscalYear: 2026, startsOn: "2026-01-01", endsOn: "2026-03-31" }],
    (endsOn) => allModules(endsOn <= "2026-02-28" ? "closed" : "open"),
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.fields.periodNumber, 1);
  assert.equal((rows[1]?.fields.moduleStates as Record<string, string>).gl, "closed");
  assert.equal((rows[2]?.fields.moduleStates as Record<string, string>).gl, "open");
});

test("monthlySourcePeriods keeps a February period after a month-end rollover", () => {
  const rows = monthlySourcePeriods(
    "test",
    [{ key: "2026", fiscalYear: 2026, startsOn: "2026-01-31", endsOn: "2026-04-30" }],
    () => allModules("closed"),
  );
  assert.deepEqual(
    rows.map((row) => [row.fields.name, row.fields.startsOn, row.fields.endsOn]),
    [
      ["2026-01", "2026-01-31", "2026-02-27"],
      ["2026-02", "2026-02-28", "2026-03-27"],
      ["2026-03", "2026-03-28", "2026-04-27"],
      ["2026-04", "2026-04-28", "2026-04-30"],
    ],
  );
});
