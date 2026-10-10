import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";
import { journalEntries } from "./ledger";
import { inventoryMovements } from "./inventory";
import { mfgWorkOrders } from "./manufacturing";

export const mfgCompletionBatches = pgTable("mfg_completion_batches",{
  id:id(),orgId:orgRef(),workOrderId:uuid("work_order_id").notNull(),completionEntryId:uuid("completion_entry_id").notNull(),
  allocationBasis:text("allocation_basis",{enum:["recorded","proportional"]}).notNull(),quantity:money("quantity").notNull(),...auditColumns,
},(t):PgTableExtraConfigValue[]=>[
  uniqueIndex("mfg_completion_batches_org_identity").on(t.orgId,t.id),
  uniqueIndex("mfg_completion_batches_entry_identity").on(t.orgId,t.completionEntryId),
  uniqueIndex("mfg_completion_batches_order_entry_identity").on(t.orgId,t.workOrderId,t.completionEntryId),
  foreignKey({name:"mfg_completion_batch_order_fk",columns:[t.orgId,t.workOrderId],foreignColumns:[mfgWorkOrders.orgId,mfgWorkOrders.id]}),
  foreignKey({name:"mfg_completion_batch_entry_fk",columns:[t.orgId,t.completionEntryId],foreignColumns:[journalEntries.orgId,journalEntries.id]}),
  check("mfg_completion_batch_quantity_positive",sql`${t.quantity}>0`),
  check("mfg_completion_batch_basis",sql`${t.allocationBasis} in ('recorded','proportional')`),
]);
export const mfgCompletionInputs = pgTable("mfg_completion_inputs",{
  id:id(),orgId:orgRef(),workOrderId:uuid("work_order_id").notNull(),completionEntryId:uuid("completion_entry_id").notNull(),inputMovementId:uuid("input_movement_id").notNull(),
  quantity:money("quantity").notNull(),...auditColumns,
},(t):PgTableExtraConfigValue[]=>[
  uniqueIndex("mfg_completion_inputs_org_identity").on(t.orgId,t.id),
  uniqueIndex("mfg_completion_inputs_entry_source_identity").on(t.orgId,t.completionEntryId,t.inputMovementId),
  index("mfg_completion_inputs_source").on(t.orgId,t.inputMovementId,t.completionEntryId),
  foreignKey({name:"mfg_completion_input_batch_fk",columns:[t.orgId,t.workOrderId,t.completionEntryId],foreignColumns:[mfgCompletionBatches.orgId,mfgCompletionBatches.workOrderId,mfgCompletionBatches.completionEntryId]}),
  foreignKey({name:"mfg_completion_input_movement_fk",columns:[t.orgId,t.inputMovementId],foreignColumns:[inventoryMovements.orgId,inventoryMovements.id]}),
  check("mfg_completion_input_quantity_positive",sql`${t.quantity}>0`),
]);
