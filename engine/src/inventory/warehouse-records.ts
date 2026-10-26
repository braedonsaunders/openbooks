import { sql } from "drizzle-orm";
import type { WarehouseStatus } from "@openbooks/schema";
import { db } from "../platform/db.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import {
  WarehouseRefusal,
  assertWarehousingFeature,
  warehousingDisabledRefusal,
  WAREHOUSES_REMEDY,
} from "./warehouse-admission.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Read-level carve-out for the single-warehouse org: measuring inside its
 * one warehouse is single-location management, so warehouse reads pass
 * with the feature off. Setup reads (list/get) and all writes keep the
 * hard gate. A designated default on a multi-warehouse org still refuses
 * here; the scope entry points admit that case first, so the observable
 * refusal is identical either way.
 */
async function assertWarehouseRead(runner: Runner, orgId: string): Promise<void> {
  if (await orgFeatureEnabled(orgId, "warehousing", runner as SqlExecutor)) return;
  const rows = (
    await runner.execute<{ n: string }>(
      sql`
    select count(*)::text as n
      from warehouses w
      join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
     where w.org_id = ${orgId} and sl.is_active`,
      "objects",
    )
  )[0];
  if (Number(rows?.n ?? "0") > 1) throw warehousingDisabledRefusal();
}
export interface WarehouseAddress {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export type WarehouseRecord = Required<WarehouseAddress> & {
  id: string;
  code: string;
  name: string;
  status: WarehouseStatus;
  locationId: string;
  isActive: boolean;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
};

export const WAREHOUSE_SELECT = sql`
  select w.stock_location_id as id, sl.code, w.name, w.status, sl.location_id as "locationId",
         sl.is_active as "isActive",
         w.address_line1 as "addressLine1", w.address_line2 as "addressLine2", w.city,
         w.region, w.postal_code as "postalCode", w.country,
         w.status_changed_at::text as "statusChangedAt", w.status_changed_by as "statusChangedBy"
    from warehouses w
    join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id`;

function cleanText(value: string | null | undefined, field: string, max = 200): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new WarehouseRefusal(
      `${field} must be at most ${max} characters`,
      "invalid_input",
      `shorten the ${field}`,
      422,
    );
  }
  return trimmed;
}

function cleanAddress(input: WarehouseAddress): Required<WarehouseAddress> {
  const country = cleanText(input.country, "country", 2)?.toUpperCase() ?? null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    throw new WarehouseRefusal(
      `country ${country} is not an ISO 3166-1 alpha-2 code`,
      "invalid_country",
      "enter the two-letter country code, for example US or DE",
      422,
    );
  }
  return {
    addressLine1: cleanText(input.addressLine1, "address line 1"),
    addressLine2: cleanText(input.addressLine2, "address line 2"),
    city: cleanText(input.city, "city"),
    region: cleanText(input.region, "region"),
    postalCode: cleanText(input.postalCode, "postal code", 40),
    country,
  };
}

export async function writeWarehouseAudit(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  warehouseId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'warehouses', ${warehouseId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`,
    "objects",
  );
  if (written.length === 0) {
    throw new InventoryError("warehouse change was not audited; reload and try again");
  }
}

export async function listWarehouses(runner: Runner, orgId: string): Promise<WarehouseRecord[]> {
  await assertWarehousingFeature(runner, orgId);
  const r = await runner.execute<WarehouseRecord>(
    sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId}
     order by sl.code`,
    "objects",
  );
  return r;
}

export async function getWarehouse(
  runner: Runner,
  orgId: string,
  warehouseId: string,
): Promise<WarehouseRecord | null> {
  await assertWarehousingFeature(runner, orgId);
  const r = await runner.execute<WarehouseRecord>(
    sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId} and w.stock_location_id = ${warehouseId}`,
    "objects",
  );
  return r[0] ?? null;
}

/** The warehouse enclosing a stock location (itself included), or null. */
export async function warehouseOf(
  runner: Runner,
  orgId: string,
  stockLocationId: string,
): Promise<WarehouseRecord | null> {
  await assertWarehouseRead(runner, orgId);
  const r = await runner.execute<WarehouseRecord>(
    sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId}
       and w.stock_location_id = stock_location_warehouse(${orgId}::uuid, ${stockLocationId}::uuid)`,
    "objects",
  );
  return r[0] ?? null;
}

export type WarehouseLocationRecord = {
  id: string;
  parentId: string | null;
  code: string;
  kind: string;
  isActive: boolean;
};

/** The zones, bins and staging areas beneath a warehouse, parents before children. */
export async function listWarehouseLocations(
  runner: Runner,
  orgId: string,
  warehouseId: string,
): Promise<WarehouseLocationRecord[]> {
  await assertWarehouseRead(runner, orgId);
  const r = await runner.execute<WarehouseLocationRecord>(
    sql`
    with recursive tree as (
      select id, parent_id, code, kind, is_active, 0 as depth, code::text as path
        from stock_locations where org_id = ${orgId} and id = ${warehouseId} and kind = 'warehouse'
      union all
      select c.id, c.parent_id, c.code, c.kind, c.is_active, t.depth + 1, t.path || '/' || c.code
        from stock_locations c join tree t on c.parent_id = t.id
       where c.org_id = ${orgId} and c.kind <> 'warehouse' and t.depth < 64
    )
    select id, parent_id as "parentId", code, kind, is_active as "isActive"
      from tree where depth > 0 order by path`,
    "objects",
  );
  return r;
}

export interface CreateWarehouseInput extends WarehouseAddress {
  code: string;
  name: string;
  /** The `locations` dimension value the warehouse sits under. */
  locationId: string;
}

