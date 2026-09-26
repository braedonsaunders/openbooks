import { sql } from "drizzle-orm";
import { BOOK_DEPRECIATION_CONVENTIONS } from "./depreciation-conventions";
import {
  bigserial,
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
 * formula over the depreciation variable set (engine/src/assets/depreciation-formula.ts:
 * NB, OC, RV, AL, CP, …) evaluated each period. Together with the built-ins these
 * make depreciation methods DATA. Category, asset, and book policy rows hold a
 * typed reference to the immutable formula definition.
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

export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: id(),
    orgId: orgRef(),
    /** Legal entity whose books own the asset and its depreciation. */
    subsidiaryId: uuid("subsidiary_id").notNull(),
    transferredFromAssetId: uuid("transferred_from_asset_id"),
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
    /** Active tenant formula override; built-in depreciationMethod is the fallback. */
    depreciationMethodId: uuid("depreciation_method_id"),
    usefulLifeMonths: integer("useful_life_months"),
    depreciationRatePercent: money("depreciation_rate_percent"),
    depreciationConvention: text("depreciation_convention", {
      enum: BOOK_DEPRECIATION_CONVENTIONS,
    }),
    /** Expected lifetime output for units-of-production depreciation. */
    depreciationUnitsTotal: money("depreciation_units_total"),
    /** Native per-asset GL overrides. Null means inherit from the category. */
    assetAccountId: uuid("asset_account_id"),
    accumulatedDepreciationAccountId: uuid("accumulated_depreciation_account_id"),
    depreciationExpenseAccountId: uuid("depreciation_expense_account_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("fixed_assets_org_asset_number_unique").on(
      t.orgId,
      t.assetNumber,
    ),
    index("assets_org_status").on(t.orgId, t.status),
  ],
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
    uniqueIndex("equipment_units_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("equipment_units_org_number").on(t.orgId, t.unitNumber),
    uniqueIndex("equipment_units_fixed_asset").on(t.fixedAssetId),
    index("equipment_units_org_status").on(t.orgId, t.status),
    index("equipment_units_charge_item").on(t.orgId, t.chargeItemId),
    check("equipment_units_nonnegative_purchase", sql`${t.purchasePrice} >= 0`),
    check("equipment_units_positive_capacity", sql`${t.capacityQuantity} is null or ${t.capacityQuantity} > 0`),
    check("equipment_units_valid_dates", sql`${t.acquiredOn} is null or ${t.inServiceOn} is null or ${t.inServiceOn} >= ${t.acquiredOn}`),
  ],
);

export const assetBasisChanges = pgTable("asset_basis_changes", {
  ordinal:bigserial("ordinal",{mode:"bigint"}).notNull(),
  unitsRemaining:money("units_remaining"),depreciableAfter:money("depreciable_after"),
  id: id(),
  orgId: orgRef(),
  assetId: uuid("asset_id").notNull(),
  bookId: uuid("book_id").notNull(),
  changeId: uuid("change_id").notNull(),
  effectiveOn: date("effective_on").notNull(),
  groupComponent: jsonb("group_component"),
  impairmentReleased: money("impairment_released").notNull().default("0"),
  costDelta: money("cost_delta").notNull(),
  accumulatedDelta: money("accumulated_delta").notNull(),
  salvageDelta: money("salvage_delta").notNull(),
  journalEntryId: uuid("journal_entry_id"),
  stubJournalEntryId: uuid("stub_journal_entry_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: uuid("created_by").notNull(),
});
