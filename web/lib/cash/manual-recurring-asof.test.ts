import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// A monthly/biweekly occurrence dated before asOf is already-paid history:
// forecasting it again double-counts the bill as future cash need. Weekly
// amounts spread across the week, so the current week keeps its proration.
test("manual monthly and biweekly skip occurrences before asOf", () => {
  const source = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../money-server") return { url: "data:text/javascript,export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }", shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    const { categoryWeekly } = await import("./web/lib/cash/core.ts");
    // asOf Wed 2026-09-02: horizon Sundays start 2026-08-30.
    const weeks = ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11", "2026-10-18"];
    const context = { arWeekly: {}, apWeekly: {}, cashStart: "0.0000" };

    const monthly = await categoryWeekly(
      "org-1",
      { id: "cat-rent", name: "Rent", direction: "outflow", method: "manual_recurring", amount: "1000.0000", frequency: "monthly" },
      "2026-09-02", weeks, context,
    );
    // Occurrences step Aug 30 / Sep 30: Aug 30 predates asOf (paid), Sep 30
    // lands in the Sep-27 week. The Aug-30 week must read zero.
    assert.deepEqual(monthly.weekly, ["0.0000", "0.0000", "0.0000", "0.0000", "1000.0000", "0.0000", "0.0000", "0.0000"]);
    assert.equal(monthly.total, "1000.0000");

    const biweekly = await categoryWeekly(
      "org-1",
      { id: "cat-payroll", name: "Payroll", direction: "outflow", method: "manual_recurring", amount: "500.0000", frequency: "biweekly" },
      "2026-09-02", weeks, context,
    );
    // Occurrences step Aug 30 / Sep 13 / Sep 27 / Oct 11: only Aug 30 is past.
    assert.deepEqual(biweekly.weekly, ["0.0000", "0.0000", "500.0000", "0.0000", "500.0000", "0.0000", "500.0000", "0.0000"]);
    assert.equal(biweekly.total, "1500.0000");

    const weekly = await categoryWeekly(
      "org-1",
      { id: "cat-rev", name: "Revenue", direction: "inflow", method: "manual_recurring", amount: "700.0000", frequency: "weekly" },
      "2026-09-02", weeks, context,
    );
    // Spread model unchanged: 3 business days remain of the first week.
    assert.equal(weekly.weekly[0], "420.0000");
    assert.equal(weekly.weekly[1], "700.0000");
    console.log("manual recurring asOf behavior passed: paid occurrences skipped, weekly spread kept");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// A persisted anchor pins the monthly/biweekly phase: moving asOf across
// weeks must not rephase the schedule, and month-end anchors must not drift
// (Jan 31 → Feb 28 → Mar 31, never Mar 28).
test("anchored manual schedules keep their phase when asOf moves", () => {
  const source = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../money-server") return { url: "data:text/javascript,export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }", shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    const { anchoredMonthlyOccurrences, categoryWeekly, parseAnchorDate } = await import("./web/lib/cash/core.ts");
    const context = { arWeekly: {}, apWeekly: {}, cashStart: "0.0000" };

    assert.equal(parseAnchorDate("2026-08-30"), "2026-08-30");
    assert.equal(parseAnchorDate("2026-02-30"), null);
    assert.equal(parseAnchorDate("2026-13-01"), null);
    assert.equal(parseAnchorDate("not-a-date"), null);
    assert.equal(parseAnchorDate(""), null);
    assert.equal(parseAnchorDate(undefined), null);
    assert.deepEqual(
      anchoredMonthlyOccurrences("2026-01-31", "2026-01-15", "2026-03-31"),
      ["2026-01-31", "2026-02-28", "2026-03-31"],
    );

    const rent = { id: "cat-rent", name: "Rent", direction: "outflow", method: "manual_recurring", amount: "1000.0000", frequency: "monthly", anchorDate: "2026-08-30" };
    // Grid from a Sep-2 asOf.
    const gridA = ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11", "2026-10-18"];
    const fromSep2 = await categoryWeekly("org-1", rent, "2026-09-02", gridA, context);
    assert.deepEqual(fromSep2.weekly, ["0.0000", "0.0000", "0.0000", "0.0000", "1000.0000", "0.0000", "0.0000", "0.0000"]);
    // Grid from a Sep-9 asOf: without an anchor the schedule rephases to
    // Sep 6 / Oct 6; with the Aug-30 anchor it still pays Sep 30 / Oct 30.
    const gridB = ["2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"];
    const fromSep9 = await categoryWeekly("org-1", rent, "2026-09-09", gridB, context);
    assert.deepEqual(fromSep9.weekly, ["0.0000", "0.0000", "0.0000", "1000.0000", "0.0000", "0.0000", "0.0000", "1000.0000"]);

    // Month-end anchor bills on the last day, never drifting.
    const eom = await categoryWeekly(
      "org-1",
      { id: "cat-eom", name: "EOM", direction: "outflow", method: "manual_recurring", amount: "200.0000", frequency: "monthly", anchorDate: "2026-01-31" },
      "2026-01-15",
      ["2026-01-11", "2026-01-18", "2026-01-25", "2026-02-01", "2026-02-08", "2026-02-15", "2026-02-22", "2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22", "2026-03-29"],
      context,
    );
    assert.equal(eom.weekly[2], "200.0000");
    assert.equal(eom.weekly[6], "200.0000");
    assert.equal(eom.weekly[11], "200.0000");
    assert.equal(eom.total, "600.0000");

    // Biweekly anchors to its own weekday, skipping past occurrences.
    const biweekly = await categoryWeekly(
      "org-1",
      { id: "cat-pay", name: "Pay", direction: "outflow", method: "manual_recurring", amount: "500.0000", frequency: "biweekly", anchorDate: "2026-08-28" },
      "2026-09-02", gridA, context,
    );
    assert.deepEqual(biweekly.weekly, ["0.0000", "500.0000", "0.0000", "500.0000", "0.0000", "500.0000", "0.0000", "500.0000"]);

    // A malformed anchor refuses nothing: the row forecasts from the horizon
    // start (with past occurrences still skipped), never throws.
    const legacy = await categoryWeekly(
      "org-1",
      { id: "cat-old", name: "Old", direction: "outflow", method: "manual_recurring", amount: "1000.0000", frequency: "monthly", anchorDate: "not-a-date" },
      "2026-09-02", gridA, context,
    );
    assert.deepEqual(legacy.weekly, ["0.0000", "0.0000", "0.0000", "0.0000", "1000.0000", "0.0000", "0.0000", "0.0000"]);
    console.log("anchored manual schedules passed: phase pinned, month-end clamped, fallback graceful");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
