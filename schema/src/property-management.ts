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
  uuid
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
    importKey: text("import_key"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("security_deposits_lease_date").on(t.orgId, t.leaseId, t.occurredOn),
    uniqueIndex("security_deposits_entry").on(t.orgId, t.journalEntryId),
    uniqueIndex("security_deposits_reversal_once")
      .on(t.orgId, t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    uniqueIndex("security_deposits_import_key_once")
      .on(t.orgId, t.importKey)
      .where(sql`${t.importKey} is not null`),
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
    status: text("status", { enum: ["draft", "open", "finalized", "invoiced", "cancelled"] }).notNull().default("draft"),
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
