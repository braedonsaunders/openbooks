import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { listAvailableToPromise } from "./availability.ts";

export interface KitAvailabilityIdentity {
  id: string;
  kind: string;
  code: string | null;
  name: string;
}

export async function loadKitAvailabilityIdentity(
  orgId: string,
  itemId: string,
): Promise<KitAvailabilityIdentity | undefined> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<KitAvailabilityIdentity>(
        sql`
        select id, kind, code, name from items
         where org_id = ${orgId} and id = ${itemId}
      `,
        "objects",
      );
      return rows[0];
    },
    { readOnly: true },
  );
}

export interface KitAvailabilitySummary {
  kit: {
    itemId: string;
    itemLabel: string;
    onHand: string;
    committed: string;
    available: string;
  } | null;
  components: Array<{
    itemId: string;
    itemLabel: string;
    onHand: string;
    committed: string;
    available: string;
  } | null>;
}

export interface KitWarehouseAvailability {
  warehouseId: string;
  warehouseCode: string;
  kit: KitAvailabilitySummary["kit"];
  components: KitAvailabilitySummary["components"];
}

export type KitAvailabilityWorkspace =
  | { kind: "empty" }
  | {
      kind: "loaded";
      allLocations: KitAvailabilitySummary;
      warehouses: KitWarehouseAvailability[];
    };

export async function loadKitAvailabilityWorkspace(input: {
  orgId: string;
  itemId: string;
  subsidiaryId: string;
  asOfDate: string;
}): Promise<KitAvailabilityWorkspace> {
  return withOrgTransaction(
    input.orgId,
    async () => {
      const recipe = await db.execute<{ component_item_id: string }>(
        sql`
        select distinct component_item_id
          from bom_components
         where org_id = ${input.orgId} and assembly_item_id = ${input.itemId}
           and operation_seq is null and is_byproduct = false
           and (effective_from is null or effective_from <= ${input.asOfDate}::date)
           and (effective_to is null or ${input.asOfDate}::date < effective_to)
      `,
        "objects",
      );
      if (recipe.length === 0) return { kind: "empty" as const };

      const itemIds = [input.itemId, ...recipe.map((row) => row.component_item_id)];
      const warehouses = await db.execute<{ id: string; code: string }>(
        sql`
        select sl.id, sl.code from warehouses w
          join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
          join locations location on location.id = sl.location_id and location.org_id = sl.org_id
         where w.org_id = ${input.orgId}
           and (
             location.subsidiary_id is null
             or location.subsidiary_id = ${input.subsidiaryId}::uuid
             or (location.subsidiary_include_children and location.subsidiary_id in (
               with recursive ancestors(id) as (
                 select parent_id from subsidiaries
                  where org_id = ${input.orgId} and id = ${input.subsidiaryId}::uuid
                 union all
                 select subsidiary.parent_id from subsidiaries subsidiary
                   join ancestors on subsidiary.id = ancestors.id
                  where subsidiary.parent_id is not null
               )
               select id from ancestors where id is not null
             ))
           )
         order by sl.code
      `,
        "objects",
      );

      const shape = (
        rows: Array<{
          itemId: string;
          itemLabel: string;
          onHand: string;
          committed: string;
          available: string;
        }>,
      ): KitAvailabilitySummary => {
        const byId = new Map(rows.map((row) => [row.itemId, row]));
        return {
          kit: byId.get(input.itemId) ?? null,
          components: recipe.map((row) => byId.get(row.component_item_id) ?? null),
        };
      };

      const all = await listAvailableToPromise(db, input.orgId, {
        subsidiaryId: input.subsidiaryId,
        itemIds,
        asOfDate: input.asOfDate,
      });
      const perWarehouse: KitWarehouseAvailability[] = [];
      for (const warehouse of warehouses) {
        const rows = await listAvailableToPromise(db, input.orgId, {
          subsidiaryId: input.subsidiaryId,
          itemIds,
          warehouseId: warehouse.id,
          asOfDate: input.asOfDate,
        });
        perWarehouse.push({
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          ...shape(rows),
        });
      }
      return { kind: "loaded" as const, allLocations: shape(all), warehouses: perWarehouse };
    },
    { readOnly: true },
  );
}
