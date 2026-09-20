import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { InventoryError } from "./contracts.ts";
// ---------------------------------------------------------------------------
// Lot / serial tracking
// ---------------------------------------------------------------------------

/**
 * Enforce an item's tracking discipline on a movement. Lot-tracked items must
 * name a lot on receipt; serial-tracked items always move exactly one unit and
 * must name the serial. (Issues pick lots/serials via their own inputs; the
 * receipt-side rule is what guarantees downstream traceability.)
 */
export function assertTracking(
  profile: { tracking: string },
  input: { quantity: string; lotId?: string | null; serialId?: string | null },
  kind: string,
): void {
  if (profile.tracking === "lot") {
    if (!input.lotId) {
      throw new InventoryError(`lot-tracked item requires a lot on ${kind}`);
    }
    if (input.serialId) {
      throw new InventoryError("lot-tracked item cannot carry a serial");
    }
  } else if (profile.tracking === "serial") {
    if (!input.serialId)
      throw new InventoryError(
        `serial-tracked item requires a serial on ${kind}`,
      );
    if (cmp(input.quantity, "1") !== 0 && cmp(input.quantity, "-1") !== 0) {
      throw new InventoryError(
        "serial-tracked movements must be exactly one unit per serial",
      );
    }
    if (input.lotId) {
      throw new InventoryError("serial-tracked item cannot carry a lot");
    }
  } else if (input.lotId || input.serialId) {
    throw new InventoryError(
      "untracked item movement cannot carry lot or serial evidence",
    );
  }
}

/** Find-or-create a lot for an item; a later expiry date is never lost. */
export async function ensureLot(
  orgId: string,
  itemId: string,
  lotNumber: string,
  expiresOn: string | null,
  actorId: string | null,
): Promise<string> {
  if (!lotNumber?.trim()) throw new InventoryError("lot number is required");
  return db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into lots
        (org_id, item_id, lot_number, expires_on, created_by, updated_by)
      values
        (${orgId}, ${itemId}, ${lotNumber.trim()}, ${expiresOn ?? null},
         ${actorId}, ${actorId})
      on conflict (item_id, lot_number) do nothing
      returning id
    `));
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = (await tx.execute<{ id: string; org_id: string; expires_on: string | null }>(sql`
      select id, org_id, expires_on::text
        from lots
       where org_id = ${orgId} and item_id = ${itemId} and lot_number = ${lotNumber.trim()}
       for update
    `));
    const row = existing.rows[0];
    if (!row || row.org_id !== orgId) {
      throw new InventoryError("lot identity belongs to another organization");
    }
    if (
      expiresOn != null &&
      row.expires_on != null &&
      expiresOn !== row.expires_on
    ) {
      throw new InventoryError(
        "lot expiry is already established; use a controlled correction with audit evidence",
      );
    }
    if (expiresOn != null && row.expires_on == null) {
      await tx.execute(sql`
        update lots
           set expires_on = ${expiresOn}, updated_at = now(), updated_by = ${actorId}
         where id = ${row.id} and org_id = ${orgId}
      `);
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'lots', ${row.id}, 'update',
           ${JSON.stringify({
             expiresOn: { before: null, after: expiresOn },
             reason: "complete previously missing lot expiry evidence",
           })}::jsonb,
           ${actorId})
      `);
    }
    return row.id;
  });
}

/** Find-or-create a serial for an item, placing it in stock at a location. */
export async function ensureSerial(
  orgId: string,
  itemId: string,
  serialNumber: string,
  stockLocationId: string | null,
  actorId: string | null,
): Promise<string> {
  if (!serialNumber?.trim())
    throw new InventoryError("serial number is required");
  return db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into serials
        (org_id, item_id, serial_number, status, current_stock_location_id,
         created_by, updated_by)
      values
        (${orgId}, ${itemId}, ${serialNumber.trim()}, 'registered', null,
         ${actorId}, ${actorId})
      on conflict (item_id, serial_number) do nothing
      returning id
    `));
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = (await tx.execute<{
        id: string;
        org_id: string;
        current_stock_location_id: string | null;
      }>(sql`
      select id, org_id, current_stock_location_id
        from serials
       where org_id = ${orgId} and item_id = ${itemId} and serial_number = ${serialNumber.trim()}
       for update
    `));
    const row = existing.rows[0];
    if (!row || row.org_id !== orgId) {
      throw new InventoryError(
        "serial identity belongs to another organization",
      );
    }
    if (
      stockLocationId &&
      row.current_stock_location_id &&
      row.current_stock_location_id !== stockLocationId
    ) {
      throw new InventoryError(
        "serial is already registered at a different stock location",
      );
    }
    return row.id;
  });
}

export interface LotRecallFilter {
  lotNumber?: string;
  lotId?: string;
  itemId?: string;
  expiresOnOrBefore?: string;
  includeExpiryOnly?: boolean;
  /** Null/omitted is unrestricted; an empty list is deliberately no access. */
  subsidiaryIds?: readonly string[] | null;
}

export type LotRecallRow = {
  movementId: string;
  lotId: string;
  lotNumber: string;
  expiresOn: string | null;
  itemId: string;
  itemCode: string | null;
  itemName: string | null;
  kind: string;
  movedAt: string;
  quantity: string;
  locationCode: string | null;
  documentId: string | null;
  documentNumber: string | null;
  partyName: string | null;
};

/**
 * Lot traceability: every movement that touched a lot, with the source
 * document and party where the movement came from a bill/invoice line. This
 * is the recall report — "which customers received lot X" runs the same query
 * filtered to issues.
 */
export async function queryLotRecall(
  orgId: string,
  filter: LotRecallFilter,
): Promise<LotRecallRow[]> {
  const subsidiaryScope =
    filter.subsidiaryIds == null
      ? sql``
      : filter.subsidiaryIds.length === 0
        ? sql`and false`
        : sql`and im.subsidiary_id in (${sql.join(
            filter.subsidiaryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  const r = (await db.execute<LotRecallRow>(sql`
    select im.id as "movementId", l.id as "lotId", l.lot_number as "lotNumber", l.expires_on::text as "expiresOn",
           i.id as "itemId", i.code as "itemCode", i.name as "itemName", im.kind, im.moved_at::text as "movedAt",
           im.quantity::text as "quantity", sl.code as "locationCode",
           d.id as "documentId", d.document_number as "documentNumber", p.display_name as "partyName"
      from inventory_movements im
      join lots l on l.id = im.lot_id and l.org_id = im.org_id
      join items i on i.id = im.item_id and i.org_id = im.org_id
      left join stock_locations sl on sl.id = im.stock_location_id and sl.org_id = im.org_id
      left join document_lines dl on dl.id = im.document_line_id and dl.org_id = im.org_id
      left join documents d on d.id = dl.document_id and d.org_id = im.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where im.org_id = ${orgId}
       and (${filter.lotId ?? null}::uuid is null or l.id = ${filter.lotId ?? null}::uuid)
       and (${filter.itemId ?? null}::uuid is null or l.item_id = ${filter.itemId ?? null}::uuid)
       and (${filter.lotNumber ?? null}::text is null or l.lot_number ilike '%' || ${filter.lotNumber ?? ""} || '%')
       and (${filter.expiresOnOrBefore ?? null}::date is null or l.expires_on <= ${filter.expiresOnOrBefore ?? null}::date)
       and (${filter.includeExpiryOnly !== true} or l.expires_on is not null)
       ${subsidiaryScope}
     order by im.moved_at desc`));
  return r.rows;
}
