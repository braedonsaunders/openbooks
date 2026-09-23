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
