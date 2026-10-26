import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { loadSubsidiaryContext, restrictionAdmits } from "../organization/subsidiaries.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { InventoryError } from "./contracts.ts";
import { inventoryOffsetAccountProblem } from "./journal.ts";

/** A negative-stock shortfall with no recorded charge account. */
export type UnattributedDeficit = {
  id: string;
  itemId: string;
  stockLocationId: string;
  stockLocationCode: string;
  subsidiaryId: string;
  issuedOn: string;
  issueMovementId: string;
  remainingQuantity: string;
  provisionalUnitCost: string;
};

/**
 * Shortfalls of an item still awaiting their charge account. A receipt
 * corrects each shortfall's provisional cost on the account its issue
 * charged; these predate that record, so a receipt refuses to settle them
 * until an authorized user names the account.
 */
export async function listUnattributedDeficits(
  orgId: string,
  itemId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<UnattributedDeficit[]> {
  return withOrgTransaction(
    orgId,
    async () =>
      await db.execute<UnattributedDeficit>(
        sql`
    select deficit.id, deficit.item_id as "itemId", deficit.stock_location_id as "stockLocationId",
           location.code as "stockLocationCode", deficit.subsidiary_id as "subsidiaryId",
           issue.moved_at::text as "issuedOn", deficit.issue_movement_id as "issueMovementId",
           deficit.remaining_quantity::text as "remainingQuantity",
           deficit.provisional_unit_cost::text as "provisionalUnitCost"
      from inventory_provisional_costs deficit
      join inventory_movements issue on issue.org_id = deficit.org_id and issue.id = deficit.issue_movement_id
      join stock_locations location on location.org_id = deficit.org_id and location.id = deficit.stock_location_id
     where deficit.org_id = ${orgId} and deficit.item_id = ${itemId}
       and deficit.offset_account_id is null and deficit.remaining_quantity > 0
       ${subsidiaryVisibleFilter(sql`deficit.subsidiary_id`, allowedSubsidiaryIds ?? null)}
     order by deficit.created_at, deficit.id`,
        "objects",
      ),
  );
}

/**
 * Record the account an unattributed shortfall was charged to. Only a
 * shortfall with no account yet is admitted: a recorded account is evidence
 * of the original issue and is never replaced. The actor needs GL posting
 * authority in the shortfall's legal entity, because the account decides
 * where the later receipt's correction posts; the change is audited with
 * the actor's reason.
 */
export async function attributeDeficitAccount(input: {
  orgId: string;
  actorId: string;
  deficitId: string;
  accountId: string;
  reason: string;
}): Promise<{ deficitId: string; accountId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new InventoryError(
      "state why this account carried the shortfall's cost, in 8 to 500 characters",
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    const deficit = (
      await db.execute<{
        id: string;
        item_id: string;
        subsidiary_id: string;
        offset_account_id: string | null;
        remaining_quantity: string;
      }>(
        sql`
      select id, item_id, subsidiary_id, offset_account_id, remaining_quantity::text as remaining_quantity
        from inventory_provisional_costs
       where org_id = ${input.orgId} and id = ${input.deficitId}
       for update`,
        "objects",
      )
    )[0];
    if (!deficit) throw new InventoryError("that shortfall was not found in this organization");
    await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      deficit.subsidiary_id,
      "gl.post",
    );
    if (deficit.offset_account_id !== null) {
      throw new InventoryError(
        "this shortfall already records the account its issue charged; that record is kept as issued",
      );
    }
    const account = (
      await db.execute<{
        id: string;
        is_active: boolean;
        is_summary: boolean;
        subsidiary_id: string | null;
        subsidiary_include_children: boolean;
      }>(
        sql`
      select id, is_active, is_summary, subsidiary_id, subsidiary_include_children from accounts
       where org_id = ${input.orgId} and id = ${input.accountId}
       for share`,
        "objects",
      )
    )[0];
    if (!account || !account.is_active || account.is_summary) {
      throw new InventoryError(
        "choose an active posting account from this organization's chart of accounts",
      );
    }
    const subsidiaries = await loadSubsidiaryContext(db, input.orgId);
    if (
      !restrictionAdmits(
        subsidiaries,
        account.subsidiary_id,
        account.subsidiary_include_children,
        deficit.subsidiary_id,
      )
    ) {
      throw new InventoryError(
        "choose an active posting account available to the subsidiary that carried this shortfall's cost",
      );
    }
    const asset = (
      await db.execute<{ asset_account_id: string }>(
        sql`
      select asset_account_id from item_inventory_profiles
       where org_id = ${input.orgId} and item_id = ${deficit.item_id}`,
        "objects",
      )
    )[0];
    const problem = asset
      ? inventoryOffsetAccountProblem(asset.asset_account_id, input.accountId, "shortfall charge")
      : null;
    if (problem) throw new InventoryError(problem);
    const updated = (
      await db.execute<{ id: string }>(
        sql`
      update inventory_provisional_costs
         set offset_account_id = ${input.accountId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.deficitId} and offset_account_id is null
       returning id`,
        "objects",
      )
    )[0];
    if (!updated)
      throw new InventoryError(
        "this shortfall's account was recorded by another action; reload it",
      );
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'inventory_provisional_costs', ${input.deficitId}, 'update',
              ${JSON.stringify({
                event: "deficit_charge_account_attributed",
                reason,
                before: { offset_account_id: null },
                after: { offset_account_id: input.accountId },
                remainingQuantity: deficit.remaining_quantity,
              })}::jsonb, ${input.actorId})`);
    return { deficitId: input.deficitId, accountId: input.accountId };
  });
}
