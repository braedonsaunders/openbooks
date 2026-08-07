import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Entitlement plans — the ONE mechanism behind every employee "pay bank":
 * banked overtime, vacation, sick/personal banks, and benefit recoup while an
 * employee is on leave. Three shapes that construction payroll has always
 * hand-rolled in spreadsheets become one configurable, GL-backed engine.
 *
 * Design doctrine:
 *
 * - BALANCES ARE MONEY. A bank denominated in hours is an unfunded liability:
 *   50 banked hours booked at $32 and taken at $38 costs the employer the
 *   difference, silently, forever. Storing the DOLLARS the hours were earned
 *   at and DISPLAYING them as hours at the current wage keeps the balance
 *   sheet honest. `unit` exists because true time-off-in-lieu banks (a
 *   statutory hour-for-hour entitlement) genuinely are hours — but money is
 *   the default and the recommendation.
 *
 * - THE LEDGER IS THE ONLY SOURCE OF TRUTH. Balance = SUM(entitlement_ledger).
 *   There is deliberately no materialized balance column anywhere: the same
 *   rule that makes payroll YTD = opening balances + posted stubs (see
 *   schema/src/payroll.ts) makes an entitlement balance always recomputable
 *   and never repairable-by-UPDATE.
 *
 * - EVERY PLAN CAN NAME A GL LIABILITY ACCOUNT. That is the accounting point:
 *   a bank the company owes belongs on the balance sheet, tying out to this
 *   ledger, not living in a payroll clerk's workbook.
 *
 * - LIMITS ARE SCOPED CONFIGURATION, NOT CONSTANTS. "Trades $4,000, Foremen
 *   $5,000, Superintendents $6,000" is three effective-dated rows in
 *   entitlement_plan_limits, resolved exactly the way labor_cost_rates
 *   resolves a wage (employee > job title > trade > department > subsidiary >
 *   org default, latest effective_from wins).
 *
 * - SERVICE IS A SCHEDULE, NOT A FLAG. "Benefits after 3 months, RRSP after
 *   1 year, 6% vacation at 5 years" is entitlement_service_tiers, which either
 *   raises a plan's accrual value or flips a pay component's eligibility on.
 */

/**
 * A pay bank. `direction` is the whole taxonomy:
 *
 *   accrue — the employer owes the employee (banked OT, vacation, sick). The
 *            balance runs POSITIVE and is a credit-normal liability.
 *   owe    — the employee owes the employer (benefit premiums the employer
 *            carried through an unpaid leave, a payroll advance). The balance
 *            runs NEGATIVE and is repaid over subsequent periods until it
 *            reaches exactly zero — never past it.
 */
export const entitlementPlans = pgTable(
  "entitlement_plans",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /**
     * The ENGINE BINDING, and the only thing the engine may match a plan on.
     *
     * Exactly the doctrine pay_components.systemKey follows
     * (schema/src/payroll.ts): `code` and `name` are operator-typed free text
     * in the Setup drawer, so neither can ever carry engine meaning. A tenant
     * who renames the Vacation plan's code from "VAC" to "VACATION" must not
     * thereby switch vacation accrual off — which is precisely what happened
     * while the pay run matched on `code`.
     *
     * Null for every tenant-defined plan (banked overtime, sick banks, benefit
     * recoup): those have no engine behaviour beyond the generic plan engine.
     * 'vacation' is the one plan the pay run itself reasons about, because
     * employee_payroll_profiles.vacation_percent / vacation_method decide
     * between banking it and paying it in cash.
     */
    systemKey: text("system_key", { enum: ["vacation"] }),
    /** Denomination of the BALANCE. Money is the default (see doctrine). */
    unit: text("unit", { enum: ["money", "hours"] }).notNull().default("money"),
    direction: text("direction", { enum: ["accrue", "owe"] }).notNull().default("accrue"),
    /**
     * How each pay period's movement is produced:
     *   percent_of_earnings — accrualValue is a percent (4.0000 = 4%) of the
     *                         period's vacationable/bankable earnings;
     *   per_hour_worked     — accrualValue per hour on the stub;
     *   fixed_per_period    — accrualValue flat each period (also the shape a
     *                         repayment schedule takes for direction 'owe');
     *   manual              — no automatic movement; the bank moves only by
     *                         explicit bank_in / payout / adjustment entries.
     */
    accrualMethod: text("accrual_method", {
      enum: ["percent_of_earnings", "per_hour_worked", "fixed_per_period", "manual"],
    }).notNull().default("manual"),
    /** Percent, per-hour amount, or per-period amount — read per accrualMethod. */
    accrualValue: money("accrual_value"),
    /** Stub component the accrual (or, for 'owe', the advance) posts against. */
    accrualComponentId: uuid("accrual_component_id"),
    /**
     * Stub component the bank pays out through. For direction 'accrue' this is
     * an EARNING (vacation pay, banked-time payout); for direction 'owe' it is
     * the DEDUCTION that recoups the balance.
     */
    payoutComponentId: uuid("payout_component_id"),
    /** CR account carrying the bank on the balance sheet. Null = report-only. */
    liabilityAccountId: uuid("liability_account_id"),
    /**
     * What happens when a movement would push the balance past the resolved
     * limit: warn (record it, surface a warning), block (refuse the run for
     * that employee), or auto_payout (record the accrual AND a payout of the
     * excess, so the bank lands exactly on the cap and the money is paid).
     */
    capBehavior: text("cap_behavior", {
      enum: ["warn", "block", "auto_payout"],
    }).notNull().default("warn"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("entitlement_plans_org_code").on(t.orgId, t.code),
    // At most one plan per org may claim an engine binding — two "vacation"
    // plans would make the accrual the pay run produces order-dependent.
    // Mirrors pay_components_org_system; NULLs stay unconstrained, so tenant
    // plans are unaffected.
    uniqueIndex("entitlement_plans_org_system").on(t.orgId, t.systemKey),
    index("entitlement_plans_org_active").on(t.orgId, t.isActive),
    // percent/per-hour/fixed plans are meaningless without their value; a
    // manual plan deliberately has none.
    check(
      "entitlement_plans_accrual_value",
      sql`${t.accrualMethod} = 'manual' or ${t.accrualValue} is not null`,
    ),
    check(
      "entitlement_plans_accrual_nonnegative",
      sql`${t.accrualValue} is null or ${t.accrualValue} >= 0`,
    ),
  ],
);

