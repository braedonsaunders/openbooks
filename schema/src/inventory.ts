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
 * Inventory subledger. Quantities and values move ONLY through
 * inventory_movements; every valued movement posts a journal entry through
 * the kernel, so inventory GL balance = Σ cost-layer remaining value by
 * construction. Costing is per item per stock location profile:
 * FIFO and moving-average via cost layers, standard cost with variance
 * postings.
 */

/** Physical stock-keeping detail under the `locations` dimension. */
export const stockLocations = pgTable(
  "stock_locations",
  {
    id: id(),
    orgId: orgRef(),
    locationId: uuid("location_id").notNull(), // → locations dimension
    parentId: uuid("parent_id"), // bin hierarchy: zone → aisle → bin
    code: text("code").notNull(), // "A-03-14"
    kind: text("kind", { enum: ["warehouse", "zone", "bin", "staging", "transit", "quarantine"] })
      .notNull()
      .default("bin"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("stock_locations_org_code").on(t.orgId, t.locationId, t.code)],
);

export const itemInventoryProfiles = pgTable("item_inventory_profiles", {
  id: id(),
  orgId: orgRef(),
  itemId: uuid("item_id").notNull().unique(),
  costingMethod: text("costing_method", { enum: ["fifo", "moving_average", "standard"] })
    .notNull()
    .default("moving_average"),
  tracking: text("tracking", { enum: ["none", "lot", "serial"] }).notNull().default("none"),
  assetAccountId: uuid("asset_account_id").notNull(), // inventory on hand
  cogsAccountId: uuid("cogs_account_id").notNull(),
  adjustmentAccountId: uuid("adjustment_account_id"),
  varianceAccountId: uuid("variance_account_id"), // standard-cost variance
  /** Received-not-billed / GRNI clearing account. When set, a vendor bill's
   *  inventory line posts here and the receipt drains it into inventory (this
   *  is what lets standard-cost items book purchase variance from a bill).
   *  When null, the bill posts straight to the asset account and the receipt
   *  records the layer without its own entry. */
  receivedNotBilledAccountId: uuid("received_not_billed_account_id"),
  standardCost: money("standard_cost"),
  baseUnit: text("base_unit").notNull().default("ea"),
  /** unit conversions: { "box": 12, "pallet": 720 } — base units per unit */
  unitConversions: jsonb("unit_conversions").$type<Record<string, number>>().notNull().default({}),
  reorderPoint: money("reorder_point"),
  preferredStockLevel: money("preferred_stock_level"),
  /** Negative stock is opt-in and must have a defensible provisional cost. */
  allowNegativeInventory: boolean("allow_negative_inventory").notNull().default(false),
  negativeCostBasis: text("negative_cost_basis", { enum: ["last_receipt", "standard", "configured"] })
    .notNull().default("last_receipt"),
  provisionalUnitCost: money("provisional_unit_cost"),
  ...auditColumns,
}, (t) => [
  check(
    "item_inventory_profiles_tracking_costing",
    sql`${t.tracking} = 'none' or ${t.costingMethod} <> 'moving_average'`,
  ),
]);

export const lots = pgTable(
  "lots",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    lotNumber: text("lot_number").notNull(),
    expiresOn: date("expires_on"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("lots_item_number").on(t.itemId, t.lotNumber)],
);

export const serials = pgTable(
  "serials",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    serialNumber: text("serial_number").notNull(),
    status: text("status", { enum: ["registered", "in_stock", "committed", "shipped", "returned", "scrapped"] })
      .notNull()
      .default("in_stock"),
    currentStockLocationId: uuid("current_stock_location_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("serials_item_number").on(t.itemId, t.serialNumber),
    check(
      "serials_status_location",
      sql`(${t.status} = 'in_stock' and ${t.currentStockLocationId} is not null)
          or (${t.status} <> 'in_stock' and ${t.currentStockLocationId} is null)`,
    ),
  ],
);

/**
 * The inventory event log — append-only once posted as permanent subledger
 * history.
 * Receipts create cost layers; issues consume them (see consumptions);
 * transfers move quantity between stock locations at carried cost.
 */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    kind: text("kind", {
      enum: ["receipt", "issue", "transfer_out", "transfer_in", "adjustment", "count", "assembly_build", "assembly_consume", "return"],
    }).notNull(),
    movedAt: timestamp("moved_at", { withTimezone: true }).notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    /** Signed base-unit quantity: + into the location, − out of it. */
    quantity: money("quantity").notNull(),
    unitCost: money("unit_cost"), // valued at post time
    totalValue: money("total_value"), // = quantity × unitCost (sign follows quantity)
    /** Provenance and posting linkage. */
    documentLineId: uuid("document_line_id"),
    journalEntryId: uuid("journal_entry_id"),
    pairedMovementId: uuid("paired_movement_id"), // transfer_out ↔ transfer_in
    /** Append-only correction lineage. Exactly one posted movement may reverse
     *  a source movement; the source row itself remains immutable. */
    reversesMovementId: uuid("reverses_movement_id"),
    reversalReason: text("reversal_reason"),
    status: text("status", { enum: ["pending", "posted"] }).notNull().default("pending"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("inv_moves_item_loc").on(t.itemId, t.stockLocationId),
    index("inv_moves_doc_line").on(t.documentLineId),
    uniqueIndex("inv_moves_one_reversal")
      .on(t.reversesMovementId)
      .where(sql`${t.reversesMovementId} is not null`),
    check("inv_moves_qty_nonzero", sql`${t.quantity} <> 0`),
    check(
      "inv_moves_reversal_evidence",
      sql`(${t.reversesMovementId} is null and ${t.reversalReason} is null)
          or (${t.reversesMovementId} is not null
              and ${t.reversesMovementId} <> ${t.id}
              and ${t.reversalReason} is not null
              and length(btrim(${t.reversalReason})) between 5 and 500
              and ${t.createdBy} is not null)`,
    ),
  ],
);

