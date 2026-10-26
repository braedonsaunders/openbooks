import { db, type SqlExecutor } from "../platform/db.ts";
import { cmp, fromUnits, toUnits } from "../money/money.ts";
import { persistReceiptMoney, lockInventoryPosition } from "./position.ts";
import { InventoryError } from "./contracts.ts";
import { assertInventoryFeature, resolveProfile } from "./profile-policy.ts";
import { lockSubcontractCustodyAuthority } from "./subcontract-custody.ts";
import { assertOwnedLocation } from "./stock-eligibility.ts";
import { assertNotKitItem } from "./kits.ts";
import { receiveInventory, type MovementResult } from "./movement-receive.ts";
import { issueInventory } from "./movement-issue.ts";
export interface AdjustInput {
  stockCountLineId?: string;
  itemId: string;
  stockLocationId: string;
  /** signed base-unit quantity delta (+ increases stock, − decreases). */
  quantityDelta: string;
  subsidiaryId: string;
  date: string;
  /** Stable identity for the adjustment effect, used when a caller must replay after a later transaction fails. */
  idempotencyKey?: string | null;
  /** unit cost for a positive adjustment; defaults to the on-hand average (or the standard for a standard-cost item) and refuses when neither exists. */
  unitCost?: string;
  lotId?: string | null;
  serialId?: string | null;
  memo?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  /** Set when the adjustment books a stock count's variance. */
  admission?: "count";
  /** Join a document correction's transaction so stock and source counters commit together. */
  tx?: SqlExecutor;
  /** Source document line for governed document corrections. */
  documentLineId?: string | null;
}

/**
 * Adjust on-hand quantity against the item's adjustment account. A positive
 * delta receives at `unitCost` (else the average prevailing under the position
 * lock); a negative delta issues at current cost. Used by stock counts and
 * manual write-ups/downs.
 */
export async function adjustInventory(
  orgId: string,
  actorId: string | null,
  input: AdjustInput,
): Promise<MovementResult> {
  // Deltas are signed, so the range gate runs before the sign is read: junk
  // must name InventoryError (not the bare Error cmp throws) and oversized
  // figures must refuse before delegation or any journal math.
  const quantityDelta = persistReceiptMoney(input.quantityDelta, "adjustment quantity");
  const sign = cmp(quantityDelta, "0");
  if (sign === 0) throw new InventoryError("adjustment quantity cannot be zero");
  // Keep the adjustment-account lookup in the same lock boundary as the
  // delegated movement. Lock the position first to preserve the canonical
  // position → profile ordering used by receive/issue and avoid deadlocks.
  const apply = async (tx: SqlExecutor): Promise<MovementResult> => {
    // Canonical lock order: fence the position before any row lock, or a
    // peer holding the fence deadlocks against this transaction at posting.
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    await assertInventoryFeature(tx, orgId);
    await lockSubcontractCustodyAuthority(
      tx,
      orgId,
      actorId,
      input.subsidiaryId,
      input.stockLocationId,
    );
    const profile = await resolveProfile(orgId, input.itemId, tx, true);
    await assertOwnedLocation(tx, orgId, input.stockLocationId);
    // Positive deltas inherit this refusal from receiveInventory; negative
    // ones would otherwise die as a confusing shortfall on stock that can
    // never exist. Refuse either sign up front, by name.
    await assertNotKitItem(tx, orgId, input.itemId, "adjust");
    const offset = profile.adjustmentAccountId ?? profile.cogsAccountId;
    if (sign > 0) {
      return receiveInventory(orgId, actorId, {
        itemId: input.itemId,
        stockLocationId: input.stockLocationId,
        quantity: input.quantityDelta,
        unitCost: input.unitCost,
        subsidiaryId: input.subsidiaryId,
        offsetAccountId: offset,
        date: input.date,
        idempotencyKey: input.idempotencyKey,
        serialId: input.serialId,
        lotId: input.lotId,
        memo: input.memo ?? "Inventory adjustment",
        departmentId: input.departmentId,
        projectId: input.projectId,
        locationId: input.locationId,
        admission: input.admission,
        stockCountLineId: input.stockCountLineId,
        documentLineId: input.documentLineId,
        tx,
      });
    }
    // negative: issue the absolute quantity against the adjustment account.
    const absQty = fromUnits(-toUnits(input.quantityDelta));
    return issueInventory(orgId, actorId, {
      itemId: input.itemId,
      stockLocationId: input.stockLocationId,
      quantity: absQty,
      subsidiaryId: input.subsidiaryId,
      offsetAccountId: offset,
      date: input.date,
      idempotencyKey: input.idempotencyKey,
      serialId: input.serialId,
      lotId: input.lotId,
      memo: input.memo ?? "Inventory adjustment",
      departmentId: input.departmentId,
      projectId: input.projectId,
      locationId: input.locationId,
      admission: input.admission,
      stockCountLineId: input.stockCountLineId,
      documentLineId: input.documentLineId,
      tx,
    });
  };
  return input.tx ? apply(input.tx) : db.transaction(apply);
}
