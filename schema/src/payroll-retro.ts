import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Retroactive pay: paying, in the current period, the difference a backdated
 * change makes to periods that have ALREADY been paid.
 *
 * A union agreement settles in March with an increase effective the previous
 * 1 January; ten pay periods have gone out at the old rate. Somebody must work
 * out what each of those periods SHOULD have paid, pay the difference, tax it
 * correctly, cost it to the jobs the hours were charged to, and be able to
 * show an auditor how the number was reached.
 *
 * Two tables carry that, and between them they are the exactly-once control.
 *
 *  - `payroll_retro_settlements` — one row per (retro run, employee, SOURCE
 *    pay run). It states the three numbers the whole feature turns on: what
 *    the source period actually paid (`original_earnings`), what it would pay
 *    if it were calculated today (`recomputed_earnings`), and what earlier
 *    retro runs have already settled for that same cell
 *    (`previously_settled`). `delta` is the identity
 *    `recomputed − original − previously_settled`, enforced by a CHECK.
 *
 *  - `payroll_retro_allocations` — the same three numbers again, per
 *    (component, project, department) bucket, which is what makes the retro
 *    land on the RIGHT JOBS. The retro run's earning lines ARE these rows;
 *    there is no second copy of the amount anywhere, so the evidence and the
 *    payment cannot drift apart.
 *
 * WHY A HIGH-WATER MARK RATHER THAN A "SETTLED" FLAG. A settled flag makes the
 * common case safe (detection stops finding a period already paid) and the
 * second case wrong: when the March increase is itself corrected in May, the
 * further difference on those same ten periods is genuinely owed and a flag
 * refuses to pay it. Recording what a retro run settled TO, per bucket, makes
 * "pay the same money twice" arithmetically impossible in BOTH directions —
 * the second detection computes `recomputed − original − previously_settled`
 * and gets exactly the incremental amount, or zero.
 *
 * COUNTRY-AGNOSTIC. Nothing here names a jurisdiction. How a retro amount is
 * TAXED is a pack declaration (`retroactivePayTreatment` in
 * engine/src/payroll/packs.ts); whether it accrues vacation is the pay
 * component's own `vacationable` flag. These rows only carry money and the
 * dimensions it belongs to.
 */

/**
 * One employee's retro settlement for one already-paid period.
 *
 * `source_pay_run_document_id` is the committed run being made good, not the
 * period as a date range: two runs can legitimately cover overlapping days (an
 * off-cycle bonus inside a regular period), and settling "the period" rather
 * than "the run" would net two unrelated calculations together.
 *
 * `reasons` is the detection evidence — `[{ source, detail }]`, e.g. a wage
 * row effective before this period that was entered after it was paid. It is
 * carried onto the row rather than recomputed later because the configuration
 * that triggered detection is itself effective-dated and will keep moving.
 */
