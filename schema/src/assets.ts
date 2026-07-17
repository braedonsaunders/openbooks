import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Fixed assets. Replaces the locked NetSuite FAM bundle with an open
 * register: assets → per-book depreciation schedules → period journals
 * (origin = 'depreciation'); every lifecycle change is an explicit event.
 */

export const assetCategories = pgTable("asset_categories", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(), // Vehicles, Shop Equipment, Computers…
  assetAccountId: uuid("asset_account_id").notNull(),
  accumulatedDepreciationAccountId: uuid("accumulated_depreciation_account_id").notNull(),
  depreciationExpenseAccountId: uuid("depreciation_expense_account_id").notNull(),
  gainLossAccountId: uuid("gain_loss_account_id"),
  defaultMethod: text("default_method", {
    enum: ["straight_line", "declining_balance", "double_declining", "units_of_production", "manual"],
  }).notNull().default("straight_line"),
  defaultLifeMonths: integer("default_life_months"),
  /** First-period convention: full_month (default), mid_month, half_year. */
  defaultConvention: text("default_convention", {
    enum: ["full_month", "mid_month", "half_year"],
  }).notNull().default("full_month"),
  /** e.g. CCA class for Canadian tax book: { "ca_cca_class": "10", "ca_cca_rate": 30 } */
  taxAttributes: jsonb("tax_attributes").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: id(),
    orgId: orgRef(),
    /** Legal entity whose books own the asset and its depreciation. */
    subsidiaryId: uuid("subsidiary_id").notNull(),
    categoryId: uuid("category_id").notNull(),
    assetNumber: text("asset_number").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "in_service", "fully_depreciated", "disposed", "written_off"] })
      .notNull()
      .default("draft"),
    acquiredOn: date("acquired_on"),
    inServiceOn: date("in_service_on"),
    acquisitionCost: money("acquisition_cost").notNull(),
    salvageValue: money("salvage_value").notNull().default("0"),
    /** Provenance: the bill/line that bought it. */
    sourceDocumentLineId: uuid("source_document_line_id"),
    serialNumber: text("serial_number"),
    // dimensions the asset's postings carry
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    custodianPartyId: uuid("custodian_party_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [index("assets_org_status").on(t.orgId, t.status)],
);

/** Per-book depreciation plan (primary book GAAP, tax book CCA, …). */
export const depreciationSchedules = pgTable(
  "depreciation_schedules",
  {
    id: id(),
    orgId: orgRef(),
    assetId: uuid("asset_id").notNull(),
    bookId: uuid("book_id").notNull(),
    method: text("method", {
      enum: ["straight_line", "declining_balance", "double_declining", "units_of_production", "manual"],
    }).notNull(),
    lifeMonths: integer("life_months"),
    ratePercent: money("rate_percent"), // declining-balance / CCA
    unitsTotal: money("units_total"), // units-of-production
    ...auditColumns,
  },
  (t) => [index("depr_schedules_asset").on(t.assetId)],
);

export const depreciationScheduleLines = pgTable(
  "depreciation_schedule_lines",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    periodId: uuid("period_id").notNull(),
    sequence: integer("sequence").notNull(),
    plannedAmount: money("planned_amount").notNull(),
    postedAmount: money("posted_amount"),
    journalEntryId: uuid("journal_entry_id"),
    ...auditColumns,
  },
  (t) => [index("depr_lines_schedule").on(t.scheduleId), index("depr_lines_period").on(t.periodId)],
);

/** Lifecycle events; disposals/revaluations carry their posted entries. */
export const assetEvents = pgTable(
  "asset_events",
  {
    id: id(),
    orgId: orgRef(),
    assetId: uuid("asset_id").notNull(),
    kind: text("kind", {
      enum: ["acquired", "placed_in_service", "revalued", "impaired", "transferred", "disposed", "written_off"],
    }).notNull(),
    occurredOn: date("occurred_on").notNull(),
    amount: money("amount"), // proceeds for disposal, delta for revaluation
    journalEntryId: uuid("journal_entry_id"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [index("asset_events_asset").on(t.assetId)],
);
