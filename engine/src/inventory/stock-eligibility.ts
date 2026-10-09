import { sql, type SQL } from "drizzle-orm";
import { InventoryError, type Runner } from "./contracts.ts";

/** Ancestor restrictions apply to every descendant bin. Cycles are visited once. */
export function saleableLocation(org: SQL, location: SQL): SQL {
  return sql`exists (
    with recursive ancestors as (
      select id,parent_id,kind,is_active,inventory_ownership, array[id] as path
        from stock_locations where org_id=${org} and id=${location}
      union all
      select p.id,p.parent_id,p.kind,p.is_active,p.inventory_ownership,a.path || p.id
        from stock_locations p join ancestors a on p.id=a.parent_id
       where p.org_id=${org} and not p.id=any(a.path)
    ) select 1 from ancestors having count(*)>0
       and bool_and(is_active and kind not in ('quarantine','transit') and inventory_ownership='owned')
       and bool_or(parent_id is null)
  )`;
}

export function unheldTracking(org: SQL, lot: SQL, serial: SQL): SQL {
  return sql`not exists(select 1 from lots h where h.org_id=${org} and h.id=${lot} and h.hold_reason is not null)
    and not exists(select 1 from serials h where h.org_id=${org} and h.id=${serial} and h.hold_reason is not null)`;
}

export async function assertSaleableStock(
  runner: Runner,
  orgId: string,
  stockLocationId: string,
  selection: { lotId?: string | null; serialId?: string | null } = {},
): Promise<void> {
  await runner.execute(sql`select sl.id from stock_locations sl where sl.org_id=${orgId} and sl.id in (
    with recursive path as (
      select id,parent_id,array[id] as visited from stock_locations where org_id=${orgId} and id=${stockLocationId}
      union all select p.id,p.parent_id,path.visited||p.id from stock_locations p join path on path.parent_id=p.id
        where p.org_id=${orgId} and not p.id=any(path.visited)
    ) select id from path
  ) order by sl.id for share`);
  if (selection.lotId)
    await runner.execute(
      sql`select id from lots where org_id=${orgId} and id=${selection.lotId} for update`,
    );
  if (selection.serialId)
    await runner.execute(
      sql`select id from serials where org_id=${orgId} and id=${selection.serialId} for update`,
    );
  const row = (
    await runner.execute<{ eligible: boolean }>(sql`select
    ${saleableLocation(sql`${orgId}`, sql`${stockLocationId}::uuid`)}
    and ${unheldTracking(sql`${orgId}`, sql`${selection.lotId ?? null}::uuid`, sql`${selection.serialId ?? null}::uuid`)} as eligible`)
  ).rows[0];
  if (!row?.eligible)
    throw new InventoryError(
      "Stock is quarantined, held, externally owned, or unavailable — release the hold or transfer cleared stock to an active owned bin before picking or selling",
    );
}

/** Owned inventory must never create a valued layer in an external-owner location. */
export async function assertOwnedLocation(
  runner: Runner,
  orgId: string,
  stockLocationId: string,
): Promise<void> {
  const row = (
    await runner.execute<{
      ownership: string;
    }>(sql`select inventory_ownership as ownership from stock_locations
    where org_id=${orgId} and id=${stockLocationId} for share`)
  ).rows[0];
  if (!row || row.ownership !== "owned")
    throw new InventoryError(
      "Use the Consignment receipt command for externally owned stock; valued inventory requires an owned location",
    );
}
