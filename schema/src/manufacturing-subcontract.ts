import { sql } from "drizzle-orm";
import { check,foreignKey,jsonb,pgTable,text,uniqueIndex,uuid } from "drizzle-orm/pg-core";
import { auditColumns,id,money,orgRef } from "./helpers";
import { mfgWorkOrders,mfgWoOperations,mfgWoMaterials } from "./manufacturing";
import { parties } from "./parties";
import { stockLocations,inventoryMovements } from "./inventory";
import { documents } from "./documents";
import { accounts } from "./coa";
import { journalEntries } from "./ledger";

/** An outsourced production operation; project purchasing keeps its own documents. */
export const mfgSubcontracts=pgTable("mfg_subcontracts",{
  id:id(),orgId:orgRef(),workOrderId:uuid("work_order_id").notNull(),operationId:uuid("operation_id").notNull(),
  vendorId:uuid("vendor_id").notNull(),custodyLocationId:uuid("custody_location_id").notNull(),
  quantityExpected:money("quantity_expected").notNull(),
  status:text("status",{enum:["ready","sent","received","cancelled"]}).notNull().default("ready"),
  requestSnapshot:jsonb("request_snapshot").notNull(),cancelReason:text("cancel_reason"),...auditColumns,
},t=>[
  uniqueIndex("mfg_subcontracts_org_id_unique").on(t.orgId,t.id),
  uniqueIndex("mfg_subcontract_open_operation").on(t.orgId,t.operationId).where(sql`${t.status}<>'cancelled'`),
  foreignKey({name:"mfg_subcontract_order_fk",columns:[t.orgId,t.workOrderId],foreignColumns:[mfgWorkOrders.orgId,mfgWorkOrders.id]}),
  foreignKey({name:"mfg_subcontract_operation_fk",columns:[t.orgId,t.operationId],foreignColumns:[mfgWoOperations.orgId,mfgWoOperations.id]}),
  foreignKey({name:"mfg_subcontract_vendor_fk",columns:[t.orgId,t.vendorId],foreignColumns:[parties.orgId,parties.id]}),
  foreignKey({name:"mfg_subcontract_custody_fk",columns:[t.orgId,t.custodyLocationId],foreignColumns:[stockLocations.orgId,stockLocations.id]}),
  check("mfg_subcontract_status",sql`${t.status} in ('ready','sent','received','cancelled')`),
  check("mfg_subcontract_expected_positive",sql`${t.quantityExpected}>0`),
  check("mfg_subcontract_cancel_reason",sql`(${t.status}='cancelled')=(${t.cancelReason} is not null)`),
]);

/** Each shipment preserves its actual material line and paired native valued transfer. */
export const mfgSubcontractShipments=pgTable("mfg_subcontract_shipments",{
  id:id(),orgId:orgRef(),subcontractId:uuid("subcontract_id").notNull(),materialId:uuid("material_id").notNull(),
  sourceLocationId:uuid("source_location_id").notNull(),quantity:money("quantity").notNull(),
  value:money("value").notNull(),fromMovementId:uuid("from_movement_id").notNull(),toMovementId:uuid("to_movement_id").notNull(),
  requestSnapshot:jsonb("request_snapshot").notNull(),...auditColumns,
},t=>[
  uniqueIndex("mfg_subcontract_shipments_org_id_unique").on(t.orgId,t.id),
  uniqueIndex("mfg_subcontract_shipment_from_unique").on(t.orgId,t.fromMovementId),
  uniqueIndex("mfg_subcontract_shipment_to_unique").on(t.orgId,t.toMovementId),
  foreignKey({name:"mfg_subcontract_shipment_contract_fk",columns:[t.orgId,t.subcontractId],foreignColumns:[mfgSubcontracts.orgId,mfgSubcontracts.id]}),
  foreignKey({name:"mfg_subcontract_shipment_material_fk",columns:[t.orgId,t.materialId],foreignColumns:[mfgWoMaterials.orgId,mfgWoMaterials.id]}),
  foreignKey({name:"mfg_subcontract_shipment_source_fk",columns:[t.orgId,t.sourceLocationId],foreignColumns:[stockLocations.orgId,stockLocations.id]}),
  foreignKey({name:"mfg_subcontract_shipment_from_fk",columns:[t.orgId,t.fromMovementId],foreignColumns:[inventoryMovements.orgId,inventoryMovements.id]}),
  foreignKey({name:"mfg_subcontract_shipment_to_fk",columns:[t.orgId,t.toMovementId],foreignColumns:[inventoryMovements.orgId,inventoryMovements.id]}),
  check("mfg_subcontract_shipment_quantity_positive",sql`${t.quantity}>0`),
  check("mfg_subcontract_shipment_value_nonnegative",sql`${t.value}>=0`),
]);

