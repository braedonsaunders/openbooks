import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Budgets, forecasts and allocations. Budget data is dimensional like the
 * ledger (account × period × book × dims) so budget-vs-actual is a single
 * symmetric query — not a bolted-on report.
 */

export const budgetScenarios = pgTable("budget_scenarios", {
  id: id(),
  orgId: orgRef(),
  bookId: uuid("book_id").notNull(),
  fiscalYear: integer("fiscal_year").notNull(),
  name: text("name").notNull(), // "FY27 Board Approved", "FY27 Reforecast Q2"
  kind: text("kind", { enum: ["budget", "forecast"] }).notNull().default("budget"),
  status: text("status", { enum: ["draft", "approved", "archived"] }).notNull().default("draft"),
  ...auditColumns,
});

export const budgetLines = pgTable(
  "budget_lines",
  {
    id: id(),
    orgId: orgRef(),
    scenarioId: uuid("scenario_id").notNull(),
    accountId: uuid("account_id").notNull(),
    periodId: uuid("period_id").notNull(),
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    amount: money("amount").notNull(),
    note: text("note"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("budget_lines_cell").on(
      t.scenarioId, t.accountId, t.periodId, t.departmentId, t.projectId, t.locationId, t.classId,
    ),
    index("budget_lines_scenario").on(t.scenarioId),
  ],
);

/**
 * Allocation rules: sweep source balances to targets on a basis —
 * fixed percentages, statistical quantities (journal_lines.quantity, e.g.
 * headcount or hours), or proportional to another account's activity.
 * Runs post origin='allocation' journals; reversible like everything else.
 */
export const allocationRules = pgTable("allocation_rules", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(),
  /** Source pool filter: accounts + optional dimensions. */
  source: jsonb("source").notNull().default({}),
  basis: text("basis", { enum: ["fixed_percent", "statistical_quantity", "proportional_activity"] }).notNull(),
  /** Basis config: e.g. statistical unit, or the driver account set. */
  basisConfig: jsonb("basis_config").notNull().default({}),
  offsetAccountId: uuid("offset_account_id").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

export const allocationRuleTargets = pgTable(
  "allocation_rule_targets",
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid("rule_id").notNull(),
    targetAccountId: uuid("target_account_id").notNull(),
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    fixedPercent: money("fixed_percent"), // for fixed_percent basis
    ...auditColumns,
  },
  (t) => [index("alloc_targets_rule").on(t.ruleId)],
);

export const allocationRuns = pgTable(
  "allocation_runs",
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid("rule_id").notNull(),
    periodId: uuid("period_id").notNull(),
    status: text("status", { enum: ["computed", "posted", "reversed"] }).notNull(),
    totalAllocated: money("total_allocated").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    /** Snapshot of the computation for auditability. */
    computation: jsonb("computation").notNull().default({}),
    ...auditColumns,
  },
  (t) => [index("alloc_runs_rule_period").on(t.ruleId, t.periodId)],
);