export const payrollRetroSettlements = pgTable(
  "payroll_retro_settlements",
  {
    id: id(),
    orgId: orgRef(),
    /** The retro pay run that pays this difference (documents.kind 'pay_run'). */
    retroPayRunDocumentId: uuid("retro_pay_run_document_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /** The already-committed run being made good. */
    sourcePayRunDocumentId: uuid("source_pay_run_document_id").notNull(),
    sourcePeriodStart: date("source_period_start").notNull(),
    sourcePeriodEnd: date("source_period_end").notNull(),
    sourcePayDate: date("source_pay_date").notNull(),
    /**
     * The source run's tax year. Retro that crosses a tax year is a different
     * exercise (amended year-end slips), so it is refused rather than quietly
     * paid; carrying the year makes the refusal checkable after the fact.
     */
    sourceTaxYear: integer("source_tax_year").notNull(),
    /** Total EARNINGS the source run's committed stub actually paid. */
    originalEarnings: money("original_earnings").notNull(),
    /** Total earnings the same period produces when calculated today. */
    recomputedEarnings: money("recomputed_earnings").notNull(),
    /** Sum of `delta` over COMMITTED earlier retro runs for this same cell. */
    previouslySettled: money("previously_settled").notNull().default("0"),
    /** recomputed − original − previously_settled. Never negative. */
    delta: money("delta").notNull(),
    /** [{ source, detail }] — why detection nominated this cell. */
    reasons: jsonb("reasons").notNull().default(sql`'[]'::jsonb`),
    /** When the recomputation that produced these numbers was run. */
    quantifiedAt: timestamp("quantified_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    // One cell per retro run. Repeating it would pay the same difference twice
    // inside a single run, which no later reconciliation could unpick.
    uniqueIndex("payroll_retro_settlements_cell").on(
      t.retroPayRunDocumentId, t.employeePartyId, t.sourcePayRunDocumentId,
    ),
    // The read behind `previously_settled` and behind "has this already been
    // paid": every settlement for one employee against one source run.
    index("payroll_retro_settlements_source").on(
      t.orgId, t.employeePartyId, t.sourcePayRunDocumentId,
    ),
    index("payroll_retro_settlements_run").on(t.orgId, t.retroPayRunDocumentId),
    // The identity the whole feature rests on, enforced by the database rather
    // than by whoever writes the row.
    check(
      "payroll_retro_settlements_delta",
      sql`${t.delta} = ${t.recomputedEarnings} - ${t.originalEarnings} - ${t.previouslySettled}`,
    ),
    // A backdated DECREASE is an overpayment recovery, not retro pay: it has
    // its own consent, notice and statutory-recovery rules in every
    // jurisdiction. Detection reports it; this table refuses to pay it.
    check("payroll_retro_settlements_nonnegative", sql`${t.delta} >= 0`),
    check(
      "payroll_retro_settlements_distinct_runs",
      sql`${t.retroPayRunDocumentId} <> ${t.sourcePayRunDocumentId}`,
    ),
    check(
      "payroll_retro_settlements_period_order",
      sql`${t.sourcePeriodEnd} >= ${t.sourcePeriodStart}`,
    ),
  ],
);

/**
 * One (component, project, department) bucket of a settlement.
 *
 * These rows ARE the retro run's earning lines: `engine/src/payroll-retro.ts`
 * emits them into `calculateStub`, which is why retro wages land on the jobs
 * the original hours were charged to, in the proportions those hours had, with
 * no allocation step to lose a penny in. Their `amount` sums to the
 * settlement's `delta` exactly, and the engine asserts it before writing.
 *
 * `hours` are carried for evidence only. The emitted earning line deliberately
 * has none: hours on a retro line would re-pay every per-hour component and
 * union fringe that the source period already paid.
 */
export const payrollRetroAllocations = pgTable(
  "payroll_retro_allocations",
  {
    id: id(),
    orgId: orgRef(),
    settlementId: uuid("settlement_id").notNull(),
    /** Nullable only so a historical settlement survives a retired component. */
    componentId: uuid("component_id"),
    /** Line description as the source period showed it ("Regular", "Salary"). */
    description: text("description").notNull(),
    projectId: uuid("project_id"),
    departmentId: uuid("department_id"),
    originalAmount: money("original_amount").notNull().default("0"),
    recomputedAmount: money("recomputed_amount").notNull().default("0"),
    previouslySettled: money("previously_settled").notNull().default("0"),
    /** recomputed − original − previously_settled, for THIS bucket. May be
     *  negative: one job can fall while another rises. */
    amount: money("amount").notNull(),
    originalHours: numeric("original_hours", { precision: 12, scale: 2 }),
    recomputedHours: numeric("recomputed_hours", { precision: 12, scale: 2 }),
    ...auditColumns,
  },
  (t) => [
    // NULLS NOT DISTINCT: an untagged bucket is ONE bucket. Without it Postgres
    // treats every (null project, null department) row as unique and the same
    // overhead share can be written — and paid — repeatedly.
    unique("payroll_retro_allocations_bucket")
      .on(t.settlementId, t.componentId, t.projectId, t.departmentId)
      .nullsNotDistinct(),
    index("payroll_retro_allocations_settlement").on(t.settlementId),
    index("payroll_retro_allocations_project").on(t.orgId, t.projectId),
    check(
      "payroll_retro_allocations_amount",
      sql`${t.amount} = ${t.recomputedAmount} - ${t.originalAmount} - ${t.previouslySettled}`,
    ),
  ],
);

/** Every table this module owns, in dependency order (create/drop/clone use). */
export const PAYROLL_RETRO_TABLES = [
  payrollRetroSettlements,
  payrollRetroAllocations,
] as const;
