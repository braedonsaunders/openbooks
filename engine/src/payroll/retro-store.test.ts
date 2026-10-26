import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { detectRetroCandidates } from "./retro-store.ts";

test("retro candidate registry projects each registered earning source and its reason", async () => {
  const sourceRow = {
    employee_party_id: "00000000-0000-4000-8000-000000000001",
    employee_name: "Registry Worker",
    source_document_id: "00000000-0000-4000-8000-000000000002",
    source_document_number: "PAY-2026-001",
    pay_schedule_id: "00000000-0000-4000-8000-000000000003",
    pay_schedule_name: "Weekly",
    period_start: "2026-01-05",
    period_end: "2026-01-11",
    pay_date: "2026-01-14",
    tax_year: 2026,
    wage_detail: "wage 33 per hour effective 2026-01-01",
    component_detail: "Shift premium effective 2026-01-01",
    compensation_package_detail: "OPERATIONS version 2 effective 2026-01-01",
    union_fringe_detail: "HEALTH 3 per_hour_worked for classification all",
    derived_earning_detail: "NIGHT effective 2026-01-01",
    benefit_election_detail: "HEALTH/cash-premium election effective 2026-01-01",
    unclaimed_hours: "2.0000",
  };
  const queries: string[] = [];
  const dialect = new PgDialect();
  const executor = {
    execute: async (query: SQL, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      const compiled = dialect.sqlToQuery(query);
      queries.push(compiled.sql);
      return inMode({
        rows: compiled.sql.trimStart().startsWith("select s.employee_party_id") ? [sourceRow] : [],
      });
    },
  };

  const candidates = await detectRetroCandidates({
    orgId: "00000000-0000-4000-8000-000000000004",
    taxYear: 2026,
    allowedSubsidiaryIds: null,
    executor: executor as never,
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(
    candidates[0]?.reasons.map((reason) => reason.source),
    [
      "wage_rate",
      "pay_component",
      "compensation_package",
      "union_fringe",
      "derived_earning_rule",
      "benefit_election",
      "unclaimed_time",
    ],
  );
  const detectionQuery = queries.find((query) => query.includes("from pay_stubs s")) ?? "";
  for (const table of [
    "labor_cost_rates",
    "employee_pay_components",
    "payroll_compensation_assignments",
    "union_fringes",
    "pay_derived_rules",
    "hrm_benefit_enrollments",
    "time_entries",
  ]) {
    assert.ok(
      detectionQuery.includes(table),
      `${table} must be represented by the source registry`,
    );
  }
});