/**
 * Create a warehouse in draft. The warehouse-kind stock location is inserted
 * first; its insert trigger gives it the warehouse row every creation path
 * gets, and the same transaction then moves that row to draft with the name
 * and address, so no committed state ever shows an unnamed active warehouse.
 */
export async function createWarehouse(
  orgId: string,
  actorId: string | null,
  input: CreateWarehouseInput,
): Promise<WarehouseRecord> {
  const code = cleanText(input.code, "code", 40);
  const name = cleanText(input.name, "name");
  if (!code)
    throw new WarehouseRefusal(
      "a warehouse needs a code",
      "code_required",
      "enter a code such as WH-01",
      422,
    );
  if (!name)
    throw new WarehouseRefusal(
      "a warehouse needs a name",
      "name_required",
      "enter the warehouse name",
      422,
    );
  const address = cleanAddress(input);
  return db.transaction(async (tx) => {
    await assertWarehousingFeature(tx, orgId, { lock: true });
    const location = (
      await tx.execute<{ is_active: boolean }>(
        sql`
      select is_active from locations where org_id = ${orgId} and id = ${input.locationId}`,
        "objects",
      )
    )[0];
    if (!location?.is_active) {
      throw new WarehouseRefusal(
        "the warehouse's location must be an active location of this organization",
        "location_required",
        "choose an active location, or activate one in Setup → Locations",
        422,
      );
    }
    const taken =
      (
        await tx.execute(
          sql`
      select 1 from stock_locations where org_id = ${orgId} and kind = 'warehouse' and code = ${code}`,
          "objects",
        )
      ).length > 0;
    if (taken) {
      throw new WarehouseRefusal(
        `warehouse code ${code} is already in use`,
        "warehouse_code_taken",
        "choose a different warehouse code",
        409,
      );
    }
    const inserted = (
      await tx.execute<{ id: string }>(
        sql`
      insert into stock_locations (org_id, location_id, code, kind, is_active, created_by, updated_by)
      values (${orgId}, ${input.locationId}, ${code}, 'warehouse', true, ${actorId}, ${actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!inserted) throw new InventoryError("warehouse stock location was not created");
    const updated = await tx.execute<never>(sql`
      update warehouses
         set status = 'draft', name = ${name},
             address_line1 = ${address.addressLine1}, address_line2 = ${address.addressLine2},
             city = ${address.city}, region = ${address.region},
             postal_code = ${address.postalCode}, country = ${address.country},
             status_changed_at = now(), status_changed_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and stock_location_id = ${inserted.id}`);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new InventoryError(
        `warehouse ${code} has no warehouse row to name; the stock-location trigger did not run`,
      );
    }
    const record = (
      await tx.execute<WarehouseRecord>(
        sql`
      ${WAREHOUSE_SELECT}
       where w.org_id = ${orgId} and w.stock_location_id = ${inserted.id}`,
        "objects",
      )
    )[0]!;
    await writeWarehouseAudit(tx, orgId, actorId, record.id, "insert", {
      event: "warehouse_created",
      after: record,
    });
    return record;
  });
}

/** Edit a warehouse's name and address. Status moves only through the lifecycle functions. */
export async function updateWarehouseDetails(
  orgId: string,
  actorId: string | null,
  warehouseId: string,
  patch: WarehouseAddress & { name?: string },
): Promise<WarehouseRecord> {
  return db.transaction(async (tx) => {
    await assertWarehousingFeature(tx, orgId);
    const before = await lockWarehouse(tx, orgId, warehouseId);
    const name = patch.name === undefined ? before.name : cleanText(patch.name, "name");
    if (!name)
      throw new WarehouseRefusal(
        "a warehouse needs a name",
        "name_required",
        "enter the warehouse name",
        422,
      );
    const address = cleanAddress({
      addressLine1: patch.addressLine1 === undefined ? before.addressLine1 : patch.addressLine1,
      addressLine2: patch.addressLine2 === undefined ? before.addressLine2 : patch.addressLine2,
      city: patch.city === undefined ? before.city : patch.city,
      region: patch.region === undefined ? before.region : patch.region,
      postalCode: patch.postalCode === undefined ? before.postalCode : patch.postalCode,
      country: patch.country === undefined ? before.country : patch.country,
    });
    const updated = await tx.execute<never>(sql`
      update warehouses
         set name = ${name},
             address_line1 = ${address.addressLine1}, address_line2 = ${address.addressLine2},
             city = ${address.city}, region = ${address.region},
             postal_code = ${address.postalCode}, country = ${address.country},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and stock_location_id = ${warehouseId}`);
    if ((updated.rowCount ?? 0) !== 1)
      throw new InventoryError(`warehouse ${before.code} was not updated`);
    const after = (
      await tx.execute<WarehouseRecord>(
        sql`
      ${WAREHOUSE_SELECT}
       where w.org_id = ${orgId} and w.stock_location_id = ${warehouseId}`,
        "objects",
      )
    )[0]!;
    await writeWarehouseAudit(tx, orgId, actorId, warehouseId, "update", {
      event: "warehouse_details",
      before,
      after,
    });
    return after;
  });
}

export async function lockWarehouse(
  tx: Runner,
  orgId: string,
  warehouseId: string,
): Promise<WarehouseRecord> {
  const row = (
    await tx.execute<WarehouseRecord>(
      sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId} and w.stock_location_id = ${warehouseId}
     for update of w`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new WarehouseRefusal(
      "warehouse not found in this organization",
      "warehouse_not_found",
      `choose a warehouse listed in ${WAREHOUSES_REMEDY}`,
      422,
    );
  }
  return row;
}