/**
 * The scoped caps. Scope keys are nullable and resolve most-specific-wins —
 * employee > job title > trade > department > subsidiary > plan default —
 * with the latest effectiveFrom ≤ the date winning within a scope. This is
 * deliberately the SAME shape and the same precedence as labor_cost_rates
 * (schema/src/labor-costing.ts): there is one scoping mechanism in this
 * product, not two.
 *
 * `maxBalance` is the hard ceiling (interpreted per the plan's capBehavior);
 * `notifyBalance` is the soft "getting close" threshold that drives the
 * near-limit report and the payroll-run warnings. Both are in the plan's unit.
 */
export const entitlementPlanLimits = pgTable(
  "entitlement_plan_limits",
  {
    id: id(),
    orgId: orgRef(),
    planId: uuid("plan_id").notNull(),
    employeePartyId: uuid("employee_party_id"),
    jobTitle: text("job_title"),
    tradeId: uuid("trade_id"),
    departmentId: uuid("department_id"),
    subsidiaryId: uuid("subsidiary_id"),
    maxBalance: money("max_balance"),
    notifyBalance: money("notify_balance"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("entitlement_plan_limits_plan").on(t.orgId, t.planId, t.effectiveFrom),
    index("entitlement_plan_limits_employee").on(t.orgId, t.employeePartyId, t.effectiveFrom),
    index("entitlement_plan_limits_job_title").on(t.orgId, t.jobTitle, t.effectiveFrom),
    index("entitlement_plan_limits_trade").on(t.orgId, t.tradeId, t.effectiveFrom),
    index("entitlement_plan_limits_department").on(t.orgId, t.departmentId, t.effectiveFrom),
    index("entitlement_plan_limits_subsidiary").on(t.orgId, t.subsidiaryId, t.effectiveFrom),
    // One row per plan per scope per start date (coalesced scope keys in the
    // SQL migration, exactly like labor_cost_rates_scope_from).
    uniqueIndex("entitlement_plan_limits_scope_from").on(
      t.planId,
      t.employeePartyId,
      t.jobTitle,
      t.tradeId,
      t.departmentId,
      t.subsidiaryId,
      t.effectiveFrom,
    ),
    check("entitlement_plan_limits_max_nonnegative", sql`${t.maxBalance} is null or ${t.maxBalance} >= 0`),
    check("entitlement_plan_limits_notify_nonnegative", sql`${t.notifyBalance} is null or ${t.notifyBalance} >= 0`),
    check(
      "entitlement_plan_limits_notify_order",
      sql`${t.maxBalance} is null or ${t.notifyBalance} is null or ${t.notifyBalance} <= ${t.maxBalance}`,
    ),
    check(
      "entitlement_plan_limits_valid_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    // Exactly zero or one scope key: zero is the plan-wide default.
    check(
      "entitlement_plan_limits_one_scope",
      sql`num_nonnulls(${t.employeePartyId}, ${t.jobTitle}, ${t.tradeId}, ${t.departmentId}, ${t.subsidiaryId}) <= 1`,
    ),
    // A row that sets neither threshold configures nothing.
    check(
      "entitlement_plan_limits_shape",
      sql`${t.maxBalance} is not null or ${t.notifyBalance} is not null`,
    ),
  ],
);

/**
 * Service-based schedules — the "after N months of continuous service…" rules
 * every handbook has and no accounting system stores. A tier targets EXACTLY
 * one of:
 *
 *   planId      — raises that plan's accrual value at the milestone
 *                 (4% → 6% vacation at 5 years, 8% at 10, …), or
 *   componentId — flips eligibility for a pay component on
 *                 (benefits at 3 months, RRSP match at 1 year).
 *
 * Months of continuous service run from employee_roles.hired_on. Tiers are
 * additive rungs on one ladder: the highest afterMonths ≤ service wins.
 */
export const entitlementServiceTiers = pgTable(
  "entitlement_service_tiers",
  {
    id: id(),
    orgId: orgRef(),
    planId: uuid("plan_id"),
    componentId: uuid("component_id"),
    /** Months of continuous service at which this rung takes effect. */
    afterMonths: integer("after_months").notNull(),
    /** planId tiers: the accrual value from this rung on (percent or amount). */
    accrualValue: money("accrual_value"),
    /** componentId tiers: whether the component becomes eligible. */
    eligible: boolean("eligible"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("entitlement_service_tiers_plan").on(t.orgId, t.planId, t.afterMonths),
    index("entitlement_service_tiers_component").on(t.orgId, t.componentId, t.afterMonths),
    // One rung per target per milestone — two conflicting 60-month rules on
    // one plan would make the resolved value order-dependent.
    uniqueIndex("entitlement_service_tiers_target_months").on(
      t.orgId,
      t.planId,
      t.componentId,
      t.afterMonths,
    ),
    check("entitlement_service_tiers_months", sql`${t.afterMonths} >= 0`),
    check(
      "entitlement_service_tiers_one_target",
      sql`num_nonnulls(${t.planId}, ${t.componentId}) = 1`,
    ),
    // Each target shape carries its own payload; the other stays null.
    check(
      "entitlement_service_tiers_shape",
      sql`(${t.planId} is null or (${t.accrualValue} is not null and ${t.eligible} is null))
          and (${t.componentId} is null or (${t.eligible} is not null and ${t.accrualValue} is null))`,
    ),
    check(
      "entitlement_service_tiers_value_nonnegative",
      sql`${t.accrualValue} is null or ${t.accrualValue} >= 0`,
    ),
  ],
);

/**
 * The append-only movement ledger. Balance = SUM(amount) for an employee and
 * plan; nothing else is ever the balance. Amount is SIGNED and denominated in
 * the plan's `unit`:
 *
 *   opening   — mid-adoption carry-in (or the migration of a legacy balance);
 *   accrual   — this period's earned entitlement (≥ 0);
 *   bank_in   — a deliberate deposit: overtime banked instead of paid, or (for
 *               direction 'owe', negative) the premiums the employer carried;
 *   payout    — money leaving the bank to the employee (≤ 0);
 *   repayment — an 'owe' balance being recouped back toward zero (≥ 0);
 *   adjustment— a corrected or written-off amount, either sign, always with a
 *               note.
 *
 * `hours` is CONTEXT, never the balance: the hours the movement was derived
 * from (hours worked behind a per-hour accrual, hours taken on a payout). For
 * a `unit = 'hours'` plan the balance-carrying figure is still `amount`.
 *
 * payRunDocumentId / stubLineId tie a movement to the pay run that produced
 * it, which is what makes recalculating a run safe: run-sourced movements are
 * keyed one-per-(run, plan, employee, kind) and replaced, never duplicated.
 */
export const entitlementLedger = pgTable(
  "entitlement_ledger",
  {
    id: id(),
    orgId: orgRef(),
    planId: uuid("plan_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    movementDate: date("movement_date").notNull(),
    amount: money("amount").notNull(),
    hours: numeric("hours", { precision: 12, scale: 2 }),
    kind: text("kind", {
      enum: ["opening", "accrual", "bank_in", "payout", "repayment", "adjustment"],
    }).notNull(),
    payRunDocumentId: uuid("pay_run_document_id"),
    stubLineId: uuid("stub_line_id"),
    note: text("note"),
    ...auditColumns,
  },
  (t) => [
    index("entitlement_ledger_plan_employee").on(
      t.orgId, t.planId, t.employeePartyId, t.movementDate,
    ),
    index("entitlement_ledger_run").on(t.orgId, t.payRunDocumentId),
    // A pay run contributes at most one movement of each kind per plan per
    // employee, so recalculating a run replaces its movements idempotently.
    uniqueIndex("entitlement_ledger_run_movement")
      .on(t.payRunDocumentId, t.planId, t.employeePartyId, t.kind)
      .where(sql`pay_run_document_id is not null`),
    // One carry-in per employee per plan — the migration and the mid-year
    // adoption screen can both be re-run without inflating a balance.
    uniqueIndex("entitlement_ledger_opening")
      .on(t.orgId, t.planId, t.employeePartyId)
      .where(sql`kind = 'opening'`),
    check(
      "entitlement_ledger_kind_sign",
      sql`(${t.kind} <> 'accrual' or ${t.amount} >= 0)
          and (${t.kind} <> 'payout' or ${t.amount} <= 0)
          and (${t.kind} <> 'repayment' or ${t.amount} >= 0)`,
    ),
    // Corrections must say why — the audit evidence rule.
    check(
      "entitlement_ledger_adjustment_note",
      sql`${t.kind} <> 'adjustment' or ${t.note} is not null`,
    ),
  ],
);

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
