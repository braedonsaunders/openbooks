import assert from "node:assert/strict";
import { test } from "node:test";
import { auditSkips } from "./assert-skip-budget.mjs";

// Shapes copied from real CI database-shard logs (node's spec reporter).
const run = (lines, { skipped, todo = 0 }) =>
  [...lines, `ℹ tests 300`, `ℹ pass ${300 - skipped - todo}`, `ℹ fail 0`, `ℹ skipped ${skipped}`, `ℹ todo ${todo}`].join("\n");
const dated = "﹣ a committed December run settles the year (1.458404ms) # annual settlement needs a December 2026 pay period to have begun";
const wiring = "﹣ posts a journal entry (0.2ms) # OPENBOOKS_DB_URL is not set";
const entry = {
  budget: 0,
  reason: "the partition has a database",
  declared: { "annual settlement needs a December 2026 pay period to have begun": "wall-clock gate" },
};

test("a declared skip passes a zero budget and is still named", () => {
  const result = auditSkips(run([dated], { skipped: 1 }), entry, "database");
  assert.equal(result.ok, true);
  assert.match(result.lines.join("\n"), /skipped \(declared\): a committed December run/);
  assert.match(result.lines.at(-1), /1 declared, 0 undeclared of a permitted 0/);
});

test("an undeclared skip cannot hide behind a declared one", () => {
  const result = auditSkips(run([dated, wiring], { skipped: 2 }), entry, "database");
  assert.equal(result.ok, false);
  const text = result.lines.join("\n");
  assert.match(text, /skipped 1 undeclared test\(s\); the declared budget is 0/);
  assert.match(text, /posts a journal entry # OPENBOOKS_DB_URL is not set/);
  assert.doesNotMatch(text, /a committed December run/, "only the undeclared skip is charged");
});

test("undeclared skips within a non-zero budget pass, marked as such", () => {
  const result = auditSkips(run([wiring], { skipped: 1 }), { budget: 2, reason: "capability gates" }, "unit");
  assert.equal(result.ok, true);
  assert.match(result.lines.join("\n"), /skipped \(within budget\): posts a journal entry/);
});

test("a summary that counts more skips than the reporter names fails closed", () => {
  const result = auditSkips(run([dated], { skipped: 2 }), entry, "database");
  assert.equal(result.ok, false);
  assert.match(result.lines[0], /counts 2 skip\(s\) and 0 todo\(s\) but names 1/);
});

test("todo tests carry the same mark, are counted, and are budgeted like skips", () => {
  const todo = "﹣ reconciles a partial refund (0.1ms) # TODO";
  const counted = auditSkips(run([dated, todo], { skipped: 1, todo: 1 }), entry, "database");
  assert.equal(counted.ok, false, "an undeclared todo is an unrun control");
  assert.match(counted.lines.join("\n"), /reconciles a partial refund # TODO/);
  const withBudget = auditSkips(run([dated, todo], { skipped: 1, todo: 1 }), { ...entry, budget: 1 }, "database");
  assert.equal(withBudget.ok, true);
});

test("a log with no skip summary cannot report success", () => {
  const result = auditSkips("✔ something passed (1ms)\n", entry, "database", "coverage.txt");
  assert.equal(result.ok, false);
  assert.match(result.lines[0], /no skip summary found in coverage\.txt/);
});

test("summaries from several runs in one log are summed", () => {
  const log = [run([dated], { skipped: 1 }), run([], { skipped: 0 })].join("\n");
  assert.equal(auditSkips(log, entry, "database").ok, true);
});
