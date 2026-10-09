import { sql } from "drizzle-orm";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { InventoryError, type Runner } from "./contracts.ts";

/** A valued ownership receipt must consume exactly the custody decrease pending in its transaction. */
export async function assertCustodyReceiptEvidence(
  runner: Runner,
  orgId: string,
  actorId: string | null,
  input: {
    ownershipSourceStockId?: string;
    itemId: string;
    subsidiaryId: string;
    quantity: string;
    lotId?: string | null;
    serialId?: string | null;
    tx?: unknown;
    postJournal?: boolean;
  },
): Promise<void> {
  if (!input.ownershipSourceStockId) return;
  if (!actorId || !input.tx || input.postJournal === false)
    throw new InventoryError(
      "Ownership recognition requires a named actor, an atomic custody transaction and its own journal",
    );
  await lockActorCommandAuthority(
    runner,
    orgId,
    actorId,
    input.subsidiaryId,
    "items.post",
  );
  if (!(await lockAndCheckOrgFeature(runner, orgId, "consignment")))
    throw new InventoryError("Turn on Consignment before taking ownership");
  const source = (
    await runner.execute<{
      item_id: string;
      subsidiary_id: string;
      lot_id: string | null;
      serial_id: string | null;
      pending: boolean;
    }>(sql`
    select stock.item_id,stock.subsidiary_id,stock.lot_id,stock.serial_id,
      stock.original_quantity-stock.remaining_quantity-coalesce((select sum(event.quantity) from consignment_events event
        where event.org_id=stock.org_id and event.stock_id=stock.id and event.kind in ('transfer','return','take_ownership')),0)=${input.quantity}::numeric as pending
    from consignment_stock stock where stock.org_id=${orgId} and stock.id=${input.ownershipSourceStockId} for update`)
  ).rows[0];
  if (
    !source ||
    !source.pending ||
    source.item_id !== input.itemId ||
    source.subsidiary_id !== input.subsidiaryId ||
    source.lot_id !== (input.lotId ?? null) ||
    source.serial_id !== (input.serialId ?? null)
  )
    throw new InventoryError(
      "Ownership receipt must match the exact item, entity, tracking and unposted custody decrease",
    );
}
