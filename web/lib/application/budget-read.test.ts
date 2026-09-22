import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./budgets.ts", import.meta.url), "utf8");

test("budget reads reuse the hub loaders and name the Features page when off", () => {
  assert.match(SOURCE, /budgetScenarioOptions/);
  assert.match(SOURCE, /loadBudgetScenario/);
  assert.match(SOURCE, /GET \/api\/v1\/settings\/features/);
  assert.match(SOURCE, /assertApplicationPermission\(context, "budgets\.read"\)/);
});
