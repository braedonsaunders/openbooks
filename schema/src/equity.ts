import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";
import { accounts } from "./coa";
import { journalEntries, journalLines } from "./ledger";
import { parties } from "./parties";
import { subsidiaries } from "./subsidiaries";

/**
 * Equity and cap table records (migrations 0733, 0738, 0742 and 0760). Every row belongs to one
 * organization and one legal entity; children reference their parents by
 * (org_id, subsidiary_id, id) so a record cannot attach to another entity's
 * class, plan, round or security. Records are retained history: corrections
 * are void and cancellation events, amendments, reserve changes or new
 * account-policy versions. Share counts are whole bigint quantities and
 * per-share prices carry ten decimal places.
 */

/** Per-share price columns: par values, purchase, exercise and conversion prices. */
const sharePrice = (name: string) => numeric(name, { precision: 28, scale: 10 });
const created = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
};

export const equityShareClasses = pgTable(
  "equity_share_classes",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["common", "preferred"] }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    initialAuthorizedShares: bigint("initial_authorized_shares", { mode: "bigint" }).notNull(),
    parValue: sharePrice("par_value").notNull(),
    originalIssuePrice: sharePrice("original_issue_price"),
    initialConversionPrice: sharePrice("initial_conversion_price"),
    liquidationMultiple: numeric("liquidation_multiple", { precision: 10, scale: 4 }),
    /** What a preferred class's preference is measured on: the amount paid for each certificate, or the original issue price. */
    liquidationPreferenceBasis: text("liquidation_preference_basis", {
      enum: ["original_issue_price", "amount_paid"],
    })
      .notNull()
      .default("amount_paid"),
    participation: text("participation", { enum: ["none", "full", "capped"] })
      .notNull()
      .default("none"),
    participationCapMultiple: numeric("participation_cap_multiple", { precision: 10, scale: 4 }),
    seniority: integer("seniority").notNull().default(0),
    antiDilution: text("anti_dilution", {
      enum: ["none", "broad_based", "narrow_based", "full_ratchet"],
    })
      .notNull()
      .default("none"),
    /** The common class a preferred class converts into. */
    conversionShareClassId: uuid("conversion_share_class_id"),
    /** Whether the conversion price adjusts for splits of the conversion class. */
    conversionAdjustsForSplits: boolean("conversion_adjusts_for_splits").notNull().default(true),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_share_classes_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_share_classes_entity_id_unique").on(t.orgId, t.subsidiaryId, t.id),
    uniqueIndex("equity_share_classes_code_unique").on(t.orgId, t.subsidiaryId, t.code),
    foreignKey({
      name: "equity_share_classes_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "equity_share_classes_conversion_class_fkey",
      columns: [t.orgId, t.subsidiaryId, t.conversionShareClassId],
      foreignColumns: [t.orgId, t.subsidiaryId, t.id],
    }),
  ],
);

export const equityClassAmendments = pgTable(
  "equity_class_amendments",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    shareClassId: uuid("share_class_id").notNull(),
    kind: text("kind", {
      enum: ["authorized_shares", "conversion_price", "conversion_class"],
    }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    authorizedShares: bigint("authorized_shares", { mode: "bigint" }),
    conversionPrice: sharePrice("conversion_price"),
    conversionShareClassId: uuid("conversion_share_class_id"),
    reason: text("reason").notNull(),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_class_amendments_org_id_id_unique").on(t.orgId, t.id),
    index("equity_class_amendments_class").on(t.orgId, t.shareClassId, t.effectiveOn),
    foreignKey({
      name: "equity_class_amendments_class_fkey",
      columns: [t.orgId, t.subsidiaryId, t.shareClassId],
      foreignColumns: [
        equityShareClasses.orgId,
        equityShareClasses.subsidiaryId,
        equityShareClasses.id,
      ],
    }),
    foreignKey({
      name: "equity_class_amendments_conversion_class_fkey",
      columns: [t.orgId, t.subsidiaryId, t.conversionShareClassId],
      foreignColumns: [
        equityShareClasses.orgId,
        equityShareClasses.subsidiaryId,
        equityShareClasses.id,
      ],
    }),
  ],
);

