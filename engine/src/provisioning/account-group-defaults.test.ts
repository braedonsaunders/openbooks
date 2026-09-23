import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ACCOUNT_GROUPS,
  DEFAULT_BURDEN_GROUPS,
  DEFAULT_COST_POOL_GROUPS,
} from "@openbooks/schema";

/**
 * The default account groups are tenant-facing classification policy: True
 * Cost excludes `direct_labor` from burden on the strength of one regex, so
 * a refactor that silently changes what it matches rewrites every tenant's
 * True Cost results. These pins hold the contract, not the implementation.
 */

test("default groups ship five cost pools and eight burden categories", () => {
  assert.deepEqual(
    DEFAULT_COST_POOL_GROUPS.map((group) => group.key),
    ["direct_cost", "direct_labor", "overhead", "g_and_a", "other"],
  );
  assert.deepEqual(
    DEFAULT_BURDEN_GROUPS.map((group) => group.key),
    [
      "facilities",
      "admin_wages",
      "insurance",
      "it_software",
      "fleet_equipment",
      "professional",
      "people_safety",
      "financial",
    ],
  );
  assert.equal(DEFAULT_ACCOUNT_GROUPS.length, 13);
});

test("exactly one catch-all exists, on cost_pool.other; burden has none", () => {
  const catchAlls = DEFAULT_ACCOUNT_GROUPS.filter((group) => group.isCatchAll);
  assert.deepEqual(
    catchAlls.map((group) => `${group.dimension}.${group.key}`),
    ["cost_pool.other"],
  );
  assert.deepEqual(
    DEFAULT_ACCOUNT_GROUPS.find((group) => group.key === "other")?.match,
    {},
    "an empty rule never matches (see matchesRule), so the catch-all claims only leftovers",
  );
});

test("keys and sort orders are unique within each dimension", () => {
  for (const groups of [DEFAULT_COST_POOL_GROUPS, DEFAULT_BURDEN_GROUPS]) {
    assert.equal(new Set(groups.map((group) => group.key)).size, groups.length);
    assert.equal(new Set(groups.map((group) => group.sortOrder)).size, groups.length);
    assert.deepEqual(
      [...groups].sort((a, b) => a.sortOrder - b.sortOrder).map((group) => group.key),
      groups.map((group) => group.key),
      "seed order follows sort order, the rule-match precedence",
    );
  }
});

test("every seeded name pattern compiles", () => {
  for (const group of DEFAULT_ACCOUNT_GROUPS) {
    if (group.match.namePattern) {
      assert.doesNotThrow(
        () => new RegExp(group.match.namePattern as string, "i"),
        `${group.dimension}.${group.key} pattern must compile`,
      );
    }
  }
});

test("the direct_labor pattern matches labour accounts, not wagering", () => {
  // The source literal is single-backslash \b word boundaries; new
  // RegExp(pattern, "i") is exactly how the classifier runs it.
  const pattern = DEFAULT_COST_POOL_GROUPS.find((group) => group.key === "direct_labor")?.match
    .namePattern;
  assert.ok(pattern);
  const re = new RegExp(pattern, "i");
  for (const name of ["Wages", "Factory Payroll", "Salary expense", "Crew labor", "Salaries"]) {
    assert.ok(re.test(name), `${name} must classify as direct labor`);
  }
  // "Wagering" contains "wager", not the word "wage": the trailing boundary
  // must hold, or a casino account reads as direct labour.
  assert.ok(!re.test("Wagering"), "Wagering must not classify as direct labor");
  assert.ok(!re.test("Wager"), "Wager must not classify as direct labor");
});
