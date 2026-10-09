import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, withScopeSnapshot } from "../organization/subsidiary-scope.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { InventoryError, InventoryNotFoundError, type InventoryProfile } from "./contracts.ts";

export interface InventoryTrackingOptions {
  tracking: InventoryProfile["tracking"];
  lots: Array<{ id: string; label: string; expiry: string | null; hold_reason: string | null }>;
  serials: Array<{ id: string; label: string; lot_id: string | null; hold_reason: string | null }>;
}

/** Identifiers follow movement and custody entity lineage. Before first use,
 * restricted operators may select only identifiers they registered themselves;
 * unrestricted operators may select all tenant identifiers. An empty entity
 * scope exposes no identifiers, including registrations. */
export async function inventoryTrackingOptions(
  orgId: string,
  actorId: string,
  query: { itemId: string; q?: string; lotId?: string },
): Promise<InventoryTrackingOptions> {
  if (!isUuid(query.itemId) || (query.lotId !== undefined && !isUuid(query.lotId)))
    throw new InventoryError("Choose valid inventory identifiers");
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 200))
    throw new InventoryError("Identifier search must contain at most 200 characters");
  return withScopeSnapshot(orgId, async () => {
    const allowed = await lockActorCommandAuthority(db, orgId, actorId, null, "items.read");
    if (!(await lockAndCheckOrgFeature(db, orgId, "inventory"))) throw new ScopeNotFoundError();
    const profile = (await db.execute<{ tracking: InventoryProfile["tracking"] | null }>(sql`
      select profile.tracking from items item
      left join item_inventory_profiles profile on profile.org_id=item.org_id and profile.item_id=item.id
      where item.org_id=${orgId} and item.id=${query.itemId}`)).rows[0];
    if (!profile) throw new InventoryNotFoundError("Inventory item not found");
    if (profile.tracking === null)
      throw new InventoryError("Item has no inventory profile — configure its costing and tracking before selecting identifiers");
    if (!["none", "lot", "serial", "lot_serial"].includes(profile.tracking))
      throw new InventoryError("Configure a supported inventory tracking mode before selecting identifiers");
    const result: InventoryTrackingOptions = { tracking: profile.tracking, lots: [], serials: [] };
    const permitted = allowed === null ? null : (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id=${orgId} and id=any(${uuidArray([...allowed])}::uuid[])`)).rows.map(row => row.id);
    if (permitted !== null && permitted.length === 0) return result;
    const entityScope = permitted === null ? sql`true` : sql`p.subsidiary_id=any(${uuidArray(permitted)}::uuid[])`;
    const visible = sql`
      positions as (
        select lot_id,serial_id,subsidiary_id from inventory_movements where org_id=${orgId} and item_id=${query.itemId}
        union all
        select lot_id,serial_id,subsidiary_id from consignment_stock where org_id=${orgId} and item_id=${query.itemId}
      ), visible_lots as (
        select lot.id,lot.lot_number as label,lot.expires_on::text as expiry,lot.hold_reason
        from lots lot where lot.org_id=${orgId} and lot.item_id=${query.itemId}
          and ${permitted === null ? sql`true` : sql`(
            exists(select 1 from positions p where p.lot_id=lot.id and ${entityScope})
            or (lot.created_by=${actorId} and not exists(select 1 from positions p where p.lot_id=lot.id)))`}
      ), visible_serials as (
        select serial.id,serial.serial_number as label,serial.lot_id,serial.hold_reason
        from serials serial where serial.org_id=${orgId} and serial.item_id=${query.itemId}
          and (serial.lot_id is null or exists(select 1 from visible_lots lot where lot.id=serial.lot_id))
          and ${permitted === null ? sql`true` : sql`(
            exists(select 1 from positions p where p.serial_id=serial.id and ${entityScope})
            or (serial.created_by=${actorId} and serial.status='registered' and serial.current_stock_location_id is null
              and not exists(select 1 from positions p where p.serial_id=serial.id)))`}
      )`;
    if (query.lotId && !(await db.execute(sql`with ${visible} select id from visible_lots where id=${query.lotId}`)).rows.length)
      throw new InventoryNotFoundError("Stock identifier not found");
    result.lots = (await db.execute<InventoryTrackingOptions["lots"][number]>(sql`
      with ${visible} select * from visible_lots where label ilike ${`%${query.q ?? ""}%`}
      order by expiry nulls last,label,id limit 100`)).rows;
    result.serials = (await db.execute<InventoryTrackingOptions["serials"][number]>(sql`
      with ${visible} select * from visible_serials where label ilike ${`%${query.q ?? ""}%`}
        ${query.lotId ? sql`and (lot_id=${query.lotId} or lot_id is null)` : sql``}
      order by label,id limit 100`)).rows;
    return result;
  });
}
