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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, fxRate, id, money, orgRef } from "./helpers";

/**
 * Lessee lease accounting — ASC 842 / IFRS 16.
 *
 * A lease agreement measures, at commencement, a lease liability at the present
 * value of the unpaid payments and a right-of-use asset at cost, then runs a
 * period schedule: interest on the liability, payments splitting into interest
 * and principal, and (finance model) straight-line amortization of the
 * right-of-use asset or (US GAAP operating model) a single straight-line lease
 * cost with the liability unwound on the same interest method.
 *
 * Classification is FRAMEWORK-AWARE: IFRS 16 applies a single lessee model to
 * every lease (IFRS 16.22); ASC 842 classifies finance vs operating
 * (842-10-25-2) and presents them differently. The classification criteria and
 * their thresholds are stored per lease in `classification_inputs`, so the
 * judgement is evidence, not a hardcode.
 *
 * Short-term and low-value exemptions (ASC 842-20-25-2 / IFRS 16.5) are
 * ELECTIONS recorded on the lease. An exempt lease recognises no asset or
 * liability; its payments are expensed straight-line.
 *
 * This table is the LESSEE side. Lessor rent billing (tenant leases on owned
 * property) lives in property-management; lessor classification and
 * straight-line levelling arithmetic live in the engine's lease module.
 */
export const leaseAgreements = pgTable(
  "lease_agreements",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    leaseNumber: text("lease_number").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "active", "terminated", "complete"] })
      .notNull()
      .default("draft"),
    commencementOn: date("commencement_on").notNull(),
    /** Number of payment periods in the lease term. */
    termPeriods: integer("term_periods").notNull(),
    paymentFrequency: text("payment_frequency", { enum: ["monthly", "quarterly", "annual"] })
      .notNull()
      .default("monthly"),
    /** arrears = payment at each period end; advance = at each period start. */
    paymentTiming: text("payment_timing", { enum: ["arrears", "advance"] })
      .notNull()
      .default("arrears"),
    /** Fixed payment per period, transaction currency = subsidiary functional. */
    paymentAmount: money("payment_amount").notNull(),
    /** Annual discount rate (rate implicit in the lease, else incremental
     *  borrowing rate — IFRS 16.26), as a percent, e.g. '5' = 5%. */
    annualDiscountRatePercent: fxRate("annual_discount_rate_percent").notNull(),
    /**
     * Resolved lessee model. `finance` = interest + ROU amortization presented
     * separately (every IFRS lease; US GAAP finance leases). `operating` =
     * single straight-line lease cost (US GAAP only, 842-20-25-6).
     */
    classification: text("classification", { enum: ["finance", "operating"] })
      .notNull()
      .default("finance"),
    /** The 842-10-25-2 criteria answers + thresholds behind the classification. */
    classificationInputs: jsonb("classification_inputs").notNull().default({}),
    /** Recognition exemption election; an exempt lease stays off balance sheet. */
    exemption: text("exemption", { enum: ["short_term", "low_value"] }),
    /** Measured at commencement; null until commenced. */
    initialLiability: money("initial_liability"),
    initialRouAsset: money("initial_rou_asset"),
    /** Posting accounts. */
    rouAssetAccountId: uuid("rou_asset_account_id").notNull(),
    leaseLiabilityAccountId: uuid("lease_liability_account_id").notNull(),
    interestExpenseAccountId: uuid("interest_expense_account_id").notNull(),
    amortizationExpenseAccountId: uuid("amortization_expense_account_id").notNull(),
    /** Single-cost account for operating-model and exempt leases. */
    leaseExpenseAccountId: uuid("lease_expense_account_id").notNull(),
    /** Credit side of each payment (bank or a lease clearing account). */
    paymentAccountId: uuid("payment_account_id").notNull(),
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    commencementEntryId: uuid("commencement_entry_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("lease_agreements_org_number").on(t.orgId, t.leaseNumber),
    index("lease_agreements_org_status").on(t.orgId, t.status),
    check("lease_agreements_term_positive", sql`${t.termPeriods} > 0`),
    check("lease_agreements_payment_positive", sql`${t.paymentAmount} > 0`),
    check("lease_agreements_rate_nonnegative", sql`${t.annualDiscountRatePercent} >= 0`),
  ],
);

/**
 * The period-by-period lease schedule, built at commencement. Finance model
 * rows carry interest/principal plus straight-line `amortization`; operating
 * rows carry the `single_cost` and the `rou_adjustment` that keeps the
 * right-of-use asset aligned with the liability (cost − interest). Posting
 * writes the journal entry ids back, so posted-to-date is auditable and reruns
 * are idempotent.
 */
export const leaseScheduleLines = pgTable(
  "lease_schedule_lines",
  {
    id: id(),
    orgId: orgRef(),
    leaseId: uuid("lease_id").notNull(),
    sequence: integer("sequence").notNull(),
    dueOn: date("due_on").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    openingLiability: money("opening_liability").notNull(),
    payment: money("payment").notNull(),
    interest: money("interest").notNull(),
    principal: money("principal").notNull(),
    closingLiability: money("closing_liability").notNull(),
    /** Finance model: straight-line right-of-use amortization for the period. */
    amortization: money("amortization"),
    /** Operating model: the single straight-line lease cost for the period. */
    singleCost: money("single_cost"),
    /** Operating model: right-of-use reduction (single cost − interest). */
    rouAdjustment: money("rou_adjustment"),
    paymentEntryId: uuid("payment_entry_id"),
    amortizationEntryId: uuid("amortization_entry_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("lease_schedule_lease_seq").on(t.leaseId, t.sequence),
    index("lease_schedule_org_due").on(t.orgId, t.dueOn),
  ],
);

/**
 * Inventory NRV write-downs — IAS 2.28-33 / ASC 330-10-35.
 *
 * A write-down remeasures VALUE only: on-hand quantity is untouched, remaining
 * cost layers are revalued down so the carrying amount equals net realisable
 * value, and the loss posts immediately. Rows are the evidence trail that makes
 * the reversal rules enforceable:
 *
 *  - IFRS (IAS 2.33): a later recovery reverses the write-down, capped so
 *    cumulative reversals never exceed the cumulative write-down — carrying
 *    amount can never rise above original cost through this path.
 *  - US GAAP (ASC 330-10-35-14): the written-down amount is a new cost basis;
 *    reversal is refused.
 *
 * `kind = 'reversal'` rows reference the write-down they release via
 * `reverses_writedown_id`; the write-down's `reversed_amount` accumulates.
 */
export const inventoryWritedowns = pgTable(
  "inventory_writedowns",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    kind: text("kind", { enum: ["writedown", "reversal"] }).notNull().default("writedown"),
    date: date("date").notNull(),
    /** On-hand quantity at measurement (unchanged by the remeasurement). */
    quantity: money("quantity").notNull(),
    previousValue: money("previous_value").notNull(),
    newValue: money("new_value").notNull(),
    /** Positive magnitude of the value change. */
    amount: money("amount").notNull(),
    /** Write-downs only: cumulative amount released by later reversals. */
    reversedAmount: money("reversed_amount").notNull().default("0"),
    reversesWritedownId: uuid("reverses_writedown_id"),
    /** Reporting framework in force when recorded ('us_gaap' | 'ifrs'). */
    framework: text("framework").notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("inventory_writedowns_item").on(t.orgId, t.itemId, t.stockLocationId),
    check("inventory_writedowns_amount_positive", sql`${t.amount} > 0`),
    check(
      "inventory_writedowns_reversed_bounds",
      sql`${t.reversedAmount} >= 0 and ${t.reversedAmount} <= ${t.amount}`,
    ),
  ],
);