export const equityPlans = pgTable(
  "equity_plans",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    shareClassId: uuid("share_class_id").notNull(),
    effectiveOn: date("effective_on").notNull(),
    initialReservedShares: bigint("initial_reserved_shares", { mode: "bigint" }).notNull(),
    recycleForfeited: boolean("recycle_forfeited").notNull(),
    recycleExpired: boolean("recycle_expired").notNull(),
    recycleRepurchased: boolean("recycle_repurchased").notNull(),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_plans_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_plans_entity_id_unique").on(t.orgId, t.subsidiaryId, t.id),
    uniqueIndex("equity_plans_code_unique").on(t.orgId, t.subsidiaryId, t.code),
    foreignKey({
      name: "equity_plans_class_fkey",
      columns: [t.orgId, t.subsidiaryId, t.shareClassId],
      foreignColumns: [
        equityShareClasses.orgId,
        equityShareClasses.subsidiaryId,
        equityShareClasses.id,
      ],
    }),
  ],
);

export const equityPlanReserveChanges = pgTable(
  "equity_plan_reserve_changes",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    planId: uuid("plan_id").notNull(),
    effectiveOn: date("effective_on").notNull(),
    shareDelta: bigint("share_delta", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_plan_reserve_changes_org_id_id_unique").on(t.orgId, t.id),
    index("equity_plan_reserve_changes_plan").on(t.orgId, t.planId, t.effectiveOn),
    foreignKey({
      name: "equity_plan_reserve_changes_plan_fkey",
      columns: [t.orgId, t.subsidiaryId, t.planId],
      foreignColumns: [equityPlans.orgId, equityPlans.subsidiaryId, equityPlans.id],
    }),
  ],
);

export const equityFinancingRounds = pgTable(
  "equity_financing_rounds",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    name: text("name").notNull(),
    shareClassId: uuid("share_class_id").notNull(),
    closedOn: date("closed_on").notNull(),
    pricePerShare: sharePrice("price_per_share").notNull(),
    preMoneyValuation: money("pre_money_valuation").notNull(),
    currency: currencyCode("currency").notNull(),
    /** Why the pre-money valuation is stated on another basis than the price times the pre-round fully diluted shares. */
    preMoneyBasisReason: text("pre_money_basis_reason"),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_financing_rounds_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_financing_rounds_entity_id_unique").on(t.orgId, t.subsidiaryId, t.id),
    uniqueIndex("equity_financing_rounds_name_unique").on(t.orgId, t.subsidiaryId, t.name),
    foreignKey({
      name: "equity_financing_rounds_class_fkey",
      columns: [t.orgId, t.subsidiaryId, t.shareClassId],
      foreignColumns: [
        equityShareClasses.orgId,
        equityShareClasses.subsidiaryId,
        equityShareClasses.id,
      ],
    }),
  ],
);

