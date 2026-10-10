import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import { resolveProfile } from "./profile-policy.ts";
import {
  getOnHandWith,
  lockInventoryPosition,
  persistReceiptMoney,
} from "./position.ts";
import { toExactStockQuantity } from "./costing.ts";
import { cmp } from "../money/money.ts";
import { resolvePutawayLocation, putAwayStagedStock } from "./putaway.ts";
import { recordCountedQuantity } from "./stock-counts.ts";
import { recordSecondCount } from "./second-count.ts";
import {
  admitExecution,
  createExecutionSuggestion,
  type ExecutionTask,
} from "./directed-execution.ts";

export async function suggestReceiptConfirmation(
  orgId: string,
  actorId: string,
  input: { lineId: string; commandKey: string },
) {
  return withOrgTransaction(orgId, async () => {
    const line = (
      await db.execute<{
        id: string;
        item_id: string;
        stock_location_id: string;
        quantity: string;
        unit: string | null;
        subsidiary_id: string;
        posting_date: string;
        lot_id: string | null;
        serial_id: string | null;
        movement_id: string;
      }>(sql`
      select line.id,line.item_id,line.stock_location_id,line.quantity::text,line.unit,receipt.subsidiary_id,
        receipt.document_date::text as posting_date,movement.lot_id,movement.serial_id,movement.id as movement_id
      from document_lines line join documents receipt on receipt.org_id=line.org_id and receipt.id=line.document_id
      join inventory_movements movement on movement.org_id=line.org_id and movement.document_line_id=line.id
        and movement.kind='receipt' and movement.status='posted'
      where line.org_id=${orgId} and line.id=${input.lineId} and receipt.kind='purchase_receipt' and receipt.status='approved'`)
    ).rows[0];
    if (!line)
      throw new InventoryError(
        "Select an approved purchase receipt line with posted stock evidence",
      );
    await admitExecution(db, orgId, actorId, "receive", line.subsidiary_id);
    const profile = await resolveProfile(orgId, line.item_id, db);
    return createExecutionSuggestion(db, orgId, actorId, {
      stage: "receive",
      subsidiaryId: line.subsidiary_id,
      itemId: line.item_id,
      documentLineId: line.id,
      fromStockLocationId: line.stock_location_id,
      toStockLocationId: line.stock_location_id,
      quantity: toExactStockQuantity(
        line.quantity,
        line.unit,
        profile.unitConversions ?? {},
        profile.baseUnit,
      ),
      documentQuantity: line.quantity,
      documentUnit: line.unit,
      lotId: line.lot_id,
      serialId: line.serial_id,
      postingDate: line.posting_date,
      basis: { movementId: line.movement_id },
      commandKey: input.commandKey,
    });
  });
}

export async function suggestPutaway(
  orgId: string,
  actorId: string,
  input: {
    warehouseId: string;
    stagingLocationId: string;
    itemId: string;
    subsidiaryId: string;
    quantity: string;
    date: string;
    lotId?: string | null;
    serialId?: string | null;
    commandKey: string;
  },
) {
  return withOrgTransaction(orgId, async () => {
    await lockInventoryPosition(db, input.itemId, input.stagingLocationId);
    await admitExecution(db, orgId, actorId, "putaway", input.subsidiaryId);
    const staging = (
      await db.execute(sql`select id from stock_locations where org_id=${orgId}
      and id=${input.stagingLocationId} and kind='staging' and is_active and stock_location_warehouse(${orgId}::uuid,id)=${input.warehouseId} for share`)
    ).rows[0];
    if (!staging)
      throw new InventoryError(
        "Select an active staging bin in this warehouse",
      );
    const quantity = persistReceiptMoney(input.quantity, "putaway quantity");
    const stock = await getOnHandWith(
      db,
      orgId,
      input.itemId,
      input.stagingLocationId,
      {
        subsidiaryId: input.subsidiaryId,
        lotId: input.lotId,
        serialId: input.serialId,
      },
    );
    if (cmp(quantity, "0") <= 0 || cmp(stock.quantity, quantity) < 0)
      throw new InventoryError(
        "Refresh staged stock; the suggested quantity is no longer available",
      );
    const target = await resolvePutawayLocation(db, orgId, {
      itemId: input.itemId,
      quantity,
      warehouseId: input.warehouseId,
      subsidiaryId: input.subsidiaryId,
    });
    return createExecutionSuggestion(db, orgId, actorId, {
      stage: "putaway",
      subsidiaryId: input.subsidiaryId,
      itemId: input.itemId,
      fromStockLocationId: input.stagingLocationId,
      toStockLocationId: target.stockLocationId,
      quantity,
      documentQuantity: quantity,
      documentUnit: null,
      lotId: input.lotId,
      serialId: input.serialId,
      postingDate: input.date,
      basis: { warehouseId: input.warehouseId, ruleId: target.ruleId },
      commandKey: input.commandKey,
    });
  });
}

