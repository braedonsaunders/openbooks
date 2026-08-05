import { sql } from "drizzle-orm";
import { boolean, check, date, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Labor cost rates — the ONE table behind labor costing (see the labor-vs-
 * overhead doctrine: wage is real GL job cost; the estimated statutory burden
 * components live in org settings as calculator inputs, NOT here; overhead is
 * the separate statistical layer).
 *
 * A row is an effective-dated standard WAGE for a scope. Scope keys are
 * nullable and resolve most-specific-wins:
 *   employee > job title > trade > department > subsidiary > org default.
 * Within a scope the latest effectiveFrom ≤ workedOn wins; effectiveTo is an
 * optional hard end. basis=year divides by annualHours (default 2080).
 *
 * The resolved wage × time-type multiplier + configured estimate components
 * (orgs.settings.laborCosting) is snapshotted into time_entries.cost_rate at
 * approval — after which the entry is self-contained forever.
 */
export const laborCostRates = pgTable(
  "labor_cost_rates",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id"),
    jobTitle: text("job_title"),
    tradeId: uuid("trade_id"),
    departmentId: uuid("department_id"),
    subsidiaryId: uuid("subsidiary_id"),
    /** Denomination of the wage; converted to subsidiary functional currency. */
    currency: currencyCode("currency").notNull(),
    rate: money("rate").notNull(),
    basis: text("basis", { enum: ["hour", "year"] }).notNull().default("hour"),
    /** Divisor for basis=year (2080 = 40h × 52w). */
    annualHours: money("annual_hours").notNull().default("2080"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("labor_cost_rates_employee").on(t.orgId, t.employeePartyId, t.effectiveFrom),
    index("labor_cost_rates_job_title").on(t.orgId, t.jobTitle, t.effectiveFrom),
    index("labor_cost_rates_trade").on(t.orgId, t.tradeId, t.effectiveFrom),
    index("labor_cost_rates_department").on(t.orgId, t.departmentId, t.effectiveFrom),
    index("labor_cost_rates_subsidiary").on(t.orgId, t.subsidiaryId, t.effectiveFrom),
    // One row per scope per start date (coalesced scope keys in the SQL migration).
    uniqueIndex("labor_cost_rates_scope_from").on(
      t.orgId,
      t.employeePartyId,
      t.jobTitle,
      t.tradeId,
      t.departmentId,
      t.subsidiaryId,
      t.effectiveFrom,
    ),
    check("labor_cost_rates_nonnegative", sql`${t.rate} >= 0`),
    check("labor_cost_rates_annual_hours", sql`${t.annualHours} > 0`),
    check("labor_cost_rates_valid_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    // Exactly zero or one scope key: zero is the organization default.
    check(
      "labor_cost_rates_one_scope",
      sql`num_nonnulls(${t.employeePartyId}, ${t.jobTitle}, ${t.tradeId}, ${t.departmentId}, ${t.subsidiaryId}) <= 1`,
    ),
  ],
);

// Foreign keys are maintained in schema/migrations/referential-integrity.sql.
