import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Pick lists and shipments (migration 0421). Both are documents of kind
 * `pick_list` / `shipment` reusing the documents lifecycle; the operational
 * stage (open, then done and final) lives here in a one-to-one side row, and
 * each line's link to the sales-order line it serves in `fulfillment_lines`.
 * Carriers are an organization's shipping carriers and their service levels;
 * they hold no credentials.
 */

export const FULFILLMENT_STAGES = ["open", "done"] as const;
export type FulfillmentStage = (typeof FULFILLMENT_STAGES)[number];

/** The ship-to address a shipment snapshots from the customer's default
 *  shipping address when it is created. */
export interface ShipToAddress {
  label: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export const carriers = pgTable(
  "carriers",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    services: text("services").array().notNull(),
    trackingUrlTemplate: text("tracking_url_template"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("carriers_org_code_unique").on(t.orgId, t.code),
    check(
      "carriers_tracking_url_template_check",
      sql`${t.trackingUrlTemplate} is null or position('{tracking}' in ${t.trackingUrlTemplate}) > 0`,
    ),
  ],
);

export const fulfillmentDocuments = pgTable(
  "fulfillment_documents",
  {
    documentId: uuid("document_id").primaryKey(),
    orgId: orgRef(),
    stage: text("stage", { enum: FULFILLMENT_STAGES }).notNull().default("open"),
    warehouseId: uuid("warehouse_id").notNull(),
    carrierId: uuid("carrier_id"),
    carrierService: text("carrier_service"),
    trackingNumber: text("tracking_number"),
    shipToAddress: jsonb("ship_to_address").$type<ShipToAddress>(),
    salesFulfillmentId: uuid("sales_fulfillment_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("fulfillment_documents_org_document_unique").on(t.orgId, t.documentId),
    index("fulfillment_documents_org_stage").on(t.orgId, t.stage),
  ],
);

export const fulfillmentLines = pgTable(
  "fulfillment_lines",
  {
    lineId: uuid("line_id").primaryKey(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    salesOrderLineId: uuid("sales_order_line_id").notNull(),
    pickLineId: uuid("pick_line_id"),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    carton: text("carton"),
    ...auditColumns,
  },
  (t) => [
    index("fulfillment_lines_org_document").on(t.orgId, t.documentId),
    index("fulfillment_lines_org_sales_order_line").on(t.orgId, t.salesOrderLineId),
  ],
);

export type CarrierRow = typeof carriers.$inferSelect;
