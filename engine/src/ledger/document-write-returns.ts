import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { assertReturnSourceSelectable, type ReturnSide } from "../inventory/returnable-sources.ts";
import { InventoryError } from "../inventory/contracts.ts";
import { cmp } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import type { DocumentLineInput } from "./document-input.ts";

/** Credit kinds that may return stock, and which leg each one returns. */
const RETURN_SIDE_BY_KIND: Record<string, ReturnSide> = {
  vendor_credit: "purchase",
  customer_credit: "sales",
  cash_refund: "sales",
};

/**
 * Turn the operator's chosen return source into trusted `custom.inventoryReturn`
 * evidence, inside the write transaction that already holds the document lock.
 *
 * The caller names a movement; the server decides whether that movement is
 * returnable and writes the bag. `assertReturnSourceSelectable` reads the same
 * query the picker lists from, so the editor cannot offer a source the save
 * refuses, and cannot save one the picker never offered.
 *
 * Tri-state per line: absent preserves what reattachment restored, null clears
 * the return, an object replaces it.
 */
export async function applyInventoryReturnSelections(
  tx: SqlExecutor,
  orgId: string,
  kind: string,
  partyId: string | null,
  subsidiaryId: string | null,
  submitted: DocumentLineInput[],
  preparedLines: {
    itemId: string | null;
    stockLocationId: string | null;
    custom: Record<string, unknown>;
  }[],
): Promise<void> {
  if (submitted.length !== preparedLines.length) return;
  const touched = submitted.some((line) => line.inventoryReturnSource !== undefined);
  if (!touched) return;
  const side = RETURN_SIDE_BY_KIND[kind];
  if (!side) {
    const at = submitted.findIndex((line) => line.inventoryReturnSource !== undefined) + 1;
    throw new DocumentEditError(
      422,
      `Line ${at}: only a vendor credit, a customer credit or a cash refund can return stock — ` +
        `a ${kind} has no shipment or receipt to return against; nothing was changed`,
    );
  }
  for (let i = 0; i < submitted.length; i++) {
    const selection = submitted[i]!.inventoryReturnSource;
    if (selection === undefined) continue;
    const prepared = preparedLines[i]!;
    if (selection === null) {
      // Clearing is explicit: drop the bag rather than leaving a return the
      // operator removed from the line they are looking at.
      const { inventoryReturn: _cleared, ...rest } = prepared.custom;
      prepared.custom = rest;
      continue;
    }
    // A walk-in cash refund names no customer and returns a walk-in cash
    // sale's goods; every other return names the party that received them.
    if (!partyId && kind !== "cash_refund") {
      throw new DocumentEditError(
        422,
        `Line ${i + 1}: select the ${side === "purchase" ? "vendor" : "customer"} before choosing what this credit returns; nothing was changed`,
      );
    }
    if (!prepared.itemId || !prepared.stockLocationId) {
      throw new DocumentEditError(
        422,
        `Line ${i + 1}: a returned line needs both an item and a warehouse before its ` +
          `${side === "purchase" ? "receipt" : "shipment"} can be selected; nothing was changed`,
      );
    }
    // The validator scopes to the credit's own legal entity — the same scope
    // the picker lists and the posting guard enforces — so a source saved
    // from another entity is refused here, at save, instead of at posting.
    // The party guard above already threw when the credit names no party,
    // so a missing subsidiary here names the subsidiary remedy, not the party.
    const creditSubsidiaryId = subsidiaryId;
    if (!creditSubsidiaryId) {
      throw new DocumentEditError(
        422,
        `Line ${i + 1}: choose the credit's subsidiary before choosing what this credit returns; nothing was changed`,
      );
    }
    try {
      await assertReturnSourceSelectable(
        tx,
        orgId,
        {
          side,
          partyId: partyId ?? null,
          itemId: prepared.itemId,
          stockLocationId: selection.sourceStockLocationId ?? prepared.stockLocationId,
          movementId: selection.movementId,
          subsidiaryIds: [creditSubsidiaryId],
          lotId: selection.lotId ?? null,
          serialId: selection.serialId ?? null,
        },
        `Line ${i + 1}`,
      );
    } catch (error) {
      if (error instanceof InventoryError)
        throw new DocumentEditError(422, `${error.message}; nothing was changed`);
      throw error;
    }
    // A stored no-goods-returned choice is replaced, not stacked: the line
    // returns goods again, so the allowance flag must go with the old state.
    const { inventoryAllowance: _replaced, ...withoutAllowance } = prepared.custom;
    prepared.custom = {
      ...withoutAllowance,
      inventoryReturn: {
        [side === "purchase" ? "sourceReceiptMovementId" : "sourceIssueMovementId"]:
          selection.movementId,
        ...(selection.lotId ? { lotId: selection.lotId } : {}),
        ...(selection.serialId ? { serialId: selection.serialId } : {}),
      },
    };
  }
}

