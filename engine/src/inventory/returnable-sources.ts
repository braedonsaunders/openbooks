import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import { PURCHASE_RECEIPT_DOCUMENT_KIND } from "./documents-purchasing.ts";
import { SALES_FULFILLMENT_DOCUMENT_KIND } from "./documents-customer-credits.ts";

/**
 * What an operator may pick when a credit memo returns stock.
 *
 * The vendor and customer return engines each decide, under the position lock,
 * whether one selection is legal. This module answers the prior question —
 * which movements are OFFERABLE at all — and it is the only place that answers
 * it. The drawer's picker and the save-time reference check read the same rows,
 * so a source the picker never offered cannot be saved, and a source it did
 * offer cannot be quietly rejected for a reason the list could have shown.
 */

/** Which leg is being returned: goods going back to a vendor, or back from a customer. */
export type ReturnSide = "purchase" | "sales";

export interface ReturnableSource {
  movementId: string;
  movedAt: string;
  documentId: string | null;
  documentNumber: string | null;
  documentKind: string | null;
  itemId: string;
  stockLocationId: string;
  stockLocationCode: string | null;
  lotId: string | null;
  lotCode: string | null;
  serialId: string | null;
  serialCode: string | null;
  /** Absolute quantity the source movement carried. */
  quantity: string;
  /** Quantity already returned against it by posted credits. */
  returned: string;
  /** quantity − returned; only sources with some left are listed. */
  remaining: string;
  unitCost: string | null;
}

interface SideRules {
  sourceKind: "receipt" | "issue";
  returnKind: "receipt" | "return";
  evidenceKey: string;
  documentKinds: readonly string[];
}

/**
 * A purchase return consumes a `receipt` (a positive movement) and records a
 * `return` (negative); a sales return consumes an `issue` (negative) and
 * records a `receipt` (positive). The sign handling below is driven from here
 * rather than duplicated per branch.
 */
const SIDE_RULES: Record<ReturnSide, SideRules> = {
  purchase: {
    sourceKind: "receipt",
    returnKind: "return",
    evidenceKey: "sourceReceiptMovementId",
    documentKinds: ["vendor_bill", PURCHASE_RECEIPT_DOCUMENT_KIND],
  },
  sales: {
    sourceKind: "issue",
    returnKind: "receipt",
    evidenceKey: "sourceIssueMovementId",
    documentKinds: ["customer_invoice", SALES_FULFILLMENT_DOCUMENT_KIND],
  },
};

export interface ReturnableSourceQuery {
  side: ReturnSide;
  partyId: string;
  itemId?: string | null;
  stockLocationId?: string | null;
  subsidiaryId?: string | null;
  limit?: number;
}

