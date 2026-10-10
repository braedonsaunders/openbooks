import { actorHasPermission } from "../organization/actor-permissions.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { InventoryError, InventoryNotFoundError } from "./contracts.ts";
import { assertInventoryFeature } from "./profile-policy.ts";
import { lockInventoryPosition } from "./position.ts";
import { inspectionHoldReason } from "./inspection-holds.ts";

/** A hold preserves on-hand and carrying value while preventing physical allocation. */
export async function setStockHold(
  orgId: string,
  actorId: string,
  input: {
    kind: "lot" | "serial";
    id: string;
    held: boolean;
    reason: string;
  },
) {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500)
    throw new InventoryError(
      "Enter a hold or release reason of 5–500 characters",
    );
  return withOrgTransaction(orgId, async () => {
    if (!(await db.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows.length) throw new ScopeNotFoundError();
    if (!(await actorHasPermission(db, orgId, actorId, "items.manage")))
      throw new ScopeNotFoundError();
    const table = input.kind === "lot" ? sql`lots` : sql`serials`;
    const subject = (
      await db.execute<{ item_id: string }>(
        sql`select item_id from ${table} where org_id=${orgId} and id=${input.id}`,
      )
    ).rows[0];
    if (!subject)
      throw new InventoryNotFoundError("Stock identifier not found");
    const positions = (
      await db.execute<{
        item_id: string;
        stock_location_id: string;
        subsidiary_id: string;
      }>(sql`
      select distinct item_id,stock_location_id,subsidiary_id from (
        select org_id,item_id,stock_location_id,subsidiary_id,lot_id,serial_id from inventory_movements
        union all select org_id,item_id,stock_location_id,subsidiary_id,lot_id,serial_id from consignment_stock
      ) positions
      where org_id=${orgId} and item_id=${subject.item_id}
        and ${input.kind === "lot" ? sql`lot_id` : sql`serial_id`}=${input.id}
      order by item_id,stock_location_id,subsidiary_id`)
    ).rows;
    for (const p of positions)
      await lockInventoryPosition(db, p.item_id, p.stock_location_id);
    const allowed = await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      null,
      "items.manage",
    );
    if (
      allowed !== null &&
      (!positions.length ||
        positions.some((p) => !allowed.has(p.subsidiary_id)))
    )
      throw new InventoryNotFoundError("Stock identifier not found");
    await assertInventoryFeature(db, orgId);
    const before = (
      await db.execute<{
        hold_reason: string | null;
      }>(sql`select hold_reason from ${table}
      where org_id=${orgId} and id=${input.id} for update`)
    ).rows[0];
    if (!before) throw new InventoryNotFoundError("Stock identifier not found");
    if (allowed !== null) {
      const owners = (
        await db.execute<{
          subsidiary_id: string;
        }>(sql`select distinct subsidiary_id from (
        select org_id,item_id,lot_id,serial_id,subsidiary_id from inventory_movements
        union all select org_id,item_id,lot_id,serial_id,subsidiary_id from consignment_stock
      ) positions where org_id=${orgId} and item_id=${subject.item_id}
        and ${input.kind === "lot" ? sql`lot_id` : sql`serial_id`}=${input.id}`)
      ).rows;
      if (owners.some((owner) => !allowed.has(owner.subsidiary_id)))
        throw new InventoryNotFoundError("Stock identifier not found");
    }
    const inspectionReason=(await db.execute<{reason:string|null}>(sql`select ${inspectionHoldReason(sql`${orgId}`,input.kind==='lot'?sql`${input.id}::uuid`:sql`null::uuid`,input.kind==='serial'?sql`${input.id}::uuid`:sql`null::uuid`)} as reason`)).rows[0]?.reason??null;
    if (!input.held && before.hold_reason===null && inspectionReason!==null) throw new InventoryError("This stock is held by an inspection. Complete its inspection or governed quality disposition in Manufacturing; a manual release cannot clear it.");
    if ((before.hold_reason !== null) === input.held)
      throw new InventoryError(
        input.held ? "Stock is already held" : "Stock is already released",
      );
    const after = input.held ? reason : null;
    const changed =
      await db.execute(sql`update ${table} set hold_reason=${after}, updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${input.id} returning id`);
    if (!changed.rows.length)
      throw new InventoryError("Stock hold changed — reload and retry");
    const audit =
      await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},${input.kind === "lot" ? "lots" : "serials"},${input.id},'update',
        ${JSON.stringify({ operation: input.held ? "hold" : "release", reason, before, after: { hold_reason: after } })}::jsonb,${actorId}) returning id`);
    if (!audit.rows.length)
      throw new InventoryError("Stock hold was not audited");
    return { id: input.id, holdReason: after??inspectionReason };
  });
}
