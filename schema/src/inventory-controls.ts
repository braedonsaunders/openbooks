import {
  pgTable,
  uuid,
  text,
  date,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { id, orgRef, money, auditColumns } from "./helpers";

export const inventoryCountPolicies = pgTable("inventory_count_policies", {
  id: id(),
  orgId: orgRef(),
  subsidiaryId: uuid("subsidiary_id").notNull(),
  abcClass: text("abc_class", { enum: ["A", "B", "C"] }).notNull(),
  intervalDays: integer("interval_days").notNull(),
  varianceTolerance: money("variance_tolerance").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  ...auditColumns,
});
export const consignmentStock = pgTable("consignment_stock", {
  id: id(),
  orgId: orgRef(),
  subsidiaryId: uuid("subsidiary_id").notNull(),
  itemId: uuid("item_id").notNull(),
  stockLocationId: uuid("stock_location_id").notNull(),
  ownerPartyId: uuid("owner_party_id").notNull(),
  ownerKind: text("owner_kind", { enum: ["vendor", "customer"] }).notNull(),
  lotId: uuid("lot_id"),
  serialId: uuid("serial_id"),
  receivedOn: date("received_on").notNull(),
  originalQuantity: money("original_quantity").notNull(),
  remainingQuantity: money("remaining_quantity").notNull(),
  reason: text("reason").notNull(),
  ...auditColumns,
});
export const consignmentEvents = pgTable("consignment_events", {
  id: id(),
  orgId: orgRef(),
  stockId: uuid("stock_id").notNull(),
  kind: text("kind", {
    enum: ["receive", "transfer", "return", "take_ownership"],
  }).notNull(),
  quantity: money("quantity").notNull(),
  occurredOn: date("occurred_on").notNull(),
  toStockId: uuid("to_stock_id"),
  receiptMovementId: uuid("receipt_movement_id"),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: uuid("created_by").notNull(),
});