export const equitySecurities = pgTable(
  "equity_securities",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    securityNumber: text("security_number").notNull(),
    kind: text("kind", { enum: ["share", "option", "rsu", "warrant", "safe", "note"] }).notNull(),
    holderPartyId: uuid("holder_party_id").notNull(),
    shareClassId: uuid("share_class_id"),
    planId: uuid("plan_id"),
    roundId: uuid("round_id"),
    sourceSecurityId: uuid("source_security_id"),
    issueDate: date("issue_date").notNull(),
    quantity: bigint("quantity", { mode: "bigint" }),
    pricePerShare: sharePrice("price_per_share"),
    considerationAmount: money("consideration_amount"),
    currency: currencyCode("currency").notNull(),
    considerationAccountId: uuid("consideration_account_id"),
    vestingStart: date("vesting_start"),
    vestingMonths: integer("vesting_months"),
    cliffMonths: integer("cliff_months"),
    vestingFrequency: text("vesting_frequency", { enum: ["monthly", "quarterly", "annual"] }),
    /** Custom schedule: [{ "date": "YYYY-MM-DD", "quantity": "<whole shares>" }]. */
    vestingTranches: jsonb("vesting_tranches"),
    acceleration: text("acceleration", { enum: ["none", "single", "double"] })
      .notNull()
      .default("none"),
    accelerationPercent: numeric("acceleration_percent", { precision: 9, scale: 4 }),
    expirationDate: date("expiration_date"),
    optionType: text("option_type", { enum: ["iso", "nso"] }),
    earlyExercise: boolean("early_exercise").notNull().default(false),
    safeType: text("safe_type", { enum: ["pre_money", "post_money"] }),
    valuationCap: money("valuation_cap"),
    discountPercent: numeric("discount_percent", { precision: 9, scale: 4 }),
    interestRatePercent: numeric("interest_rate_percent", { precision: 9, scale: 4 }),
    interestBasis: text("interest_basis", {
      enum: [
        "simple",
        "compound_annual",
        "compound_semiannual",
        "compound_quarterly",
        "compound_monthly",
      ],
    }),
    interestDayCount: text("interest_day_count", {
      enum: ["actual_365", "actual_360", "thirty_360", "actual_actual"],
    }),
    maturityDate: date("maturity_date"),
    /** A SAFE whose holder may adopt a later instrument's better terms. */
    mfn: boolean("mfn").notNull().default(false),
    /** Price at which unvested early-exercised shares are repurchased. */
    unvestedRepurchaseBasis: text("unvested_repurchase_basis", {
      enum: ["cost", "lower_of_cost_or_fmv"],
    }),
    /** Functional-currency units per unit of the security's currency on its issue date. */
    fxRate: numeric("fx_rate", { precision: 19, scale: 10 }).notNull().default("1"),
    valuationMethod: text("valuation_method", { enum: ["black_scholes", "share_price"] }),
    valuationSharePrice: sharePrice("valuation_share_price"),
    volatilityPercent: numeric("volatility_percent", { precision: 9, scale: 4 }),
    riskFreeRatePercent: numeric("risk_free_rate_percent", { precision: 9, scale: 4 }),
    expectedTermYears: numeric("expected_term_years", { precision: 9, scale: 4 }),
    dividendYieldPercent: numeric("dividend_yield_percent", { precision: 9, scale: 4 }),
    fairValuePerUnit: sharePrice("fair_value_per_unit"),
    expenseAttribution: text("expense_attribution", { enum: ["straight_line", "graded"] }),
    memo: text("memo"),
    journalEntryId: uuid("journal_entry_id"),
    idempotencyKey: text("idempotency_key"),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_securities_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_securities_entity_id_unique").on(t.orgId, t.subsidiaryId, t.id),
    uniqueIndex("equity_securities_number_unique").on(t.orgId, t.subsidiaryId, t.securityNumber),
    uniqueIndex("equity_securities_idempotency_unique").on(t.orgId, t.idempotencyKey),
    index("equity_securities_entity_kind").on(t.orgId, t.subsidiaryId, t.kind, t.issueDate),
    index("equity_securities_holder").on(t.orgId, t.holderPartyId),
    index("equity_securities_class").on(t.orgId, t.shareClassId),
    index("equity_securities_plan")
      .on(t.orgId, t.planId)
      .where(sql`${t.planId} IS NOT NULL`),
    index("equity_securities_source")
      .on(t.orgId, t.sourceSecurityId)
      .where(sql`${t.sourceSecurityId} IS NOT NULL`),
    foreignKey({
      name: "equity_securities_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "equity_securities_holder_fkey",
      columns: [t.orgId, t.holderPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "equity_securities_class_fkey",
      columns: [t.orgId, t.subsidiaryId, t.shareClassId],
      foreignColumns: [
        equityShareClasses.orgId,
        equityShareClasses.subsidiaryId,
        equityShareClasses.id,
      ],
    }),
    foreignKey({
      name: "equity_securities_plan_fkey",
      columns: [t.orgId, t.subsidiaryId, t.planId],
      foreignColumns: [equityPlans.orgId, equityPlans.subsidiaryId, equityPlans.id],
    }),
    foreignKey({
      name: "equity_securities_round_fkey",
      columns: [t.orgId, t.subsidiaryId, t.roundId],
      foreignColumns: [
        equityFinancingRounds.orgId,
        equityFinancingRounds.subsidiaryId,
        equityFinancingRounds.id,
      ],
    }),
    foreignKey({
      name: "equity_securities_source_fkey",
      columns: [t.orgId, t.subsidiaryId, t.sourceSecurityId],
      foreignColumns: [t.orgId, t.subsidiaryId, t.id],
    }),
    foreignKey({
      name: "equity_securities_consideration_account_fkey",
      columns: [t.orgId, t.considerationAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_securities_journal_entry_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

export const equitySecurityEvents = pgTable(
  "equity_security_events",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    securityId: uuid("security_id").notNull(),
    kind: text("kind", {
      enum: [
        "exercise",
        "settle",
        "forfeit",
        "expire",
        "cancel",
        "repurchase",
        "transfer",
        "convert",
        "void",
        "repay",
        "reverse",
        "election_83b",
      ],
    }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    quantity: bigint("quantity", { mode: "bigint" }),
    pricePerShare: sharePrice("price_per_share"),
    amount: money("amount"),
    resultingSecurityId: uuid("resulting_security_id"),
    roundId: uuid("round_id"),
    considerationAccountId: uuid("consideration_account_id"),
    journalEntryId: uuid("journal_entry_id"),
    reversalEntryId: uuid("reversal_entry_id"),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key"),
    /** The event a reversal undoes. */
    reversesEventId: uuid("reverses_event_id"),
    /** Accrued interest a note settlement consumed, in the note's currency. */
    interestAmount: money("interest_amount"),
    /** Interest accrued from the last run to the event date, and its functional amount and entry. */
    interestAccruedAmount: money("interest_accrued_amount"),
    interestAccruedFunctional: money("interest_accrued_functional"),
    interestAccrualEntryId: uuid("interest_accrual_entry_id"),
    /** Early-exercise deposit credited (exercise) or settled (repurchase), functional currency. */
    depositAmount: money("deposit_amount"),
    /** Fair market value per share a restricted repurchase was priced against. */
    fairMarketValue: sharePrice("fair_market_value"),
    fxRate: numeric("fx_rate", { precision: 19, scale: 10 }),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_security_events_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_security_events_idempotency_unique").on(t.orgId, t.idempotencyKey),
    uniqueIndex("equity_security_events_one_void")
      .on(t.orgId, t.securityId)
      .where(sql`${t.kind} = 'void'`),
    uniqueIndex("equity_security_events_one_reversal")
      .on(t.orgId, t.reversesEventId)
      .where(sql`${t.reversesEventId} IS NOT NULL`),
    index("equity_security_events_security").on(t.orgId, t.securityId, t.effectiveOn),
    index("equity_security_events_entity").on(t.orgId, t.subsidiaryId, t.effectiveOn),
    foreignKey({
      name: "equity_security_events_security_fkey",
      columns: [t.orgId, t.subsidiaryId, t.securityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
    foreignKey({
      name: "equity_security_events_result_fkey",
      columns: [t.orgId, t.subsidiaryId, t.resultingSecurityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
    foreignKey({
      name: "equity_security_events_round_fkey",
      columns: [t.orgId, t.subsidiaryId, t.roundId],
      foreignColumns: [
        equityFinancingRounds.orgId,
        equityFinancingRounds.subsidiaryId,
        equityFinancingRounds.id,
      ],
    }),
    foreignKey({
      name: "equity_security_events_consideration_account_fkey",
      columns: [t.orgId, t.considerationAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_security_events_journal_entry_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "equity_security_events_reversal_entry_fkey",
      columns: [t.orgId, t.reversalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "equity_security_events_reverses_fkey",
      columns: [t.orgId, t.reversesEventId],
      foreignColumns: [t.orgId, t.id],
    }),
    foreignKey({
      name: "equity_security_events_accrual_entry_fkey",
      columns: [t.orgId, t.interestAccrualEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

export const equitySplits = pgTable(
  "equity_splits",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    shareClassId: uuid("share_class_id").notNull(),
    effectiveOn: date("effective_on").notNull(),
    ratioNumerator: bigint("ratio_numerator", { mode: "bigint" }).notNull(),
    ratioDenominator: bigint("ratio_denominator", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_splits_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_splits_class_date_unique").on(t.orgId, t.shareClassId, t.effectiveOn),
    foreignKey({
      name: "equity_splits_class_fkey",
      columns: [t.orgId, t.subsidiaryId, t.shareClassId],
      foreignColumns: [
        equityShareClasses.orgId,
        equityShareClasses.subsidiaryId,
        equityShareClasses.id,
      ],
    }),
  ],
);

export const equityAccountPolicies = pgTable(
  "equity_account_policies",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    commonStockAccountId: uuid("common_stock_account_id").notNull(),
    preferredStockAccountId: uuid("preferred_stock_account_id").notNull(),
    apicAccountId: uuid("apic_account_id").notNull(),
    apicShareBasedAccountId: uuid("apic_share_based_account_id").notNull(),
    compensationExpenseAccountId: uuid("compensation_expense_account_id").notNull(),
    treasuryStockAccountId: uuid("treasury_stock_account_id").notNull(),
    convertibleInstrumentsAccountId: uuid("convertible_instruments_account_id").notNull(),
    interestExpenseAccountId: uuid("interest_expense_account_id"),
    accruedInterestAccountId: uuid("accrued_interest_account_id"),
    earlyExerciseDepositAccountId: uuid("early_exercise_deposit_account_id"),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("equity_account_policies_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_account_policies_version_unique").on(
      t.orgId,
      t.subsidiaryId,
      t.effectiveFrom,
    ),
    foreignKey({
      name: "equity_account_policies_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "equity_account_policies_common_fkey",
      columns: [t.orgId, t.commonStockAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_preferred_fkey",
      columns: [t.orgId, t.preferredStockAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_apic_fkey",
      columns: [t.orgId, t.apicAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_apic_share_based_fkey",
      columns: [t.orgId, t.apicShareBasedAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_expense_fkey",
      columns: [t.orgId, t.compensationExpenseAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_treasury_fkey",
      columns: [t.orgId, t.treasuryStockAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_convertible_fkey",
      columns: [t.orgId, t.convertibleInstrumentsAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_interest_expense_fkey",
      columns: [t.orgId, t.interestExpenseAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_accrued_interest_fkey",
      columns: [t.orgId, t.accruedInterestAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "equity_account_policies_deposit_fkey",
      columns: [t.orgId, t.earlyExerciseDepositAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

export const equityCompensationRuns = pgTable(
  "equity_compensation_runs",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    throughDate: date("through_date").notNull(),
    currency: currencyCode("currency").notNull(),
    totalAmount: money("total_amount").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    /** Early-exercise deposits released to equity by the run, and their entry. */
    releaseAmount: money("release_amount").notNull().default("0"),
    releaseJournalEntryId: uuid("release_journal_entry_id"),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_compensation_runs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_compensation_runs_entity_id_unique").on(t.orgId, t.subsidiaryId, t.id),
    uniqueIndex("equity_compensation_runs_through_unique").on(
      t.orgId,
      t.subsidiaryId,
      t.throughDate,
    ),
    foreignKey({
      name: "equity_compensation_runs_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "equity_compensation_runs_journal_entry_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "equity_compensation_runs_release_entry_fkey",
      columns: [t.orgId, t.releaseJournalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

export const equityCompensationRunLines = pgTable(
  "equity_compensation_run_lines",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    runId: uuid("run_id").notNull(),
    securityId: uuid("security_id").notNull(),
    cumulativeAmount: money("cumulative_amount").notNull(),
    previousAmount: money("previous_amount").notNull(),
    periodAmount: money("period_amount").notNull(),
  },
  (t) => [
    uniqueIndex("equity_compensation_run_lines_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_compensation_run_lines_security_unique").on(t.orgId, t.runId, t.securityId),
    index("equity_compensation_run_lines_security").on(t.orgId, t.securityId),
    foreignKey({
      name: "equity_compensation_run_lines_run_fkey",
      columns: [t.orgId, t.subsidiaryId, t.runId],
      foreignColumns: [
        equityCompensationRuns.orgId,
        equityCompensationRuns.subsidiaryId,
        equityCompensationRuns.id,
      ],
    }),
    foreignKey({
      name: "equity_compensation_run_lines_security_fkey",
      columns: [t.orgId, t.subsidiaryId, t.securityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
  ],
);

/** Restricted-stock releases a compensation run posted: early-exercise deposits reclassified to equity as shares vest. */
export const equityCompensationRunReleases = pgTable(
  "equity_compensation_run_releases",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    runId: uuid("run_id").notNull(),
    securityId: uuid("security_id").notNull(),
    cumulativeShares: bigint("cumulative_shares", { mode: "bigint" }).notNull(),
    previousShares: bigint("previous_shares", { mode: "bigint" }).notNull(),
    cumulativeDeposit: money("cumulative_deposit").notNull(),
    periodDeposit: money("period_deposit").notNull(),
    cumulativeReclass: money("cumulative_reclass").notNull(),
    periodReclass: money("period_reclass").notNull(),
    cumulativePar: money("cumulative_par").notNull(),
    periodPar: money("period_par").notNull(),
  },
  (t) => [
    uniqueIndex("equity_compensation_run_releases_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_compensation_run_releases_security_unique").on(
      t.orgId,
      t.runId,
      t.securityId,
    ),
    index("equity_compensation_run_releases_security").on(t.orgId, t.securityId),
    foreignKey({
      name: "equity_compensation_run_releases_run_fkey",
      columns: [t.orgId, t.subsidiaryId, t.runId],
      foreignColumns: [
        equityCompensationRuns.orgId,
        equityCompensationRuns.subsidiaryId,
        equityCompensationRuns.id,
      ],
    }),
    foreignKey({
      name: "equity_compensation_run_releases_security_fkey",
      columns: [t.orgId, t.subsidiaryId, t.securityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
  ],
);

/** Security term amendments: a SAFE holder's MFN election adopting a later instrument's terms, or its reversal. */
export const equitySecurityAmendments = pgTable(
  "equity_security_amendments",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    securityId: uuid("security_id").notNull(),
    kind: text("kind", { enum: ["mfn_election", "mfn_reversal"] }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    sourceSecurityId: uuid("source_security_id").notNull(),
    valuationCap: money("valuation_cap"),
    discountPercent: numeric("discount_percent", { precision: 9, scale: 4 }),
    safeType: text("safe_type", { enum: ["pre_money", "post_money"] }).notNull(),
    /** The election a reversal undoes. */
    reversesAmendmentId: uuid("reverses_amendment_id"),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key"),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_security_amendments_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_security_amendments_one_reversal")
      .on(t.orgId, t.reversesAmendmentId)
      .where(sql`reverses_amendment_id IS NOT NULL`),
    foreignKey({
      name: "equity_security_amendments_reverses_fkey",
      columns: [t.orgId, t.reversesAmendmentId],
      foreignColumns: [t.orgId, t.id],
    }),
    uniqueIndex("equity_security_amendments_idempotency_unique").on(t.orgId, t.idempotencyKey),
    index("equity_security_amendments_security").on(t.orgId, t.securityId, t.effectiveOn),
    foreignKey({
      name: "equity_security_amendments_security_fkey",
      columns: [t.orgId, t.subsidiaryId, t.securityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
    foreignKey({
      name: "equity_security_amendments_source_fkey",
      columns: [t.orgId, t.subsidiaryId, t.sourceSecurityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
  ],
);

/** Note interest accrual runs: interest accrued through a date per legal entity. */
export const equityInterestRuns = pgTable(
  "equity_interest_runs",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    throughDate: date("through_date").notNull(),
    currency: currencyCode("currency").notNull(),
    totalAmount: money("total_amount").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_interest_runs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_interest_runs_entity_id_unique").on(t.orgId, t.subsidiaryId, t.id),
    uniqueIndex("equity_interest_runs_through_unique").on(t.orgId, t.subsidiaryId, t.throughDate),
    foreignKey({
      name: "equity_interest_runs_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "equity_interest_runs_journal_entry_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

/** One note's accrual in an interest run: cumulative interest in the note's currency and the change posted. */
export const equityInterestRunLines = pgTable(
  "equity_interest_run_lines",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    runId: uuid("run_id").notNull(),
    securityId: uuid("security_id").notNull(),
    currency: currencyCode("currency").notNull(),
    cumulativeAmount: money("cumulative_amount").notNull(),
    previousAmount: money("previous_amount").notNull(),
    periodAmount: money("period_amount").notNull(),
    fxRate: numeric("fx_rate", { precision: 19, scale: 10 }),
    functionalAmount: money("functional_amount").notNull(),
  },
  (t) => [
    uniqueIndex("equity_interest_run_lines_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_interest_run_lines_security_unique").on(t.orgId, t.runId, t.securityId),
    index("equity_interest_run_lines_security").on(t.orgId, t.securityId),
    foreignKey({
      name: "equity_interest_run_lines_run_fkey",
      columns: [t.orgId, t.subsidiaryId, t.runId],
      foreignColumns: [
        equityInterestRuns.orgId,
        equityInterestRuns.subsidiaryId,
        equityInterestRuns.id,
      ],
    }),
    foreignKey({
      name: "equity_interest_run_lines_security_fkey",
      columns: [t.orgId, t.subsidiaryId, t.securityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
  ],
);

/**
 * A governed equity action submitted to any enabled Equity action Flow: the
 * frozen command input, the figures a Flow condition reads, and its single
 * decision (applied, with or without an approval, or rejected).
 */
export const equityActionRequests = pgTable(
  "equity_action_requests",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    action: text("action").notNull(),
    subjectId: uuid("subject_id"),
    subjectLabel: text("subject_label").notNull(),
    effectiveOn: date("effective_on").notNull(),
    reason: text("reason"),
    payload: jsonb("payload").notNull(),
    summary: jsonb("summary")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull(),
    releasedWithoutApproval: boolean("released_without_approval").notNull().default(false),
    requestedBy: uuid("requested_by").notNull(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionComment: text("decision_comment"),
    result: jsonb("result"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("equity_action_requests_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_action_requests_idempotency_unique").on(t.orgId, t.idempotencyKey),
    index("equity_action_requests_pending").on(t.orgId, t.subsidiaryId, t.status, t.createdAt),
    index("equity_action_requests_subject")
      .on(t.orgId, t.subjectId)
      .where(sql`subject_id IS NOT NULL`),
    foreignKey({
      name: "equity_action_requests_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
  ],
);

/**
 * The cap table as append-only movements: each row is one change of a share
 * certificate's, award's or plan pool's outstanding shares (restated through
 * splits) and of those shares as converted into common. The sum of a
 * position's rows effective on or before a date is its position that day.
 */
export const equityPositionMovements = pgTable(
  "equity_position_movements",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    positionKind: text("position_kind").notNull(),
    securityId: uuid("security_id"),
    planId: uuid("plan_id"),
    effectiveOn: date("effective_on").notNull(),
    sharesDelta: bigint("shares_delta", { mode: "bigint" }).notNull(),
    asConvertedDelta: bigint("as_converted_delta", { mode: "bigint" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("equity_position_movements_org_id_id_unique").on(t.orgId, t.id),
    index("equity_position_movements_entity").on(t.orgId, t.subsidiaryId, t.effectiveOn),
    index("equity_position_movements_security")
      .on(t.orgId, t.securityId)
      .where(sql`security_id IS NOT NULL`),
    index("equity_position_movements_plan")
      .on(t.orgId, t.planId)
      .where(sql`plan_id IS NOT NULL`),
    foreignKey({
      name: "equity_position_movements_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "equity_position_movements_security_fkey",
      columns: [t.orgId, t.subsidiaryId, t.securityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
    foreignKey({
      name: "equity_position_movements_plan_fkey",
      columns: [t.orgId, t.subsidiaryId, t.planId],
      foreignColumns: [equityPlans.orgId, equityPlans.subsidiaryId, equityPlans.id],
    }),
  ],
);

/** Corrections of a recorded financing round: an amendment of its terms, or its void. */
export const equityRoundAmendments = pgTable(
  "equity_round_amendments",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    roundId: uuid("round_id").notNull(),
    kind: text("kind", { enum: ["amend", "void"] }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    name: text("name"),
    pricePerShare: sharePrice("price_per_share"),
    preMoneyValuation: money("pre_money_valuation"),
    preMoneyBasisReason: text("pre_money_basis_reason"),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key"),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_round_amendments_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_round_amendments_idempotency_unique").on(t.orgId, t.idempotencyKey),
    index("equity_round_amendments_round").on(t.orgId, t.roundId, t.createdAt),
    uniqueIndex("equity_round_amendments_one_void")
      .on(t.orgId, t.roundId)
      .where(sql`kind = 'void'`),
    foreignKey({
      name: "equity_round_amendments_round_fkey",
      columns: [t.orgId, t.subsidiaryId, t.roundId],
      foreignColumns: [
        equityFinancingRounds.orgId,
        equityFinancingRounds.subsidiaryId,
        equityFinancingRounds.id,
      ],
    }),
  ],
);

/**
 * The security an equity journal line's instrument balance belongs to, when
 * the line was copied from another environment under its source identity.
 * Instrument balances read the attribution in preference to the line's own.
 */
export const equityInstrumentLineAttributions = pgTable(
  "equity_instrument_line_attributions",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    journalLineId: uuid("journal_line_id").notNull(),
    securityId: uuid("security_id").notNull(),
    role: text("role", { enum: ["deposit", "interest"] }).notNull(),
    /** The security identity the line itself names. */
    recordedIdentity: text("recorded_identity").notNull(),
    reason: text("reason").notNull(),
    ...created,
  },
  (t) => [
    uniqueIndex("equity_instrument_line_attributions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equity_instrument_line_attributions_line_unique").on(t.orgId, t.journalLineId),
    index("equity_instrument_line_attributions_security").on(t.orgId, t.securityId, t.role),
    foreignKey({
      name: "equity_instrument_line_attributions_entry_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "equity_instrument_line_attributions_line_fkey",
      columns: [t.orgId, t.journalLineId],
      foreignColumns: [journalLines.orgId, journalLines.id],
    }),
    foreignKey({
      name: "equity_instrument_line_attributions_security_fkey",
      columns: [t.orgId, t.subsidiaryId, t.securityId],
      foreignColumns: [equitySecurities.orgId, equitySecurities.subsidiaryId, equitySecurities.id],
    }),
  ],
);
