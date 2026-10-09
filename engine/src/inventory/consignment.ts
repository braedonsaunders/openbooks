import { actorHasPermission } from "../organization/actor-permissions.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
  SubsidiaryError,
} from "../organization/subsidiaries.ts";
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryOwnershipError,
} from "./contracts.ts";
import {
  assertInventoryDate,
  lockInventoryPosition,
  persistReceiptMoney,
} from "./position.ts";
import {
  assertStockLocationAdmitsSubsidiary,
  assertMovementOwner,
  resolveProfile,
} from "./profile-policy.ts";
import { validateTrackingSelection } from "./tracking.ts";
import { receiveInventory } from "./movements.ts";

export interface ConsignmentInput {
  action: "receive" | "transfer" | "return" | "take_ownership";
  stockId?: string;
  itemId?: string;
  stockLocationId?: string;
  subsidiaryId?: string;
  toStockLocationId?: string;
  quantity: string;
  date: string;
  reason: string;
  lotId?: string | null;
  serialId?: string | null;
  unitCost?: string;
  offsetAccountId?: string;
}
interface CustodyRow {
  id: string;
  item_id: string;
  stock_location_id: string;
  subsidiary_id: string;
  owner_party_id: string;
  owner_kind: "vendor" | "customer";
  lot_id: string | null;
  serial_id: string | null;
  remaining_quantity: string;
  received_on: string;
}
/** External custody records physical quantity only. Ownership recognition uses the native valued receipt. */
export async function moveConsignment(
  orgId: string,
  actorId: string,
  input: ConsignmentInput,
) {
  const quantity = persistReceiptMoney(input.quantity, "consignment quantity");
  if (cmp(quantity, "0") <= 0)
    throw new InventoryError("Consignment quantity must be positive");
  assertInventoryDate(input.date, "Consignment date");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500)
    throw new InventoryError(
      "Enter an ownership or custody reason of 5–500 characters",
    );
  return withOrgTransaction(orgId, async () => {
    if (!(await actorHasPermission(db, orgId, actorId, "items.post")))
      throw new ScopeNotFoundError();
    const source = input.stockId
      ? (
          await db.execute<CustodyRow>(
            sql`select stock.*,received_on::text as received_on from consignment_stock stock where org_id=${orgId} and id=${input.stockId}`,
          )
        ).rows[0]
      : null;
    if (input.action !== "receive" && !source)
      throw new InventoryNotFoundError("Consigned stock not found");
    const itemId = source?.item_id ?? input.itemId,
      locationId = source?.stock_location_id ?? input.stockLocationId,
      subsidiaryId = source?.subsidiary_id ?? input.subsidiaryId;
    if (!itemId || !locationId || !subsidiaryId)
      throw new InventoryError(
        "Choose the item, custody location and legal entity",
      );
    const positions = [
      locationId,
      ...(input.toStockLocationId ? [input.toStockLocationId] : []),
    ].sort();
    for (const loc of positions) await lockInventoryPosition(db, itemId, loc);
    await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      subsidiaryId,
      "items.post",
    );
    if (!(await lockAndCheckOrgFeature(db, orgId, "consignment")))
      throw new InventoryError(
        "Turn on Consignment in Company Settings → Features",
      );
    const context = await loadSubsidiaryContext(db, orgId);
    assertMovementOwner(context, subsidiaryId);
    await assertStockLocationAdmitsSubsidiary(
      db,
      orgId,
      context,
      locationId,
      subsidiaryId,
      input.action === "receive" ? "inbound" : "outbound",
    );
    const loc = (
      await db.execute<{
        inventory_ownership: string;
        owner_party_id: string | null;
      }>(
        sql`select inventory_ownership,owner_party_id from stock_locations where org_id=${orgId} and id=${locationId} for share`,
      )
    ).rows[0];
    if (!loc || loc.inventory_ownership === "owned" || !loc.owner_party_id)
      throw new InventoryError(
        "Choose a consignment location with an external vendor or customer owner",
      );
    const party = (
      await db.execute<{ is_active: boolean; kind: string }>(
        sql`select is_active,kind from parties where org_id=${orgId} and id=${loc.owner_party_id} for share`,
      )
    ).rows[0];
    if (!party?.is_active)
      throw new InventoryError(
        "Custody owner must be an active party admitted to this legal entity",
      );
    try {
      await validateSubsidiaryRestrictions(db, {
        orgId,
        ctx: context,
        lines: [],
        partyId: loc.owner_party_id,
        docSubsidiaryId: subsidiaryId,
      });
    } catch (error) {
      if (error instanceof SubsidiaryError)
        throw new InventoryOwnershipError(error.message, { cause: error });
      throw error;
    }
    const roleTable =
      loc.inventory_ownership === "vendor"
        ? sql`vendor_roles`
        : sql`customer_roles`;
    const role = (
      await db.execute(
        sql`select 1 from ${roleTable} where org_id=${orgId} and party_id=${loc.owner_party_id} for share`,
      )
    ).rows;
    if (party.kind !== loc.inventory_ownership && !role.length)
      throw new InventoryError(
        "Custody owner must have the selected vendor or customer role",
      );
    const item = (
      await db.execute<{ is_active: boolean; kind: string }>(
        sql`select is_active,kind from items where org_id=${orgId} and id=${itemId} for share`,
      )
    ).rows[0];
    if (!item?.is_active || !["inventory", "assembly"].includes(item.kind))
      throw new InventoryError("Choose an active stocked item for custody");
    const profile = await resolveProfile(orgId, itemId, db, true);
    let stockId = source?.id;
    let before: CustodyRow | null = source;
    let receiptMovementId: string | null = null,
      toStockId: string | null = null;
    if (input.action === "receive") {
      await validateTrackingSelection(
        db,
        orgId,
        itemId,
        locationId,
        profile,
        { quantity, lotId: input.lotId, serialId: input.serialId },
        "custody_receipt",
        actorId,
      );
      const row = (
        await db.execute<{ id: string }>(sql`insert into consignment_stock
        (org_id,subsidiary_id,item_id,stock_location_id,owner_party_id,owner_kind,lot_id,serial_id,received_on,original_quantity,remaining_quantity,reason,created_by,updated_by)
        values(${orgId},${subsidiaryId},${itemId},${locationId},${loc.owner_party_id},${loc.inventory_ownership},${input.lotId ?? null},${input.serialId ?? null},${input.date},${quantity},${quantity},${reason},${actorId},${actorId}) returning id`)
      ).rows[0];
      if (!row)
        throw new InventoryError("Consignment receipt was not recorded");
      stockId = row.id;
    } else {
      const held = (
        await db.execute<CustodyRow>(
          sql`select stock.*,received_on::text as received_on from consignment_stock stock where org_id=${orgId} and id=${stockId} for update`,
        )
      ).rows[0];
      if (
        !held ||
        held.stock_location_id !== locationId ||
        held.item_id !== itemId ||
        held.subsidiary_id !== subsidiaryId
      )
        throw new InventoryError(
          "Consigned position changed — reload and retry",
        );
      before = held;
      if (
        held.owner_party_id !== loc.owner_party_id ||
        held.owner_kind !== loc.inventory_ownership
      )
        throw new InventoryError(
          "Custody location ownership differs from the receipt",
        );
      if (input.date < held.received_on)
        throw new InventoryError(
          "Custody operation cannot precede its receipt date",
        );
      if (cmp(quantity, held.remaining_quantity) > 0)
        throw new InventoryError("Consigned quantity exceeds stock in custody");
      if (held.serial_id && cmp(quantity, "1") !== 0)
        throw new InventoryError("Move one unit per consigned serial");
      if (input.action === "transfer" || input.action === "take_ownership") {
        if (!input.toStockLocationId || input.toStockLocationId === locationId)
          throw new InventoryError(
            "Choose a different destination stock location",
          );
        await assertStockLocationAdmitsSubsidiary(
          db,
          orgId,
          context,
          input.toStockLocationId,
          subsidiaryId,
          "inbound",
        );
        const dest = (
          await db.execute<{
            inventory_ownership: string;
            owner_party_id: string | null;
          }>(
            sql`select inventory_ownership,owner_party_id from stock_locations where org_id=${orgId} and id=${input.toStockLocationId} for share`,
          )
        ).rows[0];
        if (input.action === "transfer") {
          if (
            !dest ||
            dest.inventory_ownership !== held.owner_kind ||
            dest.owner_party_id !== held.owner_party_id
          )
            throw new InventoryError(
              "Custody transfer must preserve the external owner",
            );
          // Retire the source serial before inserting its destination custody row.
          const retired =
            await db.execute(sql`update consignment_stock set remaining_quantity=remaining_quantity-${quantity},updated_by=${actorId},updated_at=now()
            where org_id=${orgId} and id=${held.id} and remaining_quantity>=${quantity} returning id`);
          if (!retired.rows.length)
            throw new InventoryError("Consignment quantity changed");
          const next = (
            await db.execute<{ id: string }>(sql`insert into consignment_stock
            (org_id,subsidiary_id,item_id,stock_location_id,owner_party_id,owner_kind,lot_id,serial_id,received_on,original_quantity,remaining_quantity,reason,created_by,updated_by)
            values(${orgId},${subsidiaryId},${itemId},${input.toStockLocationId},${held.owner_party_id},${held.owner_kind},${held.lot_id},${held.serial_id},${input.date},${quantity},${quantity},${reason},${actorId},${actorId}) returning id`)
          ).rows[0];
          if (!next)
            throw new InventoryError(
              "Custody transfer destination was not recorded",
            );
          toStockId = next.id;
        } else {
          if (dest?.inventory_ownership !== "owned")
            throw new InventoryError(
              "Taking ownership requires an owned destination location",
            );
          if (input.unitCost === undefined || !input.offsetAccountId)
            throw new InventoryError(
              "Enter the agreed ownership unit cost and offset account",
            );
          const retired =
            await db.execute(sql`update consignment_stock set remaining_quantity=remaining_quantity-${quantity},updated_by=${actorId},updated_at=now()
            where org_id=${orgId} and id=${held.id} and remaining_quantity>=${quantity} returning id`);
          if (!retired.rows.length)
            throw new InventoryError(
              "Custody quantity changed before ownership recognition",
            );
          const receipt = await receiveInventory(orgId, actorId, {
            itemId,
            stockLocationId: input.toStockLocationId,
            subsidiaryId,
            quantity,
            date: input.date,
            unitCost: input.unitCost,
            offsetAccountId: input.offsetAccountId,
            lotId: held.lot_id,
            serialId: held.serial_id,
            memo: reason,
            ownershipSourceStockId: held.id,
            tx: db,
          });
          receiptMovementId = receipt.movementId;
        }
      }
      if (input.action === "return") {
        const changed =
          await db.execute(sql`update consignment_stock set remaining_quantity=remaining_quantity-${quantity},updated_by=${actorId},updated_at=now()
          where org_id=${orgId} and id=${held.id} and remaining_quantity>=${quantity} returning id`);
        if (!changed.rows.length)
          throw new InventoryError("Consignment quantity changed");
      }
    }
    const event = (
      await db.execute<{
        id: string;
      }>(sql`insert into consignment_events(org_id,stock_id,kind,quantity,occurred_on,to_stock_id,receipt_movement_id,reason,created_by)
      values(${orgId},${stockId},${input.action},${quantity},${input.date},${toStockId},${receiptMovementId},${reason},${actorId}) returning id`)
    ).rows[0];
    if (!event) throw new InventoryError("Custody event was not recorded");
    const after = (
      await db.execute<CustodyRow>(
        sql`select stock.*,received_on::text as received_on from consignment_stock stock where org_id=${orgId} and id=${stockId}`,
      )
    ).rows[0];
    if (!after)
      throw new InventoryError(
        "Custody position could not be resolved after the operation",
      );
    const audit =
      await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'consignment_stock',${stockId},${input.action === "receive" ? "insert" : "update"},${JSON.stringify({ operation: input.action, reason, before, after, quantity, toStockId, receiptMovementId, eventId: event.id })}::jsonb,${actorId}) returning id`);
    if (!audit.rows.length)
      throw new InventoryError("Custody operation was not audited");
    return { stockId, eventId: event.id, receiptMovementId, toStockId };
  });
}
