import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The history divisor counts the window's week buckets on or after the
// strategy's data start — never fewer than 1, never more than the window.
test("historyWindowDivisor counts buckets from the data start", () => {
  const source = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../money-server") return { url: "data:text/javascript,export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }", shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    const { fullWindowWeeklyAverage, historyWindowDivisor } = await import("./web/lib/cash/core.ts");
    // 12-week window starting Sunday 2026-04-26.
    assert.equal(historyWindowDivisor(12, "2026-04-26", null), 12);
    assert.equal(historyWindowDivisor(12, "2026-04-26", "2026-04-01"), 12);
    assert.equal(historyWindowDivisor(12, "2026-04-26", "2026-04-26"), 12);
    assert.equal(historyWindowDivisor(12, "2026-04-26", "2026-06-29"), 3);
    assert.equal(historyWindowDivisor(12, "2026-04-26", "2026-07-15"), 1);
    assert.equal(historyWindowDivisor(12, "2026-04-26", "2026-07-20"), 1);
    assert.equal(historyWindowDivisor(12, "2026-04-26", "2026-07-25"), 1);
    assert.equal(historyWindowDivisor(4, "2026-06-21", "2026-06-29"), 3);
    assert.equal(historyWindowDivisor(1, "2026-07-19", null), 1);
    assert.equal(historyWindowDivisor(0, "2026-04-26", null), 1);
    assert.equal(fullWindowWeeklyAverage("1200.0000", 12, "2026-04-26", "2026-06-29"), "400.0000");
    assert.equal(fullWindowWeeklyAverage("1200.0000", 12, "2026-04-26", null), "100.0000");
    console.log("history window divisor passed: full window, clamped start, young org, floor of 1");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
