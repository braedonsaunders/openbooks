import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Parallel run: reconciling a prior payroll provider against this one, penny
 * by penny, for the same period and the same people.
 *
 * Nobody adopts a payroll system without running it beside the outgoing one
 * for a period or two and proving every number. Today that is a spreadsheet,
 * which means it is unreviewable, unrepeatable, and quietly tolerant of the
 * one thing it exists to catch. This is that exercise as a first-class,
 * evidenced capability.
 *
 * Country-agnostic by construction. Nothing here names a jurisdiction, a
 * statutory kind, or a provider: the imported register is (employee, period,
 * slot, amount) where a SLOT is one of this org's own `pay_components`
 * identified by its code, and the prior provider's column names are mapped
 * onto those slots by the generic import wizard. A pack that adds a component
 * adds a comparable slot with no change here.
 *
 * Three tables carry what the old system said:
 *
 *  - `payroll_prior_registers` — one imported register: the provider, the
 *    period it covers, where the file came from, and — load-bearing — the
 *    source columns nobody mapped. An amount nobody mapped is exactly the
 *    kind of thing that hides a real difference, so it is recorded as
 *    evidence rather than dropped on the wizard floor.
 *  - `payroll_prior_stubs` — per employee, the prior system's OWN stated
 *    gross, net and employer cost. These are stored separately from the sum
 *    of the mapped components on purpose: the comparison proves the two agree,
 *    which is how an unmapped or mis-mapped amount surfaces even when nobody
 *    read the import screen.
 *  - `payroll_prior_amounts` — one row per employee per slot, carrying the
 *    ORIGINATING COLUMN NAME so a difference can be traced back to the cell
 *    in the operator's file.
 *
 * Two carry the reconciliation. It is materialized rather than computed live
 * because a parallel run is audit evidence: who compared what, against which
 * run, under which tolerances, and what it said. The classification itself has
 * exactly one home — `engine/src/payroll-parallel-run.ts` — and these rows are
 * its persisted output, which is also what the report renders. No second
 * implementation in SQL.
 *
 *  - `payroll_parallel_comparisons` — the header: which register against which
 *    pay run, the outcome, the totals reconciliation, and the tolerances that
 *    were in force. A tolerance that is not disclosed alongside the result
 *    would defeat the entire exercise, so the effective tolerance set is
 *    snapshotted onto the row.
 *  - `payroll_parallel_findings` — one row per (employee, slot): theirs, ours,
 *    the difference, and the classification. Employees present on only one
 *    side get rows here too, under their own classification — never dropped.
 *
 * And one configures it:
 *
 *  - `payroll_parallel_tolerances` — an optional per-slot allowance, because
 *    some prior systems round a percentage differently. DEFAULT ZERO, always:
 *    the absence of a row means exact. Each row must carry a reason, since a
 *    tolerance is a deliberate decision to stop looking at something.
 */

/**
 * One imported prior-provider register for one period.
 *
 * `unmapped_columns` is the honesty record: the columns present in the source
 * file that no target slot claimed, with the count of rows in which each
 * carried a value. The comparison surfaces them prominently; an operator who
 * forgot to map "RRSP Employee" learns it from the reconciliation, not from a
 * variance they cannot explain six weeks later.
 */