export async function returnableSources(
  runner: SqlExecutor,
  orgId: string,
  query: ReturnableSourceQuery,
): Promise<ReturnableSource[]> {
  const rules = SIDE_RULES[query.side];
  // Both source and return quantities are read as absolute values so the two
  // sides compare directly regardless of which leg stores the negative.
  const rows = (await runner.execute<{
    movement_id: string;
    moved_at: string;
    document_id: string | null;
    document_number: string | null;
    document_kind: string | null;
    item_id: string;
    stock_location_id: string;
    stock_location_code: string | null;
    lot_id: string | null;
    lot_code: string | null;
    serial_id: string | null;
    serial_code: string | null;
    quantity: string;
    returned: string;
    remaining: string;
    unit_cost: string | null;
  }>(sql`
    select movement.id as movement_id,
           movement.moved_at::date::text as moved_at,
           source_document.id as document_id,
           source_document.document_number,
           source_document.kind as document_kind,
           movement.item_id,
           movement.stock_location_id,
           stock_location.code as stock_location_code,
           movement.lot_id, lot.lot_number as lot_code,
           movement.serial_id, serial.serial_number as serial_code,
           abs(movement.quantity)::text as quantity,
           -- Cast the aggregate explicitly: an empty lateral yields integer 0,
           -- so an unreturned source would report "0" while a partly returned
           -- one reports "3.0000" and callers comparing the two disagree.
           coalesce(returned.quantity, 0)::numeric(19,4)::text as returned,
           (abs(movement.quantity) - coalesce(returned.quantity, 0))::numeric(19,4)::text as remaining,
           movement.unit_cost::text as unit_cost
      from inventory_movements movement
      join document_lines source_line
        on source_line.id = movement.document_line_id
       and source_line.org_id = movement.org_id
      join documents source_document
        on source_document.id = source_line.document_id
       and source_document.org_id = movement.org_id
      left join stock_locations stock_location
        on stock_location.id = movement.stock_location_id
       and stock_location.org_id = movement.org_id
      left join lots lot on lot.id = movement.lot_id and lot.org_id = movement.org_id
      left join serials serial on serial.id = movement.serial_id and serial.org_id = movement.org_id
      left join lateral (
        select coalesce(sum(abs(prior.quantity)), 0) as quantity
          from inventory_movements prior
          join document_lines credit_line
            on credit_line.id = prior.document_line_id
           and credit_line.org_id = prior.org_id
         where prior.org_id = movement.org_id
           and prior.kind = ${rules.returnKind}
           and prior.status = 'posted'
           and credit_line.custom #>> ${sql.raw(`'{inventoryReturn,${rules.evidenceKey}}'`)} = movement.id::text
      ) returned on true
     where movement.org_id = ${orgId}
       and movement.kind = ${rules.sourceKind}
       and movement.status = 'posted'
       and source_document.party_id = ${query.partyId}
       and source_document.kind in ${rules.documentKinds}
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = movement.org_id
            and reversal.reverses_movement_id = movement.id
       )
       ${query.itemId ? sql`and movement.item_id = ${query.itemId}` : sql``}
       ${query.stockLocationId ? sql`and movement.stock_location_id = ${query.stockLocationId}` : sql``}
       ${query.subsidiaryId ? sql`and movement.subsidiary_id = ${query.subsidiaryId}` : sql``}
       and abs(movement.quantity) - coalesce(returned.quantity, 0) > 0
     order by movement.moved_at desc, movement.id
     limit ${Math.min(Math.max(query.limit ?? 50, 1), 200)}
  `)).rows;
  return rows.map((row) => ({
    movementId: row.movement_id,
    movedAt: row.moved_at,
    documentId: row.document_id,
    documentNumber: row.document_number,
    documentKind: row.document_kind,
    itemId: row.item_id,
    stockLocationId: row.stock_location_id,
    stockLocationCode: row.stock_location_code,
    lotId: row.lot_id,
    lotCode: row.lot_code,
    serialId: row.serial_id,
    serialCode: row.serial_code,
    quantity: row.quantity,
    returned: row.returned,
    remaining: row.remaining,
    unitCost: row.unit_cost,
  }));
}

/**
 * Refuse a selection the picker would not have offered, at save time, before
 * the line is stored as trusted evidence.
 *
 * This deliberately does NOT re-decide quantity, lot or serial coherence: the
 * return engines own that under the inventory position lock at posting time,
 * and a second copy here would be a second validator that could drift. What it
 * establishes is that the movement is a real, still-returnable source for THIS
 * party, item and warehouse — the part a caller could otherwise forge.
 */
export async function assertReturnSourceSelectable(
  runner: SqlExecutor,
  orgId: string,
  selection: {
    side: ReturnSide;
    partyId: string;
    itemId: string;
    stockLocationId: string;
    movementId: string;
    lotId?: string | null;
    serialId?: string | null;
  },
  lineLabel: string,
): Promise<ReturnableSource> {
  const offered = await returnableSources(runner, orgId, {
    side: selection.side,
    partyId: selection.partyId,
    itemId: selection.itemId,
    stockLocationId: selection.stockLocationId,
    limit: 200,
  });
  const source = offered.find((candidate) => candidate.movementId === selection.movementId);
  if (!source) {
    throw new InventoryError(
      `${lineLabel}: that ${selection.side === "purchase" ? "receipt" : "shipment"} is not available to return — ` +
        `it must be a posted, unreversed movement for this party, item and warehouse with quantity still unreturned`,
    );
  }
  if ((selection.lotId ?? null) !== source.lotId) {
    throw new InventoryError(
      `${lineLabel}: the selected lot does not match the chosen ${selection.side === "purchase" ? "receipt" : "shipment"}`,
    );
  }
  if ((selection.serialId ?? null) !== source.serialId) {
    throw new InventoryError(
      `${lineLabel}: the selected serial does not match the chosen ${selection.side === "purchase" ? "receipt" : "shipment"}`,
    );
  }
  return source;
}
