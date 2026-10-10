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
  uuid
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

/** Tenant-owned BOM components; its effectivity exclusion is defined in SQL. */
export const bomComponents = pgTable(
  "bom_components",
  {
    id: id(),
    orgId: orgRef(),
    assemblyItemId: uuid("assembly_item_id").notNull(),
    componentItemId: uuid("component_item_id").notNull(),
    quantityPer: money("quantity_per").notNull(),
    quantityBasis: text("quantity_basis",{enum:["per_unit","per_batch","per_formula"]}).notNull().default("per_unit"),
    formulaOutputQuantity: money("formula_output_quantity").notNull().default("1"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    operationSeq: integer("operation_seq"),
    scrapPct: money("scrap_pct"),
    isByproduct: boolean("is_byproduct").notNull().default(false),
    outputCostWeight: money("output_cost_weight"),
  },
  (t) => [
    check("bom_components_output_cost_weight",sql`${t.outputCostWeight} is null or (${t.isByproduct} and ${t.outputCostWeight}>0)`),
    check("bom_components_quantity_basis",sql`${t.quantityBasis} in ('per_unit','per_batch','per_formula') and ${t.formulaOutputQuantity}>0 and (${t.quantityBasis}='per_formula' or ${t.formulaOutputQuantity}=1) and (not ${t.isByproduct} or ${t.quantityBasis}<>'per_batch')`),
    check(
      "bom_components_effective_range_check",
      sql`${t.effectiveFrom} is null or ${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    check(
      "bom_components_operation_sequence_check",
      sql`${t.operationSeq} is null or ${t.operationSeq} > 0`,
    ),
    check(
      "bom_components_scrap_pct_check",
      sql`${t.scrapPct} is null or (${t.scrapPct} >= 0 and ${t.scrapPct} < 100)`,
    ),
  ],
);

/** Physical stock-keeping detail under the `locations` dimension. */
export const stockLocations = pgTable(
  "stock_locations",
  {
    id: id(),
    orgId: orgRef(),
    locationId: uuid("location_id").notNull(), // → locations dimension
    parentId: uuid("parent_id"), // bin hierarchy: zone → aisle → bin
    code: text("code").notNull(), // "A-03-14"
    kind: text("kind", { enum: ["warehouse", "zone", "bin", "staging", "transit", "quarantine", "subcontract"] })
      .notNull()
      .default("bin"),
    inventoryOwnership: text("inventory_ownership",{enum:["owned","vendor","customer"]}).notNull().default("owned"),
    ownerPartyId: uuid("owner_party_id"),
    custodianPartyId: uuid("custodian_party_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    check("stock_location_subcontract_custody",sql`(${t.kind}='subcontract')=(${t.custodianPartyId} is not null) and (${t.kind}<>'subcontract' or ${t.inventoryOwnership}='owned')`),
    uniqueIndex("stock_locations_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("stock_locations_org_code").on(t.orgId, t.locationId, t.code),
    uniqueIndex("stock_locations_org_warehouse_code")
      .on(t.orgId, t.code)
      .where(sql`${t.kind} = 'warehouse'`),
  ],
);

export const lots = pgTable(
  "lots",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    lotNumber: text("lot_number").notNull(),
    expiresOn: date("expires_on"),
    holdReason: text("hold_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("lots_item_number").on(t.itemId, t.lotNumber),
    uniqueIndex("lots_org_id_id_uniq").on(t.orgId, t.id),
  ],
);

export const serials = pgTable(
  "serials",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    serialNumber: text("serial_number").notNull(),
    lotId: uuid("lot_id"),
    holdReason: text("hold_reason"),
    status: text("status", { enum: ["registered", "in_stock", "committed", "shipped", "returned", "scrapped"] })
      .notNull()
      .default("in_stock"),
    currentStockLocationId: uuid("current_stock_location_id"),
    currentMissingCountMovementId: uuid("current_missing_count_movement_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("serials_item_number").on(t.itemId, t.serialNumber),
    uniqueIndex("serials_org_id_id_uniq").on(t.orgId, t.id),
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
    /** Owning legal entity: every movement books into exactly one subsidiary,
     *  so a subledger position can always be corroborated against the
     *  per-subsidiary GL balance the kernel trigger enforces. */
    subsidiaryId: uuid("subsidiary_id").notNull(),
    itemId: uuid("item_id").notNull(),
    kind: text("kind", {
      enum: ["receipt", "issue", "transfer_out", "transfer_in", "adjustment", "count", "assembly_build", "assembly_consume", "assembly_disassembly", "assembly_recovery", "return"],
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
    assemblyDisassemblyId: uuid("assembly_disassembly_id"),
    pairedMovementId: uuid("paired_movement_id"), // transfer_out ↔ transfer_in
    /** Stable key for retryable source effects; null for ordinary ad-hoc moves. */
    idempotencyKey: text("idempotency_key"),
    /** Append-only correction lineage. Exactly one posted movement may reverse
     *  a source movement; the source row itself remains immutable. */
    reversesMovementId: uuid("reverses_movement_id"),
    reversalReason: text("reversal_reason"),
    status: text("status", { enum: ["pending", "posted"] }).notNull().default("pending"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("inventory_movements_org_id_identity").on(t.orgId,t.id),
    index("inv_moves_item_loc").on(t.itemId, t.stockLocationId),
    index("inv_moves_doc_line").on(t.documentLineId),
    uniqueIndex("inventory_movements_org_idempotency")
      .on(t.orgId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex("inv_moves_one_reversal")
      .on(t.reversesMovementId)
      .where(sql`${t.reversesMovementId} is not null`),
    check("inv_moves_qty_nonzero", sql`${t.quantity} <> 0`),
    check(
      "inventory_movements_idempotency_key",
      sql`${t.idempotencyKey} is null or length(btrim(${t.idempotencyKey})) between 1 and 500`,
    ),
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

/** Immutable physical operation evidence, including quantity-only recovery. */
export const assemblyDisassemblies = pgTable('assembly_disassemblies', {
  id: uuid('id').primaryKey().notNull(), orgId: orgRef(), subsidiaryId: uuid('subsidiary_id').notNull(), bookId: uuid('book_id').notNull(),
  buildMovementId: uuid('build_movement_id').notNull(), quantity: money('quantity').notNull(), withdrawnValue: money('withdrawn_value').notNull(),
  movedOn: date('moved_on').notNull(), reason: text('reason').notNull(), components: jsonb('components').notNull(),
  journalEntryId: uuid('journal_entry_id'), createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(), createdBy: uuid('created_by').notNull(),
}, t => [uniqueIndex('assembly_disassemblies_org_id_id').on(t.orgId,t.id),index('assembly_disassemblies_source').on(t.orgId,t.buildMovementId,t.movedOn,t.id)]);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: id(),
    orgId: orgRef(),
    stockCountId: uuid("stock_count_id").notNull(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    varianceTolerance: money("variance_tolerance"),
    firstCountedQuantity: money("first_counted_quantity"),
    secondCountedQuantity: money("second_counted_quantity"),
    firstCountedBy: uuid("first_counted_by"),
    secondCountedBy: uuid("second_counted_by"),
    secondCountedAt: timestamp("second_counted_at",{withTimezone:true}),
    expectedQuantity: money("expected_quantity").notNull(),
    countedQuantity: money("counted_quantity"),
    adjustmentMovementId: uuid("adjustment_movement_id"),
    // Pre-guard immutable history preserved as evidence, exempt from the
    // guards below; never set on new writes (0293, 0299; provenance in 0326).
    isPreGuardLegacy: boolean("is_pre_guard_legacy").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("count_lines_count").on(t.stockCountId),
    // One line per (count, item, stock location, lot, serial) for unmarked rows.
    // NULLS NOT DISTINCT: an untracked item's lines carry NULL lot_id, and
    // without it the most common duplicate — the same item counted twice
    // with no lot — would escape the guard (0293). The SQL migration is
    // authoritative: it builds this as a standalone partial unique index
    // (a constraint cannot be partial), and the index builder cannot express
    // NULLS NOT DISTINCT, so the mirror states the partiality here and the
    // nulls discipline lives in 0293.
    uniqueIndex("stock_count_lines_no_duplicate_subject")
      .on(t.orgId, t.stockCountId, t.itemId, t.stockLocationId, t.lotId, t.serialId)
      .where(sql`NOT ${t.isPreGuardLegacy}`),
    // A physical count is never negative; NULL stays legal for uncounted
    // lines. Marked pre-guard rows are preserved as evidence (0299).
    check("stock_count_lines_counted_nonnegative", sql`${t.countedQuantity} IS NULL OR ${t.countedQuantity} >= 0 OR ${t.isPreGuardLegacy}`),
  ],
);

/**
 * Immutable build-time evidence stored on the posted inventory journal under
 * `custom.assemblyBuild`. Cost layers retain their source movement, and that
 * movement retains the journal, so a finished layer can always disclose the
 * exact recipe and content-addressed revision that produced it even though the
 * live BOM remains editable.
 */
export interface AssemblyBomRevisionEvidence {
  format: "openbooks.inventory-bom.v1";
  revision: `sha256:${string}`;
  assemblyItemId: string;
  components: Array<{
    componentItemId: string;
    quantityPer: string;
    sortOrder: number;
    quantityBasis?:"per_unit"|"per_batch"|"per_formula";
    formulaOutputQuantity?:string;
  }>;
}
