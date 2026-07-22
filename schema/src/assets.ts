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
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * User-authored depreciation methods — the "formula builder". A method is a
 * formula over the depreciation variable set (engine/src/depreciation-formula.ts:
 * NB, OC, RV, AL, CP, …) evaluated each period. Together with the built-ins these
 * make depreciation methods DATA. A category/asset references one by `code`.
 */
export const depreciationMethods = pgTable(
  "depreciation_methods",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** Expression over the variable set, e.g. "(OC-RV)*(AL-CP+1)/(AL*(AL+1)/2)". */
    formula: text("formula").notNull(),
    endOfLife: text("end_of_life", { enum: ["fully_depreciate", "retain_balance"] }).notNull().default("fully_depreciate"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("depreciation_methods_org_code").on(t.orgId, t.code)],
);

/**
 * Fixed assets. Replaces the locked source platform FAM bundle with an open
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
    /** Native per-asset depreciation overrides. Null means use the category/book policy. */
    depreciationMethod: text("depreciation_method", {
      enum: ["straight_line", "declining_balance", "double_declining", "units_of_production", "manual"],
    }),
    usefulLifeMonths: integer("useful_life_months"),
    depreciationRatePercent: money("depreciation_rate_percent"),
    depreciationConvention: text("depreciation_convention", {
      enum: ["full_month", "mid_month", "half_year"],
    }),
    /** Expected lifetime output for units-of-production depreciation. */
    depreciationUnitsTotal: money("depreciation_units_total"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [index("assets_org_status").on(t.orgId, t.status)],
);

/**
 * Chargeable equipment units. This is a financial/job-costing register, not an
 * inspections, maintenance, dispatch or telematics system. Many serialized
 * units may share one equipment-charge item and its rate books. A unit may
 * optionally link to the fixed-asset register when it is capitalized.
 */
export const equipmentUnits = pgTable(
  "equipment_units",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    unitNumber: text("unit_number").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "active", "inactive", "retired"] }).notNull().default("draft"),
    chargeItemId: uuid("charge_item_id"),
    fixedAssetId: uuid("fixed_asset_id"),
    rateBookId: uuid("rate_book_id"),
    purchasePrice: money("purchase_price").notNull().default("0"),
    acquiredOn: date("acquired_on"),
    inServiceOn: date("in_service_on"),
    serialNumber: text("serial_number"),
    capacityQuantity: money("capacity_quantity"),
    capacityUnit: text("capacity_unit"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("equipment_units_org_number").on(t.orgId, t.unitNumber),
    uniqueIndex("equipment_units_fixed_asset").on(t.fixedAssetId),
    index("equipment_units_org_status").on(t.orgId, t.status),
    index("equipment_units_charge_item").on(t.orgId, t.chargeItemId),
    check("equipment_units_nonnegative_purchase", sql`${t.purchasePrice} >= 0`),
    check("equipment_units_positive_capacity", sql`${t.capacityQuantity} is null or ${t.capacityQuantity} > 0`),
    check("equipment_units_valid_dates", sql`${t.acquiredOn} is null or ${t.inServiceOn} is null or ${t.inServiceOn} >= ${t.acquiredOn}`),
  ],
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
  (t) => [
    uniqueIndex("depr_schedules_org_asset_book").on(t.orgId, t.assetId, t.bookId),
    index("depr_schedules_asset").on(t.assetId),
    check("depr_schedules_positive_life", sql`${t.lifeMonths} is null or ${t.lifeMonths} > 0`),
    check("depr_schedules_nonnegative_rate", sql`${t.ratePercent} is null or ${t.ratePercent} >= 0`),
    check("depr_schedules_positive_units", sql`${t.unitsTotal} is null or ${t.unitsTotal} > 0`),
  ],
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
    /** Calculation provenance: generated formula, accountant evidence, or imported opening history. */
    source: text("source", { enum: ["formula", "manual", "production_usage", "imported"] }).notNull().default("formula"),
    inputId: uuid("input_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("depr_lines_org_formula_period")
      .on(t.orgId, t.scheduleId, t.periodId)
      .where(sql`${t.source} = 'formula'`),
    index("depr_lines_schedule").on(t.scheduleId),
    index("depr_lines_period").on(t.periodId),
    check(
      "depr_lines_amount_direction",
      sql`${t.source} in ('manual', 'production_usage')
          or (${t.plannedAmount} >= 0 and (${t.postedAmount} is null or ${t.postedAmount} >= 0))`,
    ),
    check(
      "depr_lines_posting_evidence_pair",
      sql`(${t.postedAmount} is null and ${t.journalEntryId} is null) or (${t.postedAmount} is not null and (${t.postedAmount} = 0 or ${t.journalEntryId} is not null or ${t.source} = 'imported'))`,
    ),
    check(
      "depr_lines_input_provenance",
      sql`(${t.source} in ('formula', 'imported') and ${t.inputId} is null) or (${t.source} in ('manual', 'production_usage') and ${t.inputId} is not null)`,
    ),
  ],
);

/**
 * Append-preserved accountant inputs supporting manual and units-of-production
 * depreciation. Replacing an unposted input voids it and inserts a successor;
 * posted evidence is protected by the kernel trigger.
 */
export const depreciationInputs = pgTable(
  "depreciation_inputs",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    periodId: uuid("period_id").notNull(),
    kind: text("kind", { enum: ["manual", "production_usage"] }).notNull(),
    manualAmount: money("manual_amount"),
    productionUnits: money("production_units"),
    memo: text("memo").notNull(),
    /** File-cabinet attachment, meter reading id, work order, or other source reference. */
    evidenceReference: text("evidence_reference").notNull(),
    supersedesInputId: uuid("supersedes_input_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    ...auditColumns,
  },
  (t) => [
    index("depr_inputs_schedule_period").on(t.scheduleId, t.periodId),
    index("depr_inputs_org_active").on(t.orgId, t.scheduleId, t.voidedAt),
    check(
      "depr_inputs_kind_value",
      sql`(${t.kind} = 'manual' and ${t.manualAmount} is not null and ${t.manualAmount} <> 0 and ${t.productionUnits} is null)
          or (${t.kind} = 'production_usage' and ${t.productionUnits} is not null and ${t.productionUnits} <> 0 and ${t.manualAmount} is null)`,
    ),
    check("depr_inputs_evidence_required", sql`length(btrim(${t.memo})) > 0 and length(btrim(${t.evidenceReference})) > 0`),
  ],
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

/**
 * Per-book depreciation policy (multi-book): overrides the method / life / rate /
 * convention for a given category on a given accounting book. Lets the primary
 * book run one method while an alternate/tax book runs another. Absent → the
 * book uses the asset's own overrides and the category defaults.
 */
export const depreciationBookPolicies = pgTable(
  "depreciation_book_policies",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    categoryId: uuid("category_id").notNull(),
    method: text("method", {
      enum: ["straight_line", "declining_balance", "double_declining", "units_of_production", "manual"],
    }).notNull().default("straight_line"),
    lifeMonths: integer("life_months"),
    ratePercent: money("rate_percent"),
    unitsTotal: money("units_total"),
    convention: text("convention", { enum: ["full_month", "mid_month", "half_year"] }).notNull().default("full_month"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("dep_book_policies_identity").on(t.orgId, t.bookId, t.categoryId),
    check("dep_book_policies_positive_units", sql`${t.unitsTotal} is null or ${t.unitsTotal} > 0`),
  ],
);
