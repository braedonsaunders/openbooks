import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("./tools-expenses.ts");

/**
 * Source contract for the expense-report assistant tools: every tool carries
 * the `expenses.read` gate its route enforces and the `expenses` feature
 * declaration, detail reads reuse the drawer loader with the route's strict
 * subsidiary guard, and the approvals queue reuses the application worklist.
 * No expense tool writes.
 */
test("expense tools declare the right gates and features", () => {
  for (const tool of [
    "list_expense_reports",
    "get_expense_report",
    "expense_overview",
    "expense_approvals",
  ]) {
    const start = source.indexOf(`name: "${tool}"`);
    assert.ok(start >= 0, `${tool} is registered`);
    const window = source.slice(start, start + 600);
    assert.ok(window.includes('"expenses.read"'), `${tool} gates on expenses.read`);
    assert.ok(window.includes('feature: "expenses"'), `${tool} declares the expenses feature`);
  }
  assert.doesNotMatch(source, /category: "write"/, "expense tools are read-only");
});

test("expense reads reuse the screen loaders with the route boundaries", () => {
  assert.match(source, /loadExpenseReport\(a\.reportId, authz\.user\.orgId\)/);
  assert.match(source, /doc\.subsidiary_id == null \|\| !authz\.allowedSubsidiaryIds\.has\(/);
  assert.match(source, /expensesDashboard\(authz\.user\.orgId\)/);
  assert.match(source, /approvalWorklistForAuthz\(authz\)/);
});

test("expense approvals honor the hub doorway with an empty queue", () => {
  assert.match(source, /!can\(authz, "flows\.approve"\) && !can\(authz, "ap\.approve"\) && !can\(authz, "ar\.approve"\)/);
  assert.match(source, /item\.docKind !== "expense_report"/);
  assert.match(source, /item\.subjectKind !== "expense_report"/);
  assert.match(source, /expenses_feature_disabled/);
  assert.match(source, /expense_report_not_found/);
});

test("expense tools are exported and registered for the playbook", () => {
  assert.match(source, /export const EXPENSE_TOOLS: AssistantToolDef\[\]/);
  assert.ok(source.includes("expenseApprovals,\n];"));
});
