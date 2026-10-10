import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Warehouses and putaway rules (migration 0419). A warehouse is a
 * warehouse-kind stock location; this row adds its name, address and
 * lifecycle. Bins belong to a warehouse only through the stock-location
 * parent hierarchy, and stock belongs to a legal entity only through its
 * cost layers, so neither carries a warehouse or subsidiary column here.
 */

export const WAREHOUSE_STATUSES = ["draft", "active", "suspended", "retired"] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];

export const PUTAWAY_STRATEGIES = ["fixed-bin", "empty-bin", "bulk-zone"] as const;
export type PutawayStrategy = (typeof PUTAWAY_STRATEGIES)[number];

export const warehouses = pgTable(
  "warehouses",
  {
    stockLocationId: uuid("stock_location_id").primaryKey(),
    orgId: orgRef(),
    name: text("name").notNull(),
    status: text("status", { enum: WAREHOUSE_STATUSES }).notNull(),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: text("country"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    statusChangedBy: uuid("status_changed_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("warehouses_org_stock_location_unique").on(t.orgId, t.stockLocationId),
    check("warehouses_country_check", sql`${t.country} is null or ${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

export const putawayRules = pgTable(
  "putaway_rules",
  {
    id: id(),
    orgId: orgRef(),
    warehouseId: uuid("warehouse_id").notNull(),
    sequence: integer("sequence").notNull(),
    itemId: uuid("item_id"),
    strategy: text("strategy", { enum: PUTAWAY_STRATEGIES }).notNull(),
    targetLocationId: uuid("target_location_id").notNull(),
    capacityQuantity: numeric("capacity_quantity", { precision: 28, scale: 8 }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("putaway_rules_warehouse_sequence_unique").on(t.orgId, t.warehouseId, t.sequence),
    check(
      "putaway_rules_bulk_zone_capacity_check",
      sql`${t.strategy} <> 'bulk-zone' or ${t.capacityQuantity} is not null`,
    ),
  ],
);

export type WarehouseRow = typeof warehouses.$inferSelect;
export type PutawayRuleRow = typeof putawayRules.$inferSelect;

/**
 * Designated default receiving and fulfillment warehouse per legal entity.
 * subsidiary_id null is the company-wide row; otherwise the legal entity.
 * Single-warehouse orgs need no row — the only active warehouse is already
 * the implicit default. Resolution prefers the entity row, then the company
 * row, then the implicit default.
 */
export const warehouseDefaults = pgTable(
  "warehouse_defaults",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id"),
    warehouseId: uuid("warehouse_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("warehouse_defaults_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("warehouse_defaults_org_subsidiary_unique")
      .on(t.orgId, t.subsidiaryId)
      .nullsNotDistinct(),
  ],
);

export type WarehouseDefaultRow = typeof warehouseDefaults.$inferSelect;