export const payrollPriorRegisters = pgTable(
  "payroll_prior_registers",
  {
    id: id(),
    orgId: orgRef(),
    /** Operator's label for this import, e.g. "Prior provider — Jul 14 2026". */
    name: text("name").notNull(),
    /** Free text. Deliberately not an enum: any provider, any country. */
    providerName: text("provider_name"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** The date the old system paid. This is what a register is filed under. */
    payDate: date("pay_date").notNull(),
    currencyCode: currencyCode("currency_code"),
    sourceFileName: text("source_file_name"),
    /** [{ column, valuedRows }] — source columns no slot claimed. */
    unmappedColumns: jsonb("unmapped_columns").notNull().default(sql`'[]'::jsonb`),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_prior_registers_org_name").on(t.orgId, t.name),
    index("payroll_prior_registers_period").on(t.orgId, t.periodEnd, t.payDate),
    check("payroll_prior_registers_period_order", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

/**
 * One employee's prior-system result for the register's period.
 *
 * `gross`/`net_pay`/`employer_cost` are the OLD system's stated totals, not a
 * sum of the rows in `payroll_prior_amounts`. Keeping both and reconciling
 * them is the structural guard against an unmapped amount column.
 *
 * `employee_label` preserves whatever the file called the person (payroll
 * number, code, name), because a resolution that later looks wrong has to be
 * auditable against the source.
 */
export const payrollPriorStubs = pgTable(
  "payroll_prior_stubs",
  {
    id: id(),
    orgId: orgRef(),
    registerId: uuid("register_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    employeeLabel: text("employee_label").notNull(),
    /** Nullable: a register that states no total states none, rather than 0. */
    gross: money("gross"),
    netPay: money("net_pay"),
    employerCost: money("employer_cost"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_prior_stubs_register_employee").on(t.registerId, t.employeePartyId),
    index("payroll_prior_stubs_org_employee").on(t.orgId, t.employeePartyId),
  ],
);

/**
 * One prior-system amount, against one comparable slot.
 *
 * `slot` is the stable comparison key: a `pay_components.system_key` where the
 * component is pack-declared (statutory and engine-derived amounts), otherwise
 * `code:<pay_components.code>` for a user component. `kind` is required to
 * disambiguate — an employee CPP deduction and the employer CPP contribution
 * share one system key.
 */
export const payrollPriorAmounts = pgTable(
  "payroll_prior_amounts",
  {
    id: id(),
    orgId: orgRef(),
    priorStubId: uuid("prior_stub_id").notNull(),
    /** Resolved component, when the slot still exists. Null tolerated so a
     *  historical register survives a component being retired. */
    componentId: uuid("component_id"),
    kind: text("kind", {
      enum: ["earning", "deduction", "employer_contribution"],
    }).notNull(),
    slot: text("slot").notNull(),
    /** Column header in the operator's file — the audit trail to the cell. */
    sourceColumn: text("source_column"),
    amount: money("amount").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_prior_amounts_stub_slot").on(t.priorStubId, t.kind, t.slot),
    index("payroll_prior_amounts_org_slot").on(t.orgId, t.slot),
  ],
);

/**
 * Per-slot tolerance. Absent = exact, which is the default for every slot.
 *
 * A tolerance is an amount, never a percentage: "this provider rounds its
 * health premium to the cent differently" is one cent, and expressing it as a
 * percentage of a moving base is how a tolerance quietly grows. `reason` is
 * NOT NULL because agreeing to stop looking at a difference is a decision that
 * has to be attributable.
 */
export const payrollParallelTolerances = pgTable(
  "payroll_parallel_tolerances",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", {
      enum: ["earning", "deduction", "employer_contribution", "total"],
    }).notNull(),
    /** Slot key, or a reserved total key (`gross`, `net_pay`, `employer_cost`). */
    slot: text("slot").notNull(),
    /** Absolute per-employee allowance. Non-negative; 0 means exact. */
    tolerance: money("tolerance").notNull().default("0"),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_parallel_tolerances_org_slot").on(t.orgId, t.kind, t.slot),
    check("payroll_parallel_tolerances_nonnegative", sql`${t.tolerance} >= 0`),
  ],
);

/**
 * One reconciliation: a register against a pay run.
 *
 * `status` can never be a clean result produced by an absence. `no_comparable_data`
 * is a distinct outcome for "one side was empty or the populations did not
 * intersect", so an operator cannot read a green screen off a failed import.
 *
 * `tolerances_applied` snapshots the tolerance set that was in force. Reading
 * the result without it is not possible.
 */
export const payrollParallelComparisons = pgTable(
  "payroll_parallel_comparisons",
  {
    id: id(),
    orgId: orgRef(),
    registerId: uuid("register_id").notNull(),
    payRunDocumentId: uuid("pay_run_document_id").notNull(),
    /** clean | clean_within_tolerance | differences | no_comparable_data */
    status: text("status", {
      enum: ["clean", "clean_within_tolerance", "differences", "no_comparable_data"],
    }).notNull(),
    /** Populations, so a reader never has to infer them from a row count. */
    priorEmployeeCount: integer("prior_employee_count").notNull().default(0),
    ourEmployeeCount: integer("our_employee_count").notNull().default(0),
    comparedEmployeeCount: integer("compared_employee_count").notNull().default(0),
    priorOnlyEmployeeCount: integer("prior_only_employee_count").notNull().default(0),
    ourOnlyEmployeeCount: integer("our_only_employee_count").notNull().default(0),
    matchCount: integer("match_count").notNull().default(0),
    withinToleranceCount: integer("within_tolerance_count").notNull().default(0),
    differenceCount: integer("difference_count").notNull().default(0),
    oneSidedCount: integer("one_sided_count").notNull().default(0),
    /** Stated-total reconciliation, both sides plus the difference. */
    priorGross: money("prior_gross").notNull().default("0"),
    ourGross: money("our_gross").notNull().default("0"),
    priorNet: money("prior_net").notNull().default("0"),
    ourNet: money("our_net").notNull().default("0"),
    priorEmployerCost: money("prior_employer_cost").notNull().default("0"),
    ourEmployerCost: money("our_employer_cost").notNull().default("0"),
    /** Total difference the per-slot findings do NOT account for. Non-zero is
     *  itself a finding: something moved a total without a comparable slot. */
    unattributedGross: money("unattributed_gross").notNull().default("0"),
    unattributedNet: money("unattributed_net").notNull().default("0"),
    unattributedEmployerCost: money("unattributed_employer_cost").notNull().default("0"),
    /** [{ kind, slot, tolerance, reason }] in force when this ran. */
    tolerancesApplied: jsonb("tolerances_applied").notNull().default(sql`'[]'::jsonb`),
    /** Source columns nobody mapped, carried onto the result so the report
     *  states them — a warning only the import screen showed is not a control. */
    unmappedColumns: jsonb("unmapped_columns").notNull().default(sql`'[]'::jsonb`),
    /** Why the comparison could not compare, when status is no_comparable_data. */
    blockedReason: text("blocked_reason"),
    comparedAt: timestamp("compared_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    index("payroll_parallel_comparisons_org_run").on(t.orgId, t.payRunDocumentId),
    index("payroll_parallel_comparisons_register").on(t.orgId, t.registerId, t.comparedAt),
  ],
);

/**
 * One (employee, slot) cell of the reconciliation.
 *
 * `classification` distinguishes a real match from an absence:
 *  - `match`              — both sides present and equal to the penny.
 *  - `within_tolerance`   — both present, unequal, inside a DISCLOSED tolerance.
 *  - `difference`         — both present, unequal, outside any tolerance.
 *  - `prior_only`         — the old system had an amount here and we have none.
 *  - `our_only`           — we have an amount here and the old system had none.
 *  - `employee_prior_only`— the employee is absent from our run entirely.
 *  - `employee_our_only`  — the employee is absent from the register entirely.
 *  - `unattributed`       — a stated total that the slots do not explain.
 */
export const payrollParallelFindings = pgTable(
  "payroll_parallel_findings",
  {
    id: id(),
    orgId: orgRef(),
    comparisonId: uuid("comparison_id").notNull(),
    employeePartyId: uuid("employee_party_id"),
    employeeName: text("employee_name").notNull(),
    kind: text("kind", {
      enum: ["earning", "deduction", "employer_contribution", "total"],
    }).notNull(),
    slot: text("slot").notNull(),
    /** Human label for the slot at comparison time (component name). */
    slotLabel: text("slot_label").notNull(),
    classification: text("classification", {
      enum: [
        "match",
        "within_tolerance",
        "difference",
        "prior_only",
        "our_only",
        "employee_prior_only",
        "employee_our_only",
        "unattributed",
      ],
    }).notNull(),
    priorAmount: money("prior_amount"),
    ourAmount: money("our_amount"),
    /** prior − ours. Null only when neither side has an amount. */
    difference: money("difference"),
    /** Tolerance in force for this cell (0 unless configured). */
    toleranceApplied: money("tolerance_applied").notNull().default("0"),
    /** The operator's file column this came from, when there was one. */
    sourceColumn: text("source_column"),
    sequence: integer("sequence").notNull().default(100),
    ...auditColumns,
  },
  (t) => [
    index("payroll_parallel_findings_comparison").on(t.comparisonId, t.sequence),
    index("payroll_parallel_findings_class").on(t.orgId, t.comparisonId, t.classification),
    // A cell is one row. Repeating it would double-count a difference.
    // NULLS NOT DISTINCT: the population-level `unattributed` finding has
    // no employee. Without this, PostgreSQL treats every NULL employee key as
    // distinct and the same total cell can be written more than once.
    unique("payroll_parallel_findings_cell")
      .on(t.comparisonId, t.employeePartyId, t.kind, t.slot)
      .nullsNotDistinct(),
    check(
      "payroll_parallel_findings_difference_present",
      sql`(${t.priorAmount} is null and ${t.ourAmount} is null) or ${t.difference} is not null`,
    ),
  ],
);

/** Every table this module owns, in dependency order (create/drop/clone use). */
export const PAYROLL_PARALLEL_RUN_TABLES = [
  payrollPriorRegisters,
  payrollPriorStubs,
  payrollPriorAmounts,
  payrollParallelTolerances,
  payrollParallelComparisons,
  payrollParallelFindings,
] as const;
