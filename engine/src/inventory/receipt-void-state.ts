import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { lockInventoryPosition } from "./position.ts";

/** Receipt void state: the dependent-document and blocker vocabulary, live movement and layer coverage, and consumption rows read by the void and correction operations. */

export interface ReceiptDependentDocument {
  id: string;
  number: string;
  kind: string;
  status: string;
}

export interface ReceiptVoidDependent {
  issueMovementId: string;
  issueKind: string;
  consumedQuantity: string;
  issueDate: string;
  returnedQuantity: string;
  sourceDocument: ReceiptDependentDocument | null;
  /** True only when the dependent reverses through its own native document void. */
  reversible: boolean;
  /** The operator's next step for this dependent, naming live documents. */
  reverseAction: string;
}

export interface ReceiptVoidBlocker {
  movementId: string;
  itemId: string;
  itemCode: string | null;
  itemName: string;
  receivedQuantity: string;
  consumedQuantity: string;
  remainderQuantity: string;
  dependents: ReceiptVoidDependent[];
  /** Non-consumption blockers: landed cost, provisional chain, custody. */
  otherBlocks: string[];
}

export interface ReceiptVoidRelief {
  receiptId: string;
  receiptNumber: string;
  blockers: ReceiptVoidBlocker[];
  /** True only when every dependent reverses through its own document void. */
  allowVoidWithDependents: boolean;
  /** Unconsumed cover across the receipt's movements. */
  remainderQuantity: string;
}

export type LiveReceiptMovement = {
  id: string;
  item_id: string;
  item_code: string | null;
  item_name: string;
  received: string;
  lot_id: string | null;
  serial_id: string | null;
  document_line_id: string;
  stock_location_id: string;
  subsidiary_id: string;
};

/** Fence every stock position before receipt or order rows are locked. */
export async function lockReceiptInventoryPositions(
  runner: SqlExecutor,
  orgId: string,
  receiptId: string,
): Promise<void> {
  const positions = await runner.execute<{ item_id: string; stock_location_id: string }>(
    sql`
    select distinct item_id, stock_location_id
      from inventory_movements
     where org_id = ${orgId} and document_line_id in (
       select id from document_lines where org_id = ${orgId} and document_id = ${receiptId}
     ) and kind = 'receipt' and status = 'posted'
     order by item_id, stock_location_id
  `,
    "objects",
  );
  for (const position of positions) {
    await lockInventoryPosition(runner, position.item_id, position.stock_location_id);
  }
}

/** Live receipt movements behind a goods receipt: posted, never reversed. */
export async function liveReceiptMovements(
  runner: SqlExecutor,
  orgId: string,
  receiptId: string,
): Promise<LiveReceiptMovement[]> {
  return await runner.execute<LiveReceiptMovement>(
    sql`
    select m.id, m.item_id, i.code as item_code, i.name as item_name,
           m.quantity::text as received, m.lot_id, m.serial_id,
           m.document_line_id, m.stock_location_id, m.subsidiary_id
      from inventory_movements m
      join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
      left join items i on i.id = m.item_id and i.org_id = m.org_id
     where m.org_id = ${orgId} and l.document_id = ${receiptId}
       and m.kind = 'receipt' and m.status = 'posted'
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = m.org_id
            and reversal.reverses_movement_id = m.id
       )
     order by m.id`,
    "objects",
  );
}

interface LayerRow {
  movement_id: string;
  consumed: string;
  remainder: string;
}

/** Per-movement consumed and remainder cover from the cost layers. */
export async function layerCover(
  runner: SqlExecutor,
  orgId: string,
  movementIds: string[],
): Promise<{ cover: Map<string, LayerRow>; layered: Set<string> }> {
  const cover = new Map<string, LayerRow>();
  const layered = new Set<string>();
  if (movementIds.length === 0) return { cover, layered };
  const idArr = `{${movementIds.join(",")}}`;
  const rows = await runner.execute<{
    movement_id: string;
    consumed: string;
    remainder: string;
  }>(
    sql`
    select l.source_movement_id as movement_id,
           coalesce(sum(l.original_quantity - l.remaining_quantity), 0)::text as consumed,
           coalesce(sum(l.remaining_quantity), 0)::text as remainder
      from cost_layers l
     where l.org_id = ${orgId} and l.source_movement_id = any(${idArr}::uuid[])
     group by l.source_movement_id`,
    "objects",
  );
  for (const row of rows) {
    layered.add(row.movement_id);
    cover.set(row.movement_id, row);
  }
  return { cover, layered };
}