export async function suggestCountObservation(
  orgId: string,
  actorId: string,
  input: {
    lineId: string;
    quantity: string;
    observation: "first" | "second";
    reason?: string;
    commandKey: string;
  },
) {
  return withOrgTransaction(orgId, async () => {
    const line = (
      await db.execute<{
        item_id: string;
        stock_location_id: string;
        stock_count_id: string;
        lot_id: string | null;
        serial_id: string | null;
        subsidiary_id: string;
        counted_on: string;
        first_counted_quantity: string | null;
        second_counted_quantity: string | null;
      }>(sql`
      select line.item_id,line.stock_location_id,line.stock_count_id,line.lot_id,line.serial_id,count.subsidiary_id,
        count.counted_on::text,line.first_counted_quantity::text,line.second_counted_quantity::text
      from stock_count_lines line join stock_counts count on count.org_id=line.org_id and count.id=line.stock_count_id
      where line.org_id=${orgId} and line.id=${input.lineId} and count.status='counting'`)
    ).rows[0];
    if (!line)
      throw new InventoryError(
        "Select a line on a stock count that is counting",
      );
    await admitExecution(db, orgId, actorId, "count", line.subsidiary_id);
    // The counter's observation is the suggested quantity; expected book stock never enters scan instructions.
    const quantity = persistReceiptMoney(input.quantity, "count observation");
    if (cmp(quantity, "0") < 0)
      throw new InventoryError("Count quantity cannot be negative");
    return createExecutionSuggestion(db, orgId, actorId, {
      stage: "count",
      subsidiaryId: line.subsidiary_id,
      itemId: line.item_id,
      countLineId: input.lineId,
      fromStockLocationId: line.stock_location_id,
      toStockLocationId: line.stock_location_id,
      quantity,
      documentQuantity: quantity,
      documentUnit: null,
      lotId: line.lot_id,
      serialId: line.serial_id,
      postingDate: line.counted_on,
      basis: {
        countId: line.stock_count_id,
        observation: input.observation,
        reason: input.reason ?? null,
        prior:
          input.observation === "first"
            ? line.first_counted_quantity
            : line.second_counted_quantity,
      },
      commandKey: input.commandKey,
    });
  });
}

export async function executeInventoryDirection(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  task: ExecutionTask,
): Promise<Record<string, unknown>> {
  if (task.stage === "putaway")
    return {
      ...(await putAwayStagedStock(tx, orgId, actorId, {
        warehouseId: String(task.basis.warehouseId),
        stagingLocationId: task.from_stock_location_id,
        itemId: task.item_id,
        subsidiaryId: task.subsidiary_id,
        quantity: task.quantity,
        date: task.posting_date,
        lotId: task.lot_id,
        serialId: task.serial_id,
        executionTaskId: task.id,
        expectedTargetLocationId: task.to_stock_location_id,
      })),
    };
  if (task.stage === "count") {
    const line = (
      await tx.execute<{
        prior: string | null;
        status: string;
      }>(sql`select count.status,
      case when ${task.basis.observation}='second' then line.second_counted_quantity::text else line.first_counted_quantity::text end as prior
      from stock_count_lines line join stock_counts count on count.org_id=line.org_id and count.id=line.stock_count_id
      where line.org_id=${orgId} and line.id=${task.count_line_id} for update of count,line`)
    ).rows[0];
    if (!line || line.status !== "counting" || line.prior !== task.basis.prior)
      throw new InventoryError(
        "Count observation changed; refresh this line before confirming another scan",
      );
    const input = {
      executionTaskId: task.id,
      countId: String(task.basis.countId),
      lineId: task.count_line_id!,
      countedQuantity: task.quantity,
      ...(typeof task.basis.reason === "string"
        ? { reason: task.basis.reason }
        : {}),
    };
    return {
      ...(await (task.basis.observation === "second"
        ? recordSecondCount(orgId, actorId, input)
        : recordCountedQuantity(orgId, actorId, input))),
    };
  }
  if (task.stage === "receive") {
    const evidence = (
      await tx.execute(sql`select movement.id from inventory_movements movement
      join documents receipt on receipt.org_id=movement.org_id and receipt.id=(select document_id from document_lines
        where org_id=${orgId} and id=${task.document_line_id})
      where movement.org_id=${orgId} and movement.id=${task.basis.movementId} and movement.document_line_id=${task.document_line_id}
        and movement.status='posted' and receipt.kind='purchase_receipt' and receipt.status='approved'`)
    ).rows;
    if (evidence.length !== 1)
      throw new InventoryError(
        "Purchase receipt changed; reopen its posted stock evidence before confirming",
      );
    if (
      (
        await tx.execute(sql`select id from warehouse_execution_tasks where org_id=${orgId} and document_line_id=${task.document_line_id}
      and stage='receive' and status='done' and id<>${task.id} limit 1`)
      ).rows[0]
    )
      throw new InventoryError(
        "This purchase receipt was already confirmed; reopen its recorded receiving evidence",
      );
    const stock = await getOnHandWith(
      tx,
      orgId,
      task.item_id,
      task.to_stock_location_id,
      {
        subsidiaryId: task.subsidiary_id,
        lotId: task.lot_id,
        serialId: task.serial_id,
      },
    );
    if (cmp(stock.quantity, task.quantity) < 0)
      throw new InventoryError(
        "Receipt stock has moved; confirm its current location through the stock inquiry",
      );
    return {
      receiptLineId: task.document_line_id,
      movementId: task.basis.movementId,
    };
  }
  throw new InventoryError(
    "This warehouse work requires the fulfillment execution command",
  );
}