/** A service charge is capitalized once from the posted bill's actual cost, with governed reversals. */
export const mfgSubcontractServiceBills=pgTable("mfg_subcontract_service_bills",{
  id:id(),orgId:orgRef(),subcontractId:uuid("subcontract_id").notNull(),billId:uuid("bill_id").notNull(),
  sourceEntryId:uuid("source_entry_id").notNull(),capitalizationEntryId:uuid("capitalization_entry_id"),
  wipAccountId:uuid("wip_account_id").notNull(),amount:money("amount").notNull(),expenseSnapshot:jsonb("expense_snapshot").notNull(),
  reversalEntryId:uuid("reversal_entry_id"),reversalReason:text("reversal_reason"),...auditColumns,
},t=>[
  uniqueIndex("mfg_subcontract_service_org_id_unique").on(t.orgId,t.id),
  uniqueIndex("mfg_subcontract_service_active_bill").on(t.orgId,t.billId).where(sql`${t.reversalEntryId} is null`),
  foreignKey({name:"mfg_subcontract_service_contract_fk",columns:[t.orgId,t.subcontractId],foreignColumns:[mfgSubcontracts.orgId,mfgSubcontracts.id]}),
  foreignKey({name:"mfg_subcontract_service_bill_fk",columns:[t.orgId,t.billId],foreignColumns:[documents.orgId,documents.id]}),
  foreignKey({name:"mfg_subcontract_service_source_fk",columns:[t.orgId,t.sourceEntryId],foreignColumns:[journalEntries.orgId,journalEntries.id]}),
  foreignKey({name:"mfg_subcontract_service_capitalization_fk",columns:[t.orgId,t.capitalizationEntryId],foreignColumns:[journalEntries.orgId,journalEntries.id]}),
  foreignKey({name:"mfg_subcontract_service_reversal_fk",columns:[t.orgId,t.reversalEntryId],foreignColumns:[journalEntries.orgId,journalEntries.id]}),
  foreignKey({name:"mfg_subcontract_service_wip_fk",columns:[t.orgId,t.wipAccountId],foreignColumns:[accounts.orgId,accounts.id]}),
  check("mfg_subcontract_service_nonnegative",sql`${t.amount}>=0 and (${t.amount}=0)=(${t.capitalizationEntryId} is null)`),
  check("mfg_subcontract_service_reversal_reason",sql`(${t.reversalEntryId} is null)=(${t.reversalReason} is null)`),
]);

/** Physical returns record progress on the original operation, without inventing a stock receipt. */
export const mfgSubcontractReturns=pgTable("mfg_subcontract_returns",{
  id:id(),orgId:orgRef(),subcontractId:uuid("subcontract_id").notNull(),
  quantity:money("quantity").notNull(),requestSnapshot:jsonb("request_snapshot").notNull(),
  finishReason:text("finish_reason"),...auditColumns,
},t=>[
  uniqueIndex("mfg_subcontract_returns_org_id_unique").on(t.orgId,t.id),
  foreignKey({name:"mfg_subcontract_return_contract_fk",columns:[t.orgId,t.subcontractId],foreignColumns:[mfgSubcontracts.orgId,mfgSubcontracts.id]}),
  check("mfg_subcontract_return_positive",sql`${t.quantity}>0`),
  check("mfg_subcontract_return_reason",sql`${t.finishReason} is null or length(btrim(${t.finishReason})) between 5 and 500`),
]);

/** Unused component returns preserve both sides of the actual valued transfer. */
export const mfgSubcontractMaterialReturns=pgTable("mfg_subcontract_material_returns",{
  id:id(),orgId:orgRef(),subcontractId:uuid("subcontract_id").notNull(),shipmentId:uuid("shipment_id").notNull(),
  quantity:money("quantity").notNull(),value:money("value").notNull(),
  fromMovementId:uuid("from_movement_id").notNull(),toMovementId:uuid("to_movement_id").notNull(),
  requestSnapshot:jsonb("request_snapshot").notNull(),...auditColumns,
},t=>[
  uniqueIndex("mfg_subcontract_material_returns_org_id_unique").on(t.orgId,t.id),
  uniqueIndex("mfg_subcontract_material_return_from_unique").on(t.orgId,t.fromMovementId),
  uniqueIndex("mfg_subcontract_material_return_to_unique").on(t.orgId,t.toMovementId),
  foreignKey({name:"mfg_subcontract_material_return_contract_fk",columns:[t.orgId,t.subcontractId],foreignColumns:[mfgSubcontracts.orgId,mfgSubcontracts.id]}),
  foreignKey({name:"mfg_subcontract_material_return_shipment_fk",columns:[t.orgId,t.shipmentId],foreignColumns:[mfgSubcontractShipments.orgId,mfgSubcontractShipments.id]}),
  foreignKey({name:"mfg_subcontract_material_return_from_fk",columns:[t.orgId,t.fromMovementId],foreignColumns:[inventoryMovements.orgId,inventoryMovements.id]}),
  foreignKey({name:"mfg_subcontract_material_return_to_fk",columns:[t.orgId,t.toMovementId],foreignColumns:[inventoryMovements.orgId,inventoryMovements.id]}),
  check("mfg_subcontract_material_return_quantity",sql`${t.quantity}>0`),
  check("mfg_subcontract_material_return_value",sql`${t.value}>=0`),
]);