export type ConsumptionRow = {
  cost_layer_id: string;
  issue_movement_id: string;
  consumed_quantity: string;
  issue_kind: string;
  issue_quantity: string;
  issue_date: string;
  issue_memo: string | null;
  doc_id: string | null;
  doc_number: string | null;
  doc_kind: string | null;
  doc_status: string | null;
  doc_void_requested: string | null;
};

/** Live consumptions of the receipt's layers: issues no reversal has undone. */
export async function liveConsumptions(
  runner: SqlExecutor,
  orgId: string,
  movementIds: string[],
): Promise<ConsumptionRow[]> {
  if (movementIds.length === 0) return [];
  const idArr = `{${movementIds.join(",")}}`;
  return await runner.execute<ConsumptionRow>(
    sql`
    select c.cost_layer_id, c.issue_movement_id,
           c.quantity::text as consumed_quantity,
           m.kind as issue_kind, m.quantity::text as issue_quantity,
           m.moved_at::date::text as issue_date, m.memo as issue_memo,
           d.id as doc_id, d.document_number as doc_number, d.kind as doc_kind,
           d.status as doc_status, d.void_requested_at::text as doc_void_requested
      from cost_layer_consumptions c
      join cost_layers l on l.id = c.cost_layer_id and l.org_id = c.org_id
      join inventory_movements m on m.id = c.issue_movement_id and m.org_id = c.org_id
      left join document_lines dl on dl.id = m.document_line_id and dl.org_id = m.org_id
      left join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where c.org_id = ${orgId} and l.source_movement_id = any(${idArr}::uuid[])
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = c.org_id
            and reversal.reverses_movement_id = c.issue_movement_id
       )
     order by c.created_at, c.cost_layer_id`,
    "objects",
  );
}

export function reversibleDependent(
  row: ConsumptionRow,
  consumedQuantity: string,
): { reversible: boolean; reverseAction: string; sourceDocument: ReceiptDependentDocument | null } {
  const sourceDocument =
    row.doc_id && row.doc_number && row.doc_kind && row.doc_status
      ? { id: row.doc_id, number: row.doc_number, kind: row.doc_kind, status: row.doc_status }
      : null;
  // A shipment unwinds through its own void, which reverses its issues and
  // restores its sales order — the cascade below drives exactly that path.
  if (
    sourceDocument?.kind === "sales_fulfillment" &&
    (sourceDocument.status === "approved" || sourceDocument.status === "posted") &&
    row.doc_void_requested == null
  ) {
    return {
      reversible: true,
      sourceDocument,
      reverseAction: `Void ${sourceDocument.number} (the sales fulfillment), then void this receipt`,
    };
  }
  // A posted invoice's sale is legitimate history with no void path: the
  // goods come back through a credit memo with a goods return, and the
  // receipt stands for the invoiced cover permanently.
  if (sourceDocument?.kind === "customer_invoice") {
    return {
      reversible: false,
      sourceDocument,
      reverseAction:
        `Bring the invoiced units back with a customer credit carrying a goods return ` +
        `against invoice ${sourceDocument.number} for ${consumedQuantity}; ` +
        `the receipt cannot void for cover a posted invoice consumed — that cover is ` +
        `permanent posted history. Correct any overstated remainder with an inventory adjustment instead.`,
    };
  }
  if (sourceDocument) {
    return {
      reversible: false,
      sourceDocument,
      reverseAction:
        `Reverse the consuming ${row.issue_kind} behind ${sourceDocument.kind} ` +
        `${sourceDocument.number} first, then void this receipt`,
    };
  }
  return {
    reversible: false,
    sourceDocument,
    reverseAction:
      `The consuming ${row.issue_kind} of ${consumedQuantity} on ${row.issue_date} ` +
      `carries no source document — reverse that movement first, then void this receipt`,
  };
}
