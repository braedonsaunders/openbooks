import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  jsonb,
  numeric,
  bigint,
  integer,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, orgRef, money, auditColumns } from "./helpers";
const documentQuantity = (name: string) =>
  numeric(name, { precision: 28, scale: 8 });
export const warehouseExecutionTasks = pgTable(
  "warehouse_execution_tasks",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    stage: text("stage").notNull(),
    documentLineId: uuid("document_line_id"),
    countLineId: uuid("count_line_id"),
    itemId: uuid("item_id").notNull(),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    fromStockLocationId: uuid("from_stock_location_id").notNull(),
    toStockLocationId: uuid("to_stock_location_id").notNull(),
    quantity: money("quantity").notNull(),
    documentQuantity: documentQuantity("document_quantity").notNull(),
    documentUnit: text("document_unit"),
    postingDate: date("posting_date").notNull(),
    basis: jsonb("basis").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("open"),
    commandKey: text("command_key").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    ...auditColumns,
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("warehouse_execution_tasks_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("warehouse_execution_tasks_org_id_command_key_key").on(
      t.orgId,
      t.commandKey,
    ),
    uniqueIndex("warehouse_receive_confirmed_line")
      .on(t.orgId, t.documentLineId)
      .where(sql`${t.stage}='receive' and ${t.status}='done'`),
    index("warehouse_execution_open")
      .on(t.orgId, t.subsidiaryId, t.stage, t.createdAt, t.id)
      .where(sql`${t.status}='open'`),
  ],
);
export const warehouseScanEvents = pgTable("warehouse_scan_events", {
  id: id(),
  orgId: orgRef(),
  taskId: uuid("task_id").notNull(),
  outcome: text("outcome").notNull(),
  observed: jsonb("observed").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: uuid("created_by").notNull(),
});
export const pickWaves = pgTable("pick_waves", {
  id: id(),
  orgId: orgRef(),
  subsidiaryId: uuid("subsidiary_id").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  mode: text("mode").notNull(),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  commandKey: text("command_key").notNull(),
  request: jsonb("request").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: uuid("created_by").notNull(),
});
export const pickWaveMembers = pgTable(
  "pick_wave_members",
  {
    orgId: orgRef(),
    waveId: uuid("wave_id").notNull(),
    pickListId: uuid("pick_list_id").notNull(),
    sequence: integer("sequence").notNull(),
    priority: integer("priority").notNull(),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    releaseStatus: text("release_status").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.waveId, t.pickListId] }),
    uniqueIndex("pick_wave_members_org_id_wave_id_sequence_key").on(
      t.orgId,
      t.waveId,
      t.sequence,
    ),
  ],
);
export const pickExecutionLines = pgTable(
  "pick_execution_lines",
  {
    lineId: uuid("line_id").primaryKey(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    requestedQuantity: documentQuantity("requested_quantity").notNull(),
    pickedQuantity: documentQuantity("picked_quantity").notNull(),
    shortQuantity: documentQuantity("short_quantity").notNull(),
    currentStockLocationId: uuid("current_stock_location_id").notNull(),
    confirmationTaskId: uuid("confirmation_task_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("pick_execution_lines_org_id_line_id_key").on(
      t.orgId,
      t.lineId,
    ),
    check(
      "pick_execution_lines_quantity_check",
      sql`${t.pickedQuantity}+${t.shortQuantity}=${t.requestedQuantity}`,
    ),
  ],
);
export const handlingUnits = pgTable(
  "handling_units",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    code: text("code").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    currentStockLocationId: uuid("current_stock_location_id").notNull(),
    initialStockLocationId: uuid("initial_stock_location_id").notNull(),
    shipmentDocumentId: uuid("shipment_document_id").notNull(),
    status: text("status").notNull().default("open"),
    contentVersion: bigint("content_version", { mode: "bigint" })
      .notNull()
      .default(0n),
    ...auditColumns,
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("handling_units_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("handling_units_org_id_code_key").on(t.orgId, t.code),
  ],
);
export const handlingUnitContents = pgTable(
  "handling_unit_contents",
  {
    orgId: orgRef(),
    handlingUnitId: uuid("handling_unit_id").notNull(),
    shipmentLineId: uuid("shipment_line_id").notNull(),
    pickLineId: uuid("pick_line_id").notNull(),
    itemId: uuid("item_id").notNull(),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    quantity: money("quantity").notNull(),
    documentQuantity: documentQuantity("document_quantity").notNull(),
    confirmationTaskId: uuid("confirmation_task_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by"),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.handlingUnitId, t.shipmentLineId] }),
    uniqueIndex("handling_unit_contents_org_id_shipment_line_id_key").on(
      t.orgId,
      t.shipmentLineId,
    ),
  ],
);
export const handlingUnitMoves = pgTable(
  "handling_unit_moves",
  {
    id: id(),
    orgId: orgRef(),
    handlingUnitId: uuid("handling_unit_id").notNull(),
    fromStockLocationId: uuid("from_stock_location_id").notNull(),
    toStockLocationId: uuid("to_stock_location_id").notNull(),
    movedOn: date("moved_on").notNull(),
    commandKey: text("command_key").notNull(),
    request: jsonb("request").notNull(),
    movements: jsonb("movements").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex(
      "handling_unit_moves_org_id_handling_unit_id_command_key_key",
    ).on(t.orgId, t.handlingUnitId, t.commandKey),
  ],
);
