import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
 * Derived earnings rules (feature `payroll`).
 *
 * Construction payrolls pay real money that is DERIVED from operational facts
 * — per diem for nights stayed at a jobsite, on-call days, travel to the first
 * job of the day, site incentives on billable field time, monthly equipment
 * incentives. Today that money leaves the field app as a CSV, is re-typed into
 * payroll, and is then corrected by hand every week (deleting the incentive
 * from the PMs' stubs is a standing manual step). Each of those hand steps is
 * an unauditable adjustment to pay.
 *
 * Doctrine this table exists to satisfy:
 * - Rules emit INPUTS. A rule produces pay-component earning lines that feed
 *   the statutory engine exactly like time, recurring components, and
 *   pay_run_adjustments do. A rule can never edit a computed output — CPP/EI/
 *   tax always remain the engine's numbers for the money actually paid.
 * - Configuration, not code. A rule is a diffable, exportable, previewable
 *   row, so "who gets the site incentive" is reviewable evidence rather than a
 *   script only its author understands. (A scripted escape hatch, if it is
 *   ever needed, belongs in the Apps/Scripts module — not here.)
 * - Effective-dated, like every other rule that reinterprets history. Changing
 *   a per-diem rate must not silently restate what last quarter paid, so rules
 *   resolve against the pay period end exactly like employee_pay_components.
 *
 * The operational fact itself always lives in time_entries: the timesheet is
 * already the approved, job-tagged, org-isolated capture surface for what
 * happened in the field, and a second event table would be a parallel source
 * of truth for the same facts. Asserted events (on-call, a per-diem night the
 * crew claims) are entered as a flagged time type; inferable events (nights
 * stayed, derived from consecutive jobsite days) need no entry at all.
 */
export const payDerivedRules = pgTable(
  "pay_derived_rules",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** The earning component the rule emits; carries the GL account and the
     * statutory taxability flags the emitted line inherits. */
    componentId: uuid("component_id").notNull(),

    /**
     * What operational fact produces a payable unit.
     * - time_entry: every qualifying entry.
     * - distinct_day: one unit per day that has any qualifying entry (on-call).
     * - distinct_project_day: one unit per job per day (site incentives paid
     *   per job-day rather than per hour).
     * - night_stayed: one unit per night INFERRED from consecutive qualifying
     *   days; the night is credited to the later day (the morning after), so a
     *   period never depends on time that has not been approved yet.
     * - month_end: the qualifying facts of the calendar month that closed
     *   before this period, paid once on the first run after month end.
     * - equipment_charge: the SECOND fact source. Reads posted/approved
     *   project_charge document_lines for the settled month instead of time
     *   entries, so an operator can be paid on what the unit BILLED (or the
     *   units it produced) rather than on the hours he happened to book.
     *   month_end deliberately survives it: "$1.25 per equipment hour last
     *   month" is a real, cheaper policy that reads the timesheet.
     */
    trigger: text("trigger", {
      enum: [
        "time_entry",
        "distinct_day",
        "distinct_project_day",
        "night_stayed",
        "month_end",
        "equipment_charge",
      ],
    }).notNull(),

    // --- Filters: all nullable, all ANDed ------------------------------------
    // Entry-scope filters. departmentId matches the entry's department, or the
    // employee's when the entry carries none — field time is frequently tagged
    // to the job and not to the crew's home department.
    timeTypeId: uuid("time_type_id"),
    projectId: uuid("project_id"),
    departmentId: uuid("department_id"),
    // Charge-scope filters (equipment_charge only). A rule names ONE unit, or
    // the catalog item every unit of a class charges through — "all excavators"
    // has to be one reviewable row, not one row per machine, or the policy
    // stops being readable the moment the fleet changes.
    equipmentUnitId: uuid("equipment_unit_id"),
    itemId: uuid("item_id"),
    // Employee-scope filters (employee_roles).
    tradeId: uuid("trade_id"),
    /** Single-title shorthand for the simple case ("only the site clerk"). */
    jobTitle: text("job_title"),
    /** Only billable time qualifies (the usual test for "productive field time"). */
    billableOnly: boolean("billable_only").notNull().default(false),
    /**
     * Employee-scope inclusions and exclusions. THESE are the columns that kill
     * the weekly manual deletion: "supervisors and the quality coordinator get
     * the site incentive; project managers, the general manager, department
     * managers and health & safety do not" stops being a payroll clerk's memory
     * and becomes reviewable configuration.
     *
     * Empty inclusions mean everyone. A non-empty list narrows the rule to
     * exactly those titles. Exclusions always win — a title named in both is
     * excluded, because the safe failure for a money rule is not paying.
     *
     * Matching is case- and whitespace-insensitive: job titles are free text
     * typed by whoever set the employee up, and " project  manager " must not
     * be a different person from "Project Manager".
     */
    includedJobTitles: jsonb("included_job_titles")
      .notNull()
      .default(sql`'[]'::jsonb`),
    excludedJobTitles: jsonb("excluded_job_titles")
      .notNull()
      .default(sql`'[]'::jsonb`),

    /**
     * How many units the qualifying facts are worth.
     * - count / sum_hours / count_nights read time entries.
     * - sum_quantity sums the charge line's base_quantity (hours, loads,
     *   tonnes — whatever the unit actually charges in).
     * - sum_bill_amount sums the charge line's bill_amount, so the "unit" the
     *   rule counts is a DOLLAR of equipment revenue.
     */
    quantityMode: text("quantity_mode", {
      enum: [
        "count",
        "sum_hours",
        "count_nights",
        "sum_quantity",
        "sum_bill_amount",
      ],
    })
      .notNull()
      .default("count"),
    /**
     * How a unit is priced.
     * - fixed_per_unit: rateValue per unit ($70 a night, $75 a day, $1.25 an
     *   equipment hour).
     * - percent_of_gross: rateValue percent of the EMPLOYEE'S PAY so far,
     *   allocated across the units for job costing.
     * - percent_of_quantity: rateValue percent of the quantity itself — with
     *   sum_bill_amount that is a percent of EQUIPMENT REVENUE. Deliberately a
     *   separate mode from percent_of_gross rather than a reinterpretation of
     *   it: they are percentages of two different bases, one of them the
     *   operator's own wages and the other the customer's invoice, and a rule
     *   that silently swapped them would pay a wrong number that still looked
     *   plausible on a stub.
     * - rate_card: the per-unit rate comes from the pay component's own value,
     *   overridable per employee through employee_pay_components — wages have
     *   one home, and so does a component's rate.
     */
    rateMode: text("rate_mode", {
      enum: [
        "fixed_per_unit",
        "percent_of_gross",
        "percent_of_quantity",
        "rate_card",
      ],
    })
      .notNull()
      .default("fixed_per_unit"),
    rateValue: money("rate_value"),

    /**
     * Where the money is job costed.
     * - source: the project/department of the fact that produced the unit.
     * - first_project_of_day: the job the employee went to FIRST that day —
     *   travel pay is earned getting to that job and has to cost to it, not to
     *   whichever job the crew finished on.
     * - none: not job costed (org overhead).
     */
    costingMode: text("costing_mode", {
      enum: ["source", "first_project_of_day", "none"],
    })
      .notNull()
      .default("source"),

    /** Rules resolve against the pay period end, like employee_pay_components,
     * so re-rating a rule never restates a period that already paid. */
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    /** Emission order on the stub. Derived earnings land after time (10–40)
     * and before recurring components (100+), because percent-of-gross
     * components and vacation compute on them. */
    sequence: integer("sequence").notNull().default(50),
    isActive: boolean("is_active").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_derived_rules_org_code").on(t.orgId, t.code),
    index("pay_derived_rules_org_active").on(t.orgId, t.isActive, t.sequence),
    index("pay_derived_rules_component").on(t.orgId, t.componentId),
    check(
      "pay_derived_rules_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    // Nights are only defined for the night trigger; letting count_nights ride
    // a day trigger would quietly pay one unit per DAY at the nightly rate.
    check(
      "pay_derived_rules_nights",
      sql`${t.quantityMode} <> 'count_nights' or ${t.trigger} = 'night_stayed'`,
    ),
    // The two fact sources measure different things, and a quantity mode that
    // crossed them would still produce a number. sum_hours has no meaning on a
    // charge line (a charge carries base_quantity in loads or tonnes as often
    // as in hours), and sum_quantity/sum_bill_amount have none on a timesheet.
    check(
      "pay_derived_rules_charge_quantity",
      sql`case when ${t.trigger} = 'equipment_charge'
                then ${t.quantityMode} in ('count', 'sum_quantity', 'sum_bill_amount')
                else ${t.quantityMode} not in ('sum_quantity', 'sum_bill_amount')
           end`,
    ),
    // percent_of_quantity is a percent of the charge line's own measure; there
    // is no such measure on a time entry, and allowing it there would silently
    // read as percent_of_gross to anyone skimming the row.
    check(
      "pay_derived_rules_percent_quantity",
      sql`${t.rateMode} <> 'percent_of_quantity' or ${t.trigger} = 'equipment_charge'`,
    ),
    // Charge-scope filters belong to the charge trigger. Left on a time-entry
    // rule they would read as narrowing filters that in fact narrow nothing.
    check(
      "pay_derived_rules_charge_filters",
      sql`${t.trigger} = 'equipment_charge'
          or (${t.equipmentUnitId} is null and ${t.itemId} is null)`,
    ),
    // A priced rule needs a price. rate_card takes it from the component.
    check(
      "pay_derived_rules_rate",
      sql`${t.rateMode} = 'rate_card' or (${t.rateValue} is not null and ${t.rateValue} >= 0)`,
    ),
    check(
      "pay_derived_rules_title_lists",
      sql`jsonb_typeof(${t.includedJobTitles}) = 'array'
          and jsonb_typeof(${t.excludedJobTitles}) = 'array'`,
    ),
  ],
);

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
