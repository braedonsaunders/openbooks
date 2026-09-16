import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const budgets = read("./tools-budgets.ts");
const application = read("../application/budgets.ts");
const catalog = read("../application/tool-catalog.ts");

// The workspace read reuses the page loader (same numbers as /budgets); the
// page itself applies no subsidiary scoping, so neither does the tool.
test("budget workspace read reuses the page loader with the page gate", () => {
  assert.match(budgets, /name: "get_budget_workspace"/);
  assert.match(budgets, /loadBudgetWorkspace\(/);
  assert.match(budgets, /perms: \["budgets\.read"\]/);
  assert.match(budgets, /feature: "budgets"/);
  assert.doesNotMatch(budgets, /subsidiaryVisibleFilter/);
  assert.match(budgets, /revision/);
});

// Budget-line writes terminate in saveBudgetCells — never direct
// budget_lines SQL — with the route's subsidiary checks and the service's
// revision concurrency carried into the application layer.
test("budget-line writes reuse saveBudgetCells with route-parity guards", () => {
  assert.match(application, /saveBudgetCells\(/);
  assert.doesNotMatch(application, /insert into budget_lines/);
  assert.match(application, /assertApplicationPermission\(context, "budgets\.manage"\)/);
  assert.match(application, /isFeatureEnabled\(.*?"budgets"\)/);
  assert.match(application, /assertSubsidiaryAccess\(/);
  assert.match(application, /BudgetMutationError/);
  assert.match(application, /executeIdempotent\(/);
  assert.ok(catalog.includes('name: "update_budget_cells"'), "catalog must register update_budget_cells");
  const block = catalog.slice(catalog.indexOf('name: "update_budget_cells"'));
  assert.match(block, /featureKey: "budgets"/);
  assert.match(block, /assistantConfirmation: "always"/);
  assert.match(block, /idempotencyKey: IDEMPOTENCY_KEY/);
  assert.match(block, /budgets\.manage/);
});
