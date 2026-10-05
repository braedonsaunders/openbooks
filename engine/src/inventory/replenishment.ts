import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, cmp, neg } from "../money/money.ts";
import { purchaseOrderLineRemainders } from "../records/order-line-remainders.ts";
import type { Runner } from "./contracts.ts";
import {
  availabilityEntity,
  demandTermsByItem,
  openBaseQuantity,
  stockedItems,
} from "./availability.ts";
import { assertWarehousingFeature } from "./warehouses.ts";

/**
 * Replenishment proposals from projected supply, one legal entity at a time
 * because an item carries one reorder point and one preferred stock level.
 *
 *   projected = onHand − committed − unallocated + onOrder
 *
 * Every term is an exact base-unit quantity. Demand with no stock location
 * is still owed by the entity, so it lowers projected supply here even though
 * no single location's availability can net it. `onOrder` is the open
 * quantity of the entity's issued purchase orders, by the one open-quantity
 * rule. When projected supply is at or below the reorder point, the proposal
 * restores the preferred stock level. Items without both points are listed so
 * the gap is visible; they are never proposed.
 *
 * Proposals are read-only: nothing is ordered until someone creates the
 * purchase orders.
 */

export type ReplenishmentStatus =
  /** Projected supply is at or below the reorder point: order `proposed`. */
  | "reorder"
  /** Projected supply is above the reorder point, or already restores the preferred level. */
  | "covered"
  /** The reorder point or the preferred stock level is not set. */
  | "no_reorder_point"
  /** The preferred stock level is below the reorder point, so no order could restore it. */
  | "points_inverted";

export interface ReplenishmentLine {
  itemId: string;
  itemLabel: string;
  baseUnit: string;
  onHand: string;
  committed: string;
  unallocated: string;
  onOrder: string;
  projected: string;
  reorderPoint: string | null;
  preferredStockLevel: string | null;
  proposed: string;
  status: ReplenishmentStatus;
  /** The vendor of the entity's most recent live receipt of the item. */
  vendorId: string | null;
  vendorName: string | null;
}

const ZERO = "0.0000";

/**
 * The vendor on each item's most recent posted receipt for the entity — a
 * purchase receipt or a bill that received stock — skipping receipts that
 * were reversed.
 */
export async function lastReceiptVendors(
  runner: Runner,
  orgId: string,
  subsidiaryId: string,
  itemIds: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  if (itemIds.length === 0) return new Map();
  const rows = (await runner.execute<{ item_id: string; vendor_id: string; vendor_name: string }>(sql`
    select distinct on (m.item_id) m.item_id, d.party_id as vendor_id, p.display_name as vendor_name
      from inventory_movements m
      join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
      join documents d on d.id = l.document_id and d.org_id = l.org_id
      join parties p on p.id = d.party_id and p.org_id = d.org_id
     where m.org_id = ${orgId}
       and m.subsidiary_id = ${subsidiaryId}
       and m.kind = 'receipt'
       and m.status = 'posted'
       and m.reverses_movement_id is null
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = m.org_id and reversal.reverses_movement_id = m.id)
       and d.kind in ('purchase_receipt', 'vendor_bill')
       and m.item_id in (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})
     order by m.item_id, m.moved_at desc, m.id desc`)).rows;
  return new Map(rows.map((row) => [row.item_id, { id: row.vendor_id, name: row.vendor_name }]));
}

function proposalFor(
  projected: string,
  reorderPoint: string | null,
  preferredStockLevel: string | null,
): { status: ReplenishmentStatus; proposed: string } {
  if (reorderPoint === null || preferredStockLevel === null) return { status: "no_reorder_point", proposed: ZERO };
  if (cmp(preferredStockLevel, reorderPoint) < 0) return { status: "points_inverted", proposed: ZERO };
  if (cmp(projected, reorderPoint) > 0 || cmp(preferredStockLevel, projected) <= 0) {
    return { status: "covered", proposed: ZERO };
  }
  return { status: "reorder", proposed: add(preferredStockLevel, neg(projected)) };
}

/** Proposals for every active stocked item of one legal entity, by item label. */
export async function replenishmentProposals(
  runner: Runner,
  orgId: string,
  query: { subsidiaryId: string },
): Promise<ReplenishmentLine[]> {
  await assertWarehousingFeature(runner, orgId);
  const entity = await availabilityEntity(runner, orgId, query.subsidiaryId);
  const items = new Map([...(await stockedItems(runner, orgId, null))].filter(([, item]) => item.isActive));
  if (items.size === 0) return [];
  const terms = await demandTermsByItem(runner, orgId, { ...entity, items, locations: null });

  const onOrder = new Map<string, string>();
  for (const line of await purchaseOrderLineRemainders(runner as SqlExecutor, orgId, { openOnly: true })) {
    const item = items.get(line.itemId);
    if (!item || (line.subsidiaryId ?? entity.rootId) !== entity.subsidiaryId) continue;
    const quantity = openBaseQuantity(line.open, line.unit, item, `${line.documentNumber} line ${line.lineNumber}`);
    onOrder.set(line.itemId, add(onOrder.get(line.itemId) ?? ZERO, quantity));
  }
  const vendors = await lastReceiptVendors(runner, orgId, entity.subsidiaryId, [...items.keys()]);

  return [...items.values()].map((item) => {
    const entry = terms.get(item.itemId)!;
    const ordered = onOrder.get(item.itemId) ?? ZERO;
    const projected = add(add(entry.onHand, neg(entry.committed)), add(ordered, neg(entry.unallocated)));
    const vendor = vendors.get(item.itemId) ?? null;
    return {
      itemId: item.itemId,
      itemLabel: item.label,
      baseUnit: item.baseUnit,
      onHand: entry.onHand,
      committed: entry.committed,
      unallocated: entry.unallocated,
      onOrder: ordered,
      projected,
      reorderPoint: item.reorderPoint,
      preferredStockLevel: item.preferredStockLevel,
      ...proposalFor(projected, item.reorderPoint, item.preferredStockLevel),
      vendorId: vendor?.id ?? null,
      vendorName: vendor?.name ?? null,
    };
  });
}
