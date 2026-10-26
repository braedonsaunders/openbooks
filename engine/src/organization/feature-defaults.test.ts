import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../platform/db.ts";
import { dataDependentRequirementsOf, withDataDependentDefaults } from "./feature-defaults.ts";
import { FEATURE_BY_KEY, featureEnabled } from "./feature-registry.ts";

/** The subsidiary-count probe answered as a database would; anything else fails the test. */
function subsidiaryCountRunner(active: number): SqlExecutor & { calls: number } {
  const runner = {
    calls: 0,
    async execute(_query: unknown, mode?: string) {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      runner.calls += 1;
      return inMode({ rows: [{ n: active }] });
    },
  };
  return runner as unknown as SqlExecutor & { calls: number };
}

const ORG = "00000000-0000-4000-8000-000000000001";

test("intercompany capabilities are opt-in children of Multi-subsidiary", () => {
  for (const key of [
    "intercompanyTransactions",
    "intercompanyNetting",
    "crossSubsidiaryFulfillment",
  ]) {
    const def = FEATURE_BY_KEY.get(key);
    assert.ok(def, `${key} must be registered before its routes gate on it`);
    assert.equal(def.defaultEnabled, false);
    assert.equal(def.parentKey, "multiSubsidiary");
    assert.equal(def.category, "finance");
  }
  assert.deepEqual(FEATURE_BY_KEY.get("crossSubsidiaryFulfillment")!.requiresAll, [
    "intercompanyTransactions",
    "inventory",
    "orders",
  ]);
});

test("a feature's requirement chain names the data-dependent features it reaches", () => {
  assert.deepEqual(dataDependentRequirementsOf("crossSubsidiaryFulfillment"), ["multiSubsidiary"]);
  assert.deepEqual(dataDependentRequirementsOf("intercompanyNetting"), ["multiSubsidiary"]);
  assert.deepEqual(dataDependentRequirementsOf("multiCurrency"), ["multiCurrency"]);
  assert.deepEqual(dataDependentRequirementsOf("banking"), []);
});

test("a child of Multi-subsidiary follows the org's data when the parent flag was never stored", async () => {
  const stored = { intercompanyTransactions: true };
  // Without the overlay the pure check reads the parent's static default.
  assert.equal(featureEnabled(stored, "intercompanyTransactions"), false);
  const multiEntity = subsidiaryCountRunner(2);
  assert.equal(
    featureEnabled(
      await withDataDependentDefaults(multiEntity, ORG, stored, ["intercompanyTransactions"]),
      "intercompanyTransactions",
    ),
    true,
  );
  const singleEntity = subsidiaryCountRunner(1);
  assert.equal(
    featureEnabled(
      await withDataDependentDefaults(singleEntity, ORG, stored, ["intercompanyTransactions"]),
      "intercompanyTransactions",
    ),
    false,
  );
});

test("a stored parent flag always wins and is never probed", async () => {
  const runner = subsidiaryCountRunner(5);
  const resolved = await withDataDependentDefaults(
    runner,
    ORG,
    { multiSubsidiary: false, intercompanyNetting: true },
    ["intercompanyNetting"],
  );
  assert.equal(runner.calls, 0);
  assert.equal(featureEnabled(resolved, "intercompanyNetting"), false);
});

test("features that reach no data-dependent parent are resolved without a probe", async () => {
  const runner = subsidiaryCountRunner(5);
  const resolved = await withDataDependentDefaults(runner, ORG, { banking: true }, ["banking"]);
  assert.equal(runner.calls, 0);
  assert.deepEqual(resolved, { banking: true });
});
