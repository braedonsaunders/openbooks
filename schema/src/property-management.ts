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
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/** Portfolio master. `locationId` is the accounting dimension used for CAM actuals. */
export const managedProperties = pgTable(
  "managed_properties",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    locationId: uuid("location_id"),
    fixedAssetId: uuid("fixed_asset_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    propertyType: text("property_type", { enum: ["residential", "commercial", "mixed_use", "industrial", "other"] }).notNull(),
    status: text("status", { enum: ["active", "inactive", "sold"] }).notNull().default("active"),
    currency: currencyCode("currency").notNull(),
    address: jsonb("address").$type<Record<string, string>>().notNull().default({}),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    rentIncomeAccountId: uuid("rent_income_account_id"),
    camIncomeAccountId: uuid("cam_income_account_id"),
    depositLiabilityAccountId: uuid("deposit_liability_account_id"),
    defaultBankAccountId: uuid("default_bank_account_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("managed_properties_org_code").on(t.orgId, t.code),
    index("managed_properties_subsidiary_status").on(t.orgId, t.subsidiaryId, t.status),
  ],
);

export const propertyUnits = pgTable(
  "property_units",
  {
    id: id(),
    orgId: orgRef(),
    propertyId: uuid("property_id").notNull(),
    code: text("code").notNull(),
    name: text("name"),
    unitType: text("unit_type"),
    rentableArea: money("rentable_area"),
    bedrooms: integer("bedrooms"),
    status: text("status", { enum: ["vacant", "occupied", "notice", "offline"] }).notNull().default("vacant"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("property_units_property_code").on(t.orgId, t.propertyId, t.code),
    index("property_units_property_status").on(t.orgId, t.propertyId, t.status),
    check("property_units_area_positive", sql`${t.rentableArea} is null or ${t.rentableArea} > 0`),
    check("property_units_bedrooms_nonnegative", sql`${t.bedrooms} is null or ${t.bedrooms} >= 0`),
  ],
);

export const propertyLeases = pgTable(
  "property_leases",
  {
    id: id(),
    orgId: orgRef(),
    propertyId: uuid("property_id").notNull(),
    unitId: uuid("unit_id"),
    tenantId: uuid("tenant_id").notNull(),
    leaseNumber: text("lease_number").notNull(),
    status: text("status", { enum: ["draft", "active", "notice", "expired", "terminated", "cancelled"] }).notNull().default("draft"),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    moveInOn: date("move_in_on"),
    moveOutOn: date("move_out_on"),
    billingDay: integer("billing_day").notNull().default(1),
    paymentTermsDays: integer("payment_terms_days").notNull().default(0),
    securityDepositRequired: money("security_deposit_required").notNull().default("0"),
    camMethod: text("cam_method", { enum: ["none", "fixed", "pro_rata"] }).notNull().default("none"),
    camSharePercent: money("cam_share_percent"),
    lateFeeType: text("late_fee_type", { enum: ["none", "fixed", "percent"] }).notNull().default("none"),
    lateFeeValue: money("late_fee_value").notNull().default("0"),
    graceDays: integer("grace_days").notNull().default(0),
    autoInvoice: boolean("auto_invoice").notNull().default(true),
    autoPost: boolean("auto_post").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedBy: uuid("activated_by"),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    terminatedBy: uuid("terminated_by"),
    terminationReason: text("termination_reason"),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("property_leases_org_number").on(t.orgId, t.leaseNumber),
    index("property_leases_property_status").on(t.orgId, t.propertyId, t.status),
    index("property_leases_tenant_status").on(t.orgId, t.tenantId, t.status),
    check("property_leases_window", sql`${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
    check("property_leases_billing_day", sql`${t.billingDay} between 1 and 31`),
    check("property_leases_terms", sql`${t.paymentTermsDays} >= 0 and ${t.graceDays} >= 0`),
    check("property_leases_deposit", sql`${t.securityDepositRequired} >= 0`),
    check("property_leases_cam_share", sql`${t.camSharePercent} is null or ${t.camSharePercent} between 0 and 100`),
    check(
      "property_leases_late_fee",
      sql`(${t.lateFeeType} = 'none' and ${t.lateFeeValue} = 0)
        or (${t.lateFeeType} = 'fixed' and ${t.lateFeeValue} > 0)
        or (${t.lateFeeType} = 'percent' and ${t.lateFeeValue} > 0 and ${t.lateFeeValue} <= 100)`,
    ),
  ],
);

/** Effective-dated recurring and one-time commercial charges. */
export const leaseCharges = pgTable(
  "lease_charges",
  {
    id: id(),
    orgId: orgRef(),
    leaseId: uuid("lease_id").notNull(),
    chargeType: text("charge_type", { enum: ["base_rent", "cam", "parking", "storage", "utility", "late_fee", "other"] }).notNull(),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    frequency: text("frequency", { enum: ["monthly", "quarterly", "annually", "one_time"] }).notNull().default("monthly"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    incomeAccountId: uuid("income_account_id"),
    itemId: uuid("item_id"),
    taxCodeId: uuid("tax_code_id"),
    ...auditColumns,
  },
  (t) => [
    index("lease_charges_effective").on(t.orgId, t.leaseId, t.effectiveFrom, t.effectiveTo),
    check("lease_charges_amount_positive", sql`${t.amount} > 0`),
    check("lease_charges_window", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** Append-only evidence of contractual rent changes. Applying one versions the base-rent charge. */
export const leaseEscalations = pgTable(
  "lease_escalations",
  {
    id: id(),
    orgId: orgRef(),
    leaseId: uuid("lease_id").notNull(),
    effectiveOn: date("effective_on").notNull(),
    method: text("method", { enum: ["percent", "fixed", "new_amount"] }).notNull(),
    value: money("value").notNull(),
    previousAmount: money("previous_amount"),
    newAmount: money("new_amount"),
    status: text("status", { enum: ["scheduled", "applied", "cancelled"] }).notNull().default("scheduled"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedBy: uuid("applied_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("lease_escalations_once").on(t.orgId, t.leaseId, t.effectiveOn),
    check("lease_escalations_value_positive", sql`${t.value} > 0`),
  ],
);

/** One immutable billable period per lease charge. */
export const leaseScheduleLines = pgTable(
  "lease_schedule_lines",
  {
    id: id(),
    orgId: orgRef(),
    leaseId: uuid("lease_id").notNull(),
    chargeId: uuid("charge_id").notNull(),
    periodStartsOn: date("period_starts_on").notNull(),
    periodEndsOn: date("period_ends_on").notNull(),
    dueOn: date("due_on").notNull(),
    amount: money("amount").notNull(),
    status: text("status", { enum: ["scheduled", "invoiced", "credited", "cancelled"] }).notNull().default("scheduled"),
    invoiceDocumentId: uuid("invoice_document_id"),
    sourceScheduleId: uuid("source_schedule_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("lease_schedule_period_once").on(t.orgId, t.chargeId, t.periodStartsOn),
    uniqueIndex("lease_schedule_late_fee_once").on(t.orgId, t.sourceScheduleId),
    index("lease_schedule_due").on(t.orgId, t.status, t.dueOn),
    check("lease_schedule_window", sql`${t.periodEndsOn} >= ${t.periodStartsOn}`),
    check("lease_schedule_amount_positive", sql`${t.amount} > 0`),
  ],
);

/** Deposit subledger; signs are derived from kind so stored amounts stay positive. */
export const securityDepositTransactions = pgTable(
  "security_deposit_transactions",
  {
    id: id(),
    orgId: orgRef(),
    leaseId: uuid("lease_id").notNull(),
    kind: text("kind", { enum: ["received", "interest", "applied", "refunded", "adjustment_increase", "adjustment_decrease"] }).notNull(),
    occurredOn: date("occurred_on").notNull(),
    amount: money("amount").notNull(),
    bankAccountId: uuid("bank_account_id"),
    offsetAccountId: uuid("offset_account_id"),
    appliedDocumentId: uuid("applied_document_id"),
    journalEntryId: uuid("journal_entry_id").notNull(),
    reversalOfId: uuid("reversal_of_id"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("security_deposits_lease_date").on(t.orgId, t.leaseId, t.occurredOn),
    uniqueIndex("security_deposits_entry").on(t.orgId, t.journalEntryId),
    uniqueIndex("security_deposits_reversal_once")
      .on(t.orgId, t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    check("security_deposits_amount_positive", sql`${t.amount} > 0`),
    check(
      "security_deposits_application_shape",
      sql`(${t.kind} = 'applied') = (${t.appliedDocumentId} is not null)`,
    ),
    check(
      "security_deposits_account_shape",
      sql`(${t.kind} not in ('received', 'refunded') or ${t.bankAccountId} is not null)
        and (${t.kind} not in ('interest', 'adjustment_increase', 'adjustment_decrease', 'applied') or ${t.offsetAccountId} is not null)`,
    ),
  ],
);

export const camPools = pgTable(
  "cam_pools",
  {
    id: id(),
    orgId: orgRef(),
    propertyId: uuid("property_id").notNull(),
    name: text("name").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    periodStartsOn: date("period_starts_on").notNull(),
    periodEndsOn: date("period_ends_on").notNull(),
    allocationBasis: text("allocation_basis", { enum: ["rentable_area", "equal", "custom"] }).notNull().default("rentable_area"),
    budgetAmount: money("budget_amount").notNull().default("0"),
    actualAmount: money("actual_amount"),
    expenseAccountIds: jsonb("expense_account_ids").$type<string[]>().notNull().default([]),
    status: text("status", { enum: ["draft", "open", "finalized", "invoiced"] }).notNull().default("draft"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: uuid("finalized_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("cam_pools_property_year_name").on(t.orgId, t.propertyId, t.fiscalYear, t.name),
    check("cam_pools_window", sql`${t.periodEndsOn} >= ${t.periodStartsOn}`),
    check("cam_pools_budget_nonnegative", sql`${t.budgetAmount} >= 0`),
    check("cam_pools_expense_accounts_array", sql`jsonb_typeof(${t.expenseAccountIds}) = 'array'`),
  ],
);

export const camAllocations = pgTable(
  "cam_allocations",
  {
    id: id(),
    orgId: orgRef(),
    poolId: uuid("pool_id").notNull(),
    leaseId: uuid("lease_id").notNull(),
    sharePercent: money("share_percent").notNull(),
    budgetAllocation: money("budget_allocation").notNull().default("0"),
    actualAllocation: money("actual_allocation"),
    billedEstimate: money("billed_estimate").notNull().default("0"),
    reconciliationAmount: money("reconciliation_amount"),
    invoiceDocumentId: uuid("invoice_document_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("cam_allocations_pool_lease").on(t.orgId, t.poolId, t.leaseId),
    check("cam_allocations_share", sql`${t.sharePercent} >= 0 and ${t.sharePercent} <= 100`),
  ],
);
