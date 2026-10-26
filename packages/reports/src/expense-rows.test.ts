import assert from "node:assert/strict";
import test from "node:test";
import { compileCustomQuery, type ReportExpenseAccess } from "./custom-query";
import { payrollRestrictedEntity } from "./confidential-entities";
import { REPORT_ENTITIES, REPORT_ENTITY_MAP } from "./entities";

// Expense report rows reach a report reader only through their expense
// authority: every report with expenses.read, their own with expenses.self,
// none otherwise. reports.read alone reads none.
const ORG = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE = "00000000-0000-4000-8000-0000000000e1";

function rows(entityKey: string, access?: ReportExpenseAccess) {
  const entity = REPORT_ENTITY_MAP[entityKey]!;
  return compileCustomQuery(
    entity,
    { entity: entityKey, mode: "rows", columns: ["document_number"], filters: null, limit: 10 },
    ORG,
    access ? { expenseAccess: access } : {},
  );
}

test("every document-backed entity that can return expense reports declares its expense rows", () => {
  for (const key of ["documents", "transaction_lines", "inventory_lot_movements"]) {
    const entity = REPORT_ENTITY_MAP[key]!;
    assert.ok(entity.expenseRows, `${key} declares expense rows`);
    for (const column of [entity.expenseRows.kindColumn, entity.expenseRows.employeeColumn]) {
      assert.ok(
        entity.columns.some((entry) => entry.key === column),
        `${key} carries ${column}`,
      );
    }
  }
  // Any entity reading documents without pinning a kind must declare them.
  for (const entity of REPORT_ENTITIES) {
    if (!/\bdocuments d\b/.test(entity.from) || entity.expenseRows) continue;
    const pinned =
      /d\.kind\s*(=|IN)\s*/i.test(entity.from) ||
      JSON.stringify(entity.baseFilter ?? {}).length > 2 ||
      Boolean(entity.requiredPermission);
    assert.ok(pinned, `${entity.key} reads documents without an expense row policy`);
  }
});

test("reports.read alone reads no expense report rows, on every compiled path", () => {
  for (const access of [
    undefined,
    { scope: "none" as const },
    { scope: "own" as const, partyId: null },
  ]) {
    const compiled = rows("documents", access);
    assert.match(compiled.text, /\(d\.kind IS DISTINCT FROM \$\d+\)/);
    assert.ok(compiled.values.includes("expense_report"));
  }
  const lines = compileCustomQuery(
    REPORT_ENTITY_MAP.transaction_lines!,
    {
      entity: "transaction_lines",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "kind" }],
      measures: [{ fn: "count" }],
      filters: null,
      limit: 10,
    },
    ORG,
    { expenseAccess: { scope: "none" } },
  );
  assert.match(lines.text, /d\.kind IS DISTINCT FROM/, "summaries are clamped too");
});

test("a self-service reader reads their own expense reports and every other kind", () => {
  const compiled = rows("documents", { scope: "own", partyId: EMPLOYEE });
  assert.match(
    compiled.text,
    /\(d\.kind IS DISTINCT FROM \$(\d+) OR d\.party_id = \$(\d+)::uuid\)/,
  );
  assert.ok(compiled.values.includes(EMPLOYEE));
});

test("an org-wide expense reader is not clamped", () => {
  const compiled = rows("documents", { scope: "all" });
  assert.doesNotMatch(compiled.text, /IS DISTINCT FROM/);
  assert.ok(!compiled.values.includes("expense_report"));
});

test("the clamp survives the payroll-restricted reading of transaction lines", () => {
  const restricted = payrollRestrictedEntity(REPORT_ENTITY_MAP.transaction_lines!, false);
  const compiled = compileCustomQuery(
    restricted,
    {
      entity: "transaction_lines",
      mode: "rows",
      columns: ["document_number"],
      filters: null,
      limit: 10,
    },
    ORG,
    { expenseAccess: { scope: "own", partyId: EMPLOYEE } },
  );
  assert.match(compiled.text, /rc\."kind" IS DISTINCT FROM \$\d+ OR rc\."party_id" = \$\d+::uuid/);
  assert.match(restricted.from, /NULL AS "party_id"/, "collapsed payroll legs carry no party");
});
