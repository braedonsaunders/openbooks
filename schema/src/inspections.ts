import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";
import { items } from "./documents";
import { subsidiaries } from "./subsidiaries";
import { inventoryMovements, lots, serials, stockLocations } from "./inventory";
import { mfgWorkOrders, mfgWoOperations } from "./manufacturing";

export const inventoryInspectionPlans=pgTable("inventory_inspection_plans",{
  id:id(),orgId:orgRef(),revision:integer("revision").notNull().default(1),reason:text("reason").notNull(),name:text("name").notNull(),itemId:uuid("item_id").notNull(),point:text("point",{enum:["receipt","operation"]}).notNull(),operationSequence:integer("operation_sequence"),effectiveFrom:date("effective_from").notNull(),effectiveTo:date("effective_to"),measures:jsonb("measures").notNull().default([]),...auditColumns,
},(t):PgTableExtraConfigValue[]=>[
  uniqueIndex("inventory_inspection_plans_org_identity").on(t.orgId,t.id),
  foreignKey({name:"inspection_plan_item_fk",columns:[t.orgId,t.itemId],foreignColumns:[items.orgId,items.id]}),
  check("inspection_plan_point",sql`(${t.point}='receipt' and ${t.operationSequence} is null) or (${t.point}='operation' and ${t.operationSequence}>0)`),
  check("inspection_plan_window",sql`${t.effectiveTo} is null or ${t.effectiveTo}>${t.effectiveFrom}`),
  check("inspection_plan_measures",sql`jsonb_typeof(${t.measures})='array' and jsonb_array_length(${t.measures})<=100`),
  check("inspection_plan_revision",sql`${t.revision}>0 and length(btrim(${t.reason})) between 5 and 500`),
]);
export const inventoryInspections=pgTable("inventory_inspections",{
  id:id(),orgId:orgRef(),planId:uuid("plan_id").notNull(),planSnapshot:jsonb("plan_snapshot").notNull(),itemId:uuid("item_id").notNull(),subsidiaryId:uuid("subsidiary_id").notNull(),stockLocationId:uuid("stock_location_id"),receiptMovementId:uuid("receipt_movement_id"),workOrderId:uuid("work_order_id"),operationId:uuid("operation_id"),inspectionSequence:integer("inspection_sequence"),lotId:uuid("lot_id"),serialId:uuid("serial_id"),quantity:money("quantity").notNull(),status:text("status",{enum:["pending","pass","fail"]}).notNull().default("pending"),measurements:jsonb("measurements").notNull().default({}),reason:text("reason"),inspectedAt:timestamp("inspected_at",{withTimezone:true}),inspectedBy:uuid("inspected_by"),disposition:text("disposition",{enum:["use_as_is","scrap","rework"]}),dispositionReason:text("disposition_reason"),dispositionResult:jsonb("disposition_result"),disposedAt:timestamp("disposed_at",{withTimezone:true}),disposedBy:uuid("disposed_by"),reworkWorkOrderId:uuid("rework_work_order_id"),reworkOperationId:uuid("rework_operation_id"),reworkCompletedAt:timestamp("rework_completed_at",{withTimezone:true}),scrapMovementId:uuid("scrap_movement_id"),...auditColumns,
},(t):PgTableExtraConfigValue[]=>[
  uniqueIndex("inventory_inspections_org_identity").on(t.orgId,t.id),
  uniqueIndex("inventory_inspection_receipt_identity").on(t.orgId,t.receiptMovementId),
  uniqueIndex("inspection_one_receipt_rework_work").on(t.orgId,t.reworkWorkOrderId).where(sql`${t.reworkWorkOrderId} is not null`),
  index("inventory_inspection_operation_identity").on(t.orgId,t.operationId,t.createdAt),
  uniqueIndex("inventory_inspection_operation_sequence").on(t.orgId,t.operationId,t.inspectionSequence),
  check("inspection_operation_sequence",sql`(${t.operationId} is null) = (${t.inspectionSequence} is null) and (${t.inspectionSequence} is null or ${t.inspectionSequence}>0)`),
  index("inventory_inspection_queue").on(t.orgId,t.subsidiaryId,t.status,t.createdAt),
  foreignKey({name:"inspection_plan_fk",columns:[t.orgId,t.planId],foreignColumns:[inventoryInspectionPlans.orgId,inventoryInspectionPlans.id]}),
  foreignKey({name:"inspection_item_fk",columns:[t.orgId,t.itemId],foreignColumns:[items.orgId,items.id]}),
  foreignKey({name:"inspection_entity_fk",columns:[t.orgId,t.subsidiaryId],foreignColumns:[subsidiaries.orgId,subsidiaries.id]}),
  foreignKey({name:"inspection_location_fk",columns:[t.orgId,t.stockLocationId],foreignColumns:[stockLocations.orgId,stockLocations.id]}),
  foreignKey({name:"inspection_receipt_fk",columns:[t.orgId,t.receiptMovementId],foreignColumns:[inventoryMovements.orgId,inventoryMovements.id]}),
  foreignKey({name:"inspection_work_fk",columns:[t.orgId,t.workOrderId],foreignColumns:[mfgWorkOrders.orgId,mfgWorkOrders.id]}),
  foreignKey({name:"inspection_operation_fk",columns:[t.orgId,t.workOrderId,t.operationId],foreignColumns:[mfgWoOperations.orgId,mfgWoOperations.workOrderId,mfgWoOperations.id]}),
  foreignKey({name:"inspection_lot_fk",columns:[t.orgId,t.lotId],foreignColumns:[lots.orgId,lots.id]}),
  foreignKey({name:"inspection_serial_fk",columns:[t.orgId,t.serialId],foreignColumns:[serials.orgId,serials.id]}),
  foreignKey({name:"inspection_scrap_fk",columns:[t.orgId,t.scrapMovementId],foreignColumns:[inventoryMovements.orgId,inventoryMovements.id]}),
  foreignKey({name:"inspection_rework_fk",columns:[t.orgId,t.reworkOperationId],foreignColumns:[mfgWoOperations.orgId,mfgWoOperations.id]}),
  foreignKey({name:"inspection_rework_work_fk",columns:[t.orgId,t.reworkWorkOrderId],foreignColumns:[mfgWorkOrders.orgId,mfgWorkOrders.id]}),
  check("inspection_subject",sql`(${t.receiptMovementId} is not null and ${t.operationId} is null and ${t.stockLocationId} is not null) or (${t.receiptMovementId} is null and ${t.operationId} is not null and ${t.workOrderId} is not null)`),
  check("inspection_quantity",sql`${t.quantity}>0`),
  check("inspection_tracking",sql`${t.lotId} is not null or ${t.serialId} is not null or ${t.operationId} is not null`),
  check("inspection_result",sql`(${t.status}='pending' and ${t.inspectedAt} is null and ${t.inspectedBy} is null and ${t.disposition} is null) or (${t.status} in ('pass','fail') and ${t.inspectedAt} is not null and ${t.inspectedBy} is not null)`),
  check("inspection_disposition",sql`(${t.disposition} is null and ${t.disposedAt} is null and ${t.disposedBy} is null) or (${t.status}='fail' and ${t.disposition} in ('use_as_is','scrap','rework') and ${t.disposedAt} is not null and ${t.disposedBy} is not null and ${t.dispositionReason} is not null and ${t.dispositionResult} is not null)`),
]);