/**
 * Cost layers: one per valued receipt. `remainingQuantity` counts down as
 * issues consume the layer (FIFO order, or proportionally for
 * moving-average revaluations). Layer accounting makes COGS auditable to
 * the originating receipt — source platform's costing is a black box.
 */
export const costLayers = pgTable(
  "cost_layers",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    sourceMovementId: uuid("source_movement_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    originalQuantity: money("original_quantity").notNull(),
    remainingQuantity: money("remaining_quantity").notNull(),
    unitCost: money("unit_cost").notNull(),
    ...auditColumns,
  },
  (t) => [
    index("cost_layers_item_loc_fifo").on(t.itemId, t.stockLocationId, t.receivedAt),
    check("cost_layers_remaining", sql`${t.remainingQuantity} >= 0 AND ${t.remainingQuantity} <= ${t.originalQuantity}`),
  ],
);

export const costLayerConsumptions = pgTable(
  "cost_layer_consumptions",
  {
    id: id(),
    orgId: orgRef(),
    costLayerId: uuid("cost_layer_id").notNull(),
    issueMovementId: uuid("issue_movement_id").notNull(),
    quantity: money("quantity").notNull(),
    unitCost: money("unit_cost").notNull(),
    ...auditColumns,
  },
  (t) => [
    index("layer_consumptions_layer").on(t.costLayerId),
    index("layer_consumptions_movement").on(t.issueMovementId),
    check("layer_consumptions_positive", sql`${t.quantity} > 0`),
  ],
);

/** Quantity issued before it was received, carried at an evidenced provisional
 * cost until a later receipt settles it and posts any true-up to COGS. */
