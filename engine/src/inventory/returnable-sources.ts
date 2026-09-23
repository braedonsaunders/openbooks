import { sql, type SQL } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { InventoryError } from "./contracts.ts";
import { postedReturnEvidenceScope } from "./return-quantities.ts";
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
  /** Quantity already returned against it by posted, unreversed credits. */
  returned: string;
  /** quantity − returned; only sources with some left are listed. */
  remaining: string;
  unitCost: string | null;
}

interface SideRules {
  sourceKind: "receipt" | "issue";
  returnKind: "receipt" | "return";
  evidenceKey: "sourceIssueMovementId" | "sourceReceiptMovementId";
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

interface SourceRow extends Record<string, unknown> {
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
}

/**
 * The one select list and join tree behind both readers below. The
 * already-returned lateral shares the postedReturnEvidenceScope rule with the
 * customer/vendor post guards, so the picker and the guards can never
 * disagree on what counts as returned — including returns that were
 * themselves reversed, which are returnable again.
 */
function sourceColumns(): SQL {
  return sql`
    movement.id as movement_id,
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
    movement.unit_cost::text as unit_cost`;
}

function sourceJoins(rules: SideRules, orgId: string): SQL {
  return sql`
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
         where ${postedReturnEvidenceScope({
           orgId,
           returnKind: rules.returnKind,
           evidenceKey: rules.evidenceKey,
           sourceId: sql`movement.id::text`,
         })}
      ) returned on true`;
}

/**
 * Legal-entity scope for source movements. Null/undefined reads unscoped
 * (full access); an array — including an empty one — filters at SQL level,
 * so an empty grant matches nothing instead of leaking every entity.
 */
function subsidiaryFilter(subsidiaryIds: readonly string[] | null | undefined): SQL {
  if (subsidiaryIds == null) return sql``;
  return sql`and movement.subsidiary_id = any(${uuidArray(subsidiaryIds)}::uuid[])`;
}

function toReturnableSource(row: SourceRow): ReturnableSource {
  return {
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
  };
}

export interface ReturnableSourceQuery {
  side: ReturnSide;
  partyId: string;
  itemId?: string | null;
  stockLocationId?: string | null;
  subsidiaryIds?: readonly string[] | null;
  limit?: number;
  offset?: number;
}

export interface ReturnableSourcePage {
  sources: ReturnableSource[];
  /** True when another page follows; pass offset + limit to reach it. */
  hasMore: boolean;
}

export async function returnableSources(
  runner: SqlExecutor,
  orgId: string,
  query: ReturnableSourceQuery,
): Promise<ReturnableSourcePage> {
  const rules = SIDE_RULES[query.side];
  // Both source and return quantities are read as absolute values so the two
  // sides compare directly regardless of which leg stores the negative.
  const wantedLimit = Math.floor(Number(query.limit ?? 50));
  const limit = Number.isFinite(wantedLimit) ? Math.min(Math.max(wantedLimit, 1), 200) : 50;
  const wantedOffset = Math.floor(Number(query.offset ?? 0));
  const offset = Number.isFinite(wantedOffset) ? Math.max(wantedOffset, 0) : 0;
  const rows = (await runner.execute<SourceRow>(sql`
    select ${sourceColumns()}
      ${sourceJoins(rules, orgId)}
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
       ${subsidiaryFilter(query.subsidiaryIds)}
       and abs(movement.quantity) - coalesce(returned.quantity, 0) > 0
     order by movement.moved_at desc, movement.id
     limit ${limit + 1} offset ${offset}
  `)).rows;
  const hasMore = rows.length > limit;
  return { sources: rows.slice(0, limit).map(toReturnableSource), hasMore };
}

/**
 * Refuse a selection the picker would not have offered, at save time, before
 * the line is stored as trusted evidence.
 *
 * The movement is read by exact id under the same scope the picker lists
 * with — party, item, warehouse, legal-entity set, posted, unreversed, with
 * quantity still unreturned — never by finding it in the newest-N page, so a
 * return against the oldest of hundreds of sources validates exactly the
 * same row the picker would show on its page.
 *
 * This deliberately does NOT re-decide quantity, lot or serial coherence: the
 * return engines own that under the inventory position lock at posting time,
 * and a second copy here would be a second validator that could drift. What it
 * establishes is that the movement is a real, still-returnable source for THIS
 * party, item, warehouse and legal entity — the part a caller could otherwise
 * forge.
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
    subsidiaryIds?: readonly string[] | null;
    lotId?: string | null;
    serialId?: string | null;
  },
  lineLabel: string,
): Promise<ReturnableSource> {
  const rules = SIDE_RULES[selection.side];
  const row = (await runner.execute<SourceRow>(sql`
    select ${sourceColumns()}
      ${sourceJoins(rules, orgId)}
     where movement.org_id = ${orgId}
       and movement.id = ${selection.movementId}
       and movement.kind = ${rules.sourceKind}
       and movement.status = 'posted'
       and source_document.party_id = ${selection.partyId}
       and source_document.kind in ${rules.documentKinds}
       and movement.item_id = ${selection.itemId}
       and movement.stock_location_id = ${selection.stockLocationId}
       ${subsidiaryFilter(selection.subsidiaryIds)}
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = movement.org_id
            and reversal.reverses_movement_id = movement.id
       )
       and abs(movement.quantity) - coalesce(returned.quantity, 0) > 0
  `)).rows[0];
  if (!row) {
    throw new InventoryError(
      `${lineLabel}: that ${selection.side === "purchase" ? "receipt" : "shipment"} is not available to return — ` +
        `it must be a posted, unreversed movement for this party, item, warehouse and legal entity with quantity still unreturned`,
    );
  }
  const source = toReturnableSource(row);
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
