import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { add } from "../money/money.ts";
import { postedReturnQuantity } from "./return-quantities.ts";
import { InventoryError } from "./contracts.ts";
import {
  type ReceiptVoidDependent,
  type ReceiptVoidBlocker,
  type ReceiptVoidRelief,
  liveReceiptMovements,
  layerCover,
  type ConsumptionRow,
  liveConsumptions,
  reversibleDependent,
} from "./receipt-void-state.ts";

/**
 * What blocks a goods-receipt void, named for the operator. A receipt
 * cannot void while its stock is consumed downstream — and the historic
 * refusal named only the kernel reason. This module lists every live
 * dependent (the issue or transfer that consumed the stock, with its
 * source document and the native path that reverses it), judges whether a
 * void-with-dependents cascade is safe to offer, and corrects a phantom
 * over-receipt's unconsumed remainder through a native inventory
 * adjustment with audit. Posted history stays immutable throughout:
 * every path appends reversals or adjustments, never edits.
 */

/**
 * Every live blocker on a goods receipt's void: consumed cover per
 * movement with each dependent's source document and native reverse
 * path, plus landed-cost, provisional-chain, and custody blocks. Read
 * only: the void refusal renders this, and the cascade below acts on it.
 */
export async function listReceiptVoidBlockers(
  runner: SqlExecutor,
  orgId: string,
  receiptId: string,
): Promise<ReceiptVoidRelief> {
  const header = (
    await runner.execute<{ document_number: string }>(
      sql`
    select document_number from documents
     where id = ${receiptId} and org_id = ${orgId} and kind = 'purchase_receipt'`,
      "objects",
    )
  )[0];
  if (!header) throw new InventoryError("goods receipt not found");
  const movements = await liveReceiptMovements(runner, orgId, receiptId);
  const movementIds = movements.map((movement) => movement.id);
  const { cover } = await layerCover(runner, orgId, movementIds);
  const consumptions = await liveConsumptions(runner, orgId, movementIds);
  const byMovement = new Map<string, ConsumptionRow[]>();
  const layerOwner = new Map<string, string>();
  if (movementIds.length > 0) {
    const idArr = `{${movementIds.join(",")}}`;
    const owners = await runner.execute<{ id: string; source_movement_id: string }>(
      sql`
      select id, source_movement_id from cost_layers
       where org_id = ${orgId} and source_movement_id = any(${idArr}::uuid[])`,
      "objects",
    );
    for (const owner of owners) layerOwner.set(owner.id, owner.source_movement_id);
  }
  for (const row of consumptions) {
    const owner = layerOwner.get(row.cost_layer_id);
    if (!owner) continue;
    const list = byMovement.get(owner) ?? [];
    list.push(row);
    byMovement.set(owner, list);
  }
  const layerIds = [...layerOwner.keys()];
  const landed = new Map<string, number>();
  if (layerIds.length > 0) {
    const rows = await runner.execute<{ target_cost_layer_id: string; n: number }>(
      sql`
      select allocation.target_cost_layer_id, count(*)::int as n
        from landed_cost_allocations allocation
       where allocation.org_id = ${orgId}
         and allocation.target_cost_layer_id = any(${`{${layerIds.join(",")}}`}::uuid[])
         and allocation.reverses_allocation_id is null
         and not exists (
           select 1 from landed_cost_allocations reversal
            where reversal.org_id = allocation.org_id
              and reversal.reverses_allocation_id = allocation.id
         )
       group by allocation.target_cost_layer_id`,
      "objects",
    );
    for (const row of rows) {
      const owner = layerOwner.get(row.target_cost_layer_id);
      if (owner) landed.set(owner, (landed.get(owner) ?? 0) + row.n);
    }
  }
  const settled = new Set(
    movementIds.length > 0
      ? (
          await runner.execute<{ receipt_movement_id: string }>(
            sql`
        select receipt_movement_id from inventory_provisional_settlements
         where org_id = ${orgId} and receipt_movement_id = any(${`{${movementIds.join(",")}}`}::uuid[])`,
            "objects",
          )
        ).map((row) => row.receipt_movement_id)
      : [],
  );
  const custody = new Set(
    movementIds.length > 0
      ? (
          await runner.execute<{ receipt_movement_id: string }>(
            sql`
        select receipt_movement_id from consignment_events
         where org_id = ${orgId} and receipt_movement_id = any(${`{${movementIds.join(",")}}`}::uuid[]) limit 500`,
            "objects",
          )
        ).map((row) => row.receipt_movement_id)
      : [],
  );
  const blockers: ReceiptVoidBlocker[] = [];
  for (const movement of movements) {
    const movementCover = cover.get(movement.id) ?? { consumed: "0", remainder: movement.received };
    const dependents: ReceiptVoidDependent[] = [];
    for (const row of byMovement.get(movement.id) ?? []) {
      const returned = await postedReturnQuantity(runner, orgId, {
        returnKind: "receipt",
        evidenceKey: "sourceIssueMovementId",
        sourceMovementId: row.issue_movement_id,
      });
      const assessed = reversibleDependent(row, row.consumed_quantity);
      dependents.push({
        issueMovementId: row.issue_movement_id,
        issueKind: row.issue_kind,
        consumedQuantity: row.consumed_quantity,
        issueDate: row.issue_date,
        returnedQuantity: returned,
        sourceDocument: assessed.sourceDocument,
        reversible: assessed.reversible,
        reverseAction: assessed.reverseAction,
      });
    }
    const otherBlocks: string[] = [];
    if ((landed.get(movement.id) ?? 0) > 0) {
      otherBlocks.push(
        "this movement has downstream landed-cost allocations; reverse them before the inventory movement",
      );
    }
    if (settled.has(movement.id)) {
      otherBlocks.push(
        "a receipt that settled negative stock must be reversed through its full provisional-cost chain",
      );
    }
    if (custody.has(movement.id)) {
      otherBlocks.push(
        "Ownership acquisition has custody evidence — use an adjusting inventory transaction; its external custody cannot be silently restored by reversal",
      );
    }
    if (dependents.length === 0 && otherBlocks.length === 0) continue;
    blockers.push({
      movementId: movement.id,
      itemId: movement.item_id,
      itemCode: movement.item_code,
      itemName: movement.item_name,
      receivedQuantity: movement.received,
      consumedQuantity: movementCover.consumed,
      remainderQuantity: movementCover.remainder,
      dependents,
      otherBlocks,
    });
  }
  let remainderQuantity = "0";
  for (const blocker of blockers)
    remainderQuantity = add(remainderQuantity, blocker.remainderQuantity);
  const allowVoidWithDependents =
    blockers.length > 0 &&
    blockers.every(
      (blocker) =>
        blocker.otherBlocks.length === 0 &&
        blocker.dependents.length > 0 &&
        blocker.dependents.every((dependent) => dependent.reversible),
    );
  return {
    receiptId,
    receiptNumber: header.document_number,
    blockers,
    allowVoidWithDependents,
    remainderQuantity,
  };
}

export type {
  ReceiptDependentDocument,
  ReceiptVoidDependent,
  ReceiptVoidBlocker,
  ReceiptVoidRelief,
} from "./receipt-void-state.ts";
export {
  correctReceiptRemainder,
  type CorrectReceiptRemainderInput,
  type CorrectReceiptRemainderResult,
} from "./receipt-remainder-correction.ts";
export {
  correctReceiptQuantity,
  type CorrectReceiptQuantityInput,
  type CorrectReceiptQuantityLineInput,
  type CorrectReceiptQuantityResult,
} from "./receipt-quantity-correction.ts";