export const inventoryProvisionalCosts = pgTable(
  "inventory_provisional_costs",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    issueMovementId: uuid("issue_movement_id").notNull(),
    originalQuantity: money("original_quantity").notNull(),
    remainingQuantity: money("remaining_quantity").notNull(),
    provisionalUnitCost: money("provisional_unit_cost").notNull(),
    costBasis: text("cost_basis", { enum: ["last_receipt", "standard", "configured"] }).notNull(),
    ...auditColumns,
  },
  (t) => [
    index("inventory_provisional_fifo").on(t.itemId, t.stockLocationId, t.createdAt),
    check("inventory_provisional_quantity", sql`${t.originalQuantity} > 0 AND ${t.remainingQuantity} >= 0 AND ${t.remainingQuantity} <= ${t.originalQuantity}`),
    check("inventory_provisional_cost", sql`${t.provisionalUnitCost} >= 0`),
  ],
);

/** Immutable receipt-to-shortfall matching and cost-correction evidence. */
export const inventoryProvisionalSettlements = pgTable(
  "inventory_provisional_settlements",
  {
    id: id(),
    orgId: orgRef(),
    provisionalCostId: uuid("provisional_cost_id").notNull(),
    receiptMovementId: uuid("receipt_movement_id").notNull(),
    quantity: money("quantity").notNull(),
    provisionalUnitCost: money("provisional_unit_cost").notNull(),
    receiptUnitCost: money("receipt_unit_cost").notNull(),
    correctionAmount: money("correction_amount").notNull(),
    correctionJournalEntryId: uuid("correction_journal_entry_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    index("inventory_provisional_settlement_receipt").on(t.receiptMovementId),
    check("inventory_provisional_settlement_quantity", sql`${t.quantity} > 0`),
  ],
);

export const stockCounts = pgTable("stock_counts", {
  id: id(),
  orgId: orgRef(),
  locationId: uuid("location_id").notNull(),
  status: text("status", { enum: ["draft", "counting", "review", "posted", "cancelled"] })
    .notNull()
    .default("draft"),
  countedOn: date("counted_on").notNull(),
  postedEntryId: uuid("posted_entry_id"),
  memo: text("memo"),
  ...auditColumns,
});

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: id(),
    orgId: orgRef(),
    stockCountId: uuid("stock_count_id").notNull(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    lotId: uuid("lot_id"),
    expectedQuantity: money("expected_quantity").notNull(),
    countedQuantity: money("counted_quantity"),
    adjustmentMovementId: uuid("adjustment_movement_id"),
    ...auditColumns,
  },
  (t) => [index("count_lines_count").on(t.stockCountId)],
);

/**
 * Landed costs (freight, duty, brokerage) allocated onto receipt layers —
 * by value, quantity, or weight — revaluing the layers and posting the
 * offset through the kernel.
 */
export const landedCostAllocations = pgTable(
  "landed_cost_allocations",
  {
    id: id(),
    orgId: orgRef(),
    /** The cost source: a bill line for freight/duty/etc. Null for a manual
     *  landed-cost entry not tied to a document line. */
    sourceDocumentLineId: uuid("source_document_line_id"),
    /** Present for multi-target voucher allocations; null for the legacy
     * single-target allocation service. */
    voucherId: uuid("voucher_id"),
    targetCostLayerId: uuid("target_cost_layer_id").notNull(),
    basis: text("basis", { enum: ["value", "quantity", "weight", "manual"] }).notNull(),
    amount: money("amount").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    /** Append-only cancellation evidence. A reversal row carries a negative
     * amount and points to the positive allocation it reverses. */
    reversesAllocationId: uuid("reverses_allocation_id"),
    reversalReason: text("reversal_reason"),
    ...auditColumns,
  },
  (t) => [index("landed_cost_source").on(t.sourceDocumentLineId)],
);

/** Bill of materials for light assembly (kits / builds). */
export const bomComponents = pgTable(
  "bom_components",
  {
    id: id(),
    orgId: orgRef(),
    assemblyItemId: uuid("assembly_item_id").notNull(),
    componentItemId: uuid("component_item_id").notNull(),
    quantityPer: money("quantity_per").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => [uniqueIndex("bom_assembly_component").on(t.assemblyItemId, t.componentItemId)],
);