/**
 * Turn the operator's explicit no-goods-returned choice into the trusted
 * `custom.inventoryAllowance` flag, beside the return-source writer above.
 *
 * Tri-state per line: absent preserves what reattachment restored, null or
 * false clears the choice, true records it. A line naming both a return
 * source and an allowance on the same save is refused — it cannot both move
 * stock and move nothing.
 */
export function applyInventoryAllowanceSelections(
  kind: string,
  submitted: DocumentLineInput[],
  preparedLines: { custom: Record<string, unknown> }[],
): void {
  if (submitted.length !== preparedLines.length) return;
  if (!submitted.some((line) => line.inventoryAllowance !== undefined)) return;
  const side = RETURN_SIDE_BY_KIND[kind];
  if (!side) {
    const at = submitted.findIndex((line) => line.inventoryAllowance !== undefined) + 1;
    throw new DocumentEditError(
      422,
      `Line ${at}: only a vendor credit or a customer credit can carry a no-goods-returned choice — ` +
        `a ${kind} has no stock movement to decline; nothing was changed`,
    );
  }
  for (let i = 0; i < submitted.length; i++) {
    const allowance = submitted[i]!.inventoryAllowance;
    if (allowance === undefined) continue;
    const prepared = preparedLines[i]!;
    if (allowance === true) {
      if (
        submitted[i]!.inventoryReturnSource !== undefined &&
        submitted[i]!.inventoryReturnSource !== null
      ) {
        throw new DocumentEditError(
          422,
          `Line ${i + 1}: choose either the ${side === "purchase" ? "receipt the goods are returned from" : "shipment the goods are returned from"} or no goods returned — a line cannot be both; nothing was changed`,
        );
      }
      // A stored return cleared on an earlier line of this same save reads
      // cleared here too: the allowance replaces it rather than stacking.
      const { inventoryReturn: _replaced, ...rest } = prepared.custom;
      prepared.custom = { ...rest, inventoryAllowance: true };
      continue;
    }
    const { inventoryAllowance: _cleared, ...rest } = prepared.custom;
    prepared.custom = rest;
  }
}

/**
 * Save-time stock disposition for vendor-credit lines. Posting requires every
 * stocked line to either return goods or be an allowance, so the save refuses
 * a missing choice with the operator message instead of failing late at post.
 * Zero-quantity lines move nothing at posting and stay exempt, matching the
 * posting loader that skips them.
 */
export async function assertVendorCreditReturnDispositions(
  tx: SqlExecutor,
  orgId: string,
  preparedLines: {
    itemId: string | null;
    quantity: string | null;
    custom: Record<string, unknown>;
  }[],
): Promise<void> {
  const stockedIds = [
    ...new Set(
      preparedLines
        .map((line) => line.itemId)
        .filter((id): id is string => typeof id === "string" && isUuid(id)),
    ),
  ];
  if (stockedIds.length === 0) return;
  const stocked = new Set(
    (
      await tx.execute<{ id: string }>(
        sql`
      select p.item_id as id from item_inventory_profiles p
       where p.org_id = ${orgId} and p.item_id in (${sql.join(
         stockedIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`,
        "objects",
      )
    ).map((row) => row.id),
  );
  if (stocked.size === 0) return;
  const labels = new Map(
    (
      await tx.execute<{ id: string; label: string }>(
        sql`
      select item.id, coalesce(nullif(btrim(item.code), ''), item.name) as label
        from items item
       where item.org_id = ${orgId}
         and item.id in (${sql.join(
           [...stocked].map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`,
        "objects",
      )
    ).map((row) => [row.id, row.label] as const),
  );
  for (let i = 0; i < preparedLines.length; i++) {
    const line = preparedLines[i]!;
    if (!line.itemId || !stocked.has(line.itemId)) continue;
    if (
      line.quantity === null ||
      line.quantity === undefined ||
      String(line.quantity).trim() === ""
    )
      continue;
    try {
      if (cmp(String(line.quantity), "0") === 0) continue;
    } catch {
      continue;
    }
    const custom = line.custom ?? {};
    const hasReturn = typeof custom.inventoryReturn === "object" && custom.inventoryReturn !== null;
    const hasAllowance = custom.inventoryAllowance === true;
    const label = `Line ${i + 1} (${labels.get(line.itemId) ?? line.itemId})`;
    if (hasReturn && hasAllowance) {
      throw new DocumentEditError(
        422,
        `${label} cannot both return goods and be an allowance — ` +
          `keep the receipt the goods are returned from, or keep the allowance (no goods returned), not both; nothing was changed`,
      );
    }
    if (!hasReturn && !hasAllowance) {
      throw new DocumentEditError(
        422,
        `${label} is a stocked item: choose the receipt the goods are returned from, ` +
          `or post the credit as an allowance (no goods returned); nothing was changed`,
      );
    }
  }
}
