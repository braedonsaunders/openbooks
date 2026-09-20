import { transferInventoryTx } from "./transfers.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, isZero, neg, sum } from "../money/money.ts";
import { businessToday } from "../platform/business-date.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { resolveProfile, assertInventoryFeature } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry, inventoryOffsetAccountProblem, type JournalLineInput } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, persistReceiptMoney, assertInventoryDate } from "./position.ts";
import { nextSequenceNumber } from "./document-numbering.ts";
export interface TransferOrderLineInput {
  itemId: string;
  quantity: string;
  lotId?: string | null;
  serialId?: string | null;
}

export interface CreateTransferOrderInput {
  fromStockLocationId: string;
  toStockLocationId: string;
  subsidiaryId: string;
  orderedOn: string;
  /** GL account holding value while goods are in transit (optional; when set,
   *  ship/receive post value reclasses against each item's asset account). */
  inTransitAccountId?: string | null;
  transitStockLocationId?: string | null;
  memo?: string | null;
  lines: TransferOrderLineInput[];
}
type TransferOrderRow = {
  ordered_on: string;
  shipped_on: string | null;
  id: string;
  status: string;
  from_stock_location_id: string;
  to_stock_location_id: string;
  transit_stock_location_id: string | null;
  in_transit_account_id: string | null;
  ship_journal_entry_id: string | null;
  subsidiary_id: string;
  document_number: string;
};

export async function createTransferOrder(
  orgId: string,
  actorId: string | null,
  input: CreateTransferOrderInput,
): Promise<{ id: string; documentNumber: string }> {
  assertInventoryDate(input.orderedOn, "order date");
  if (input.fromStockLocationId === input.toStockLocationId) {
    throw new InventoryError("transfer order needs two different locations");
  }
  if (!input.lines?.length)
    throw new InventoryError("transfer order needs at least one line");
  for (const line of input.lines) {
    if (cmp(line.quantity, "0") <= 0)
      throw new InventoryError("transfer order line quantity must be positive");
  }
  return await db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const documentNumber = await nextSequenceNumber(orgId, "transfer_order", "TO-", tx);
    const order = (await tx.execute<{ id: string }>(sql`
      insert into transfer_orders
        (org_id, document_number, status, from_stock_location_id, to_stock_location_id,
         transit_stock_location_id, in_transit_account_id, subsidiary_id, ordered_on, memo, created_by, updated_by)
      values (${orgId}, ${documentNumber}, 'draft', ${input.fromStockLocationId}, ${input.toStockLocationId},
              ${input.transitStockLocationId ?? null}, ${input.inTransitAccountId ?? null}, ${input.subsidiaryId},
              ${input.orderedOn}, ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const id = order.rows[0]!.id;
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]!;
      const lineQuantity = persistReceiptMoney(line.quantity, "transfer order line quantity");
      await tx.execute(sql`
        insert into transfer_order_lines
          (org_id, transfer_order_id, line_number, item_id, quantity, lot_id, serial_id, created_by, updated_by)
        values (${orgId}, ${id}, ${i + 1}, ${line.itemId}, ${lineQuantity},
                ${line.lotId ?? null}, ${line.serialId ?? null}, ${actorId}, ${actorId})`);
    }
    return { id, documentNumber };
  });
}

async function loadTransferOrderForUpdate(
  tx: Runner,
  orgId: string,
  orderId: string,
): Promise<TransferOrderRow> {
  const r = (await tx.execute<TransferOrderRow>(sql`
    select id, status, from_stock_location_id, to_stock_location_id, transit_stock_location_id,
           in_transit_account_id, ship_journal_entry_id, subsidiary_id, document_number, ordered_on, shipped_on
      from transfer_orders where org_id = ${orgId} and id = ${orderId} for update`));
  if (!r.rows[0]) throw new InventoryError("transfer order not found");
  return r.rows[0];
}

async function resolveTransitLocation(
  tx: Runner,
  orgId: string,
  order: TransferOrderRow,
): Promise<string> {
  if (order.transit_stock_location_id) return order.transit_stock_location_id;
  if (order.status === "in_transit") {
    // Older shipments did not retain the resolved default. Recover their
    // actual destination from immutable paired movements, never today's default.
    const result = (await tx.execute<{
      line_count: number; linked_count: number; locations: number; id: string | null;
    }>(sql`
      select count(*)::int as line_count, count(m.id)::int as linked_count,
             count(distinct m.stock_location_id)::int as locations,
             min(m.stock_location_id::text) as id
        from transfer_order_lines l
        left join inventory_movements m on m.paired_movement_id=l.ship_movement_id
          and m.org_id=l.org_id and m.kind='transfer_in' and m.status='posted'
       where l.org_id=${orgId} and l.transfer_order_id=${order.id}
    `)).rows[0];
    if (!result?.id || result.line_count === 0 || result.linked_count !== result.line_count || result.locations !== 1) {
      throw new InventoryError("transfer shipment evidence does not identify a single transit location");
    }
    return result.id;
  }
  const r = (await tx.execute<{ id: string }>(sql`
    select id from stock_locations where org_id = ${orgId} and kind = 'transit' and is_active
     order by created_at limit 1`));
  if (!r.rows[0]) {
    throw new InventoryError(
      `transfer order ${order.document_number} has no transit stock location and none exists`,
    );
  }
  return r.rows[0].id;
}

/** Post the in-transit value reclass for a ship/receive leg, when the order
 *  carries an in-transit GL account. `direction` = 'ship' moves value into the
 *  in-transit account, 'receive' moves it back out. */
async function postInTransitReclass(
  tx: Runner,
  p: {
    orgId: string;
    order: TransferOrderRow;
    actorId: string | null;
    date: string;
    direction: "ship" | "receive";
    amounts: { assetAccountId: string; value: string; memo: string }[];
  },
): Promise<string | null> {
  if (!p.order.in_transit_account_id) return null;
  const amounts = p.amounts.filter((a) => !isZero(a.value));
  if (amounts.length === 0) return null;
  const total = sum(amounts.map((a) => a.value));
  const periodId = await periodForDate(p.orgId, p.date, tx);
  if (!periodId) throw new InventoryError(`no accounting period for ${p.date}`);
  const shipmentBook = p.direction === "receive" ? await transferShipmentBook(tx, p.orgId, p.order) : null;
  const bookId = shipmentBook ?? await primaryBookId(p.orgId, tx);
  const currency = await subsidiaryCurrency(
    p.orgId,
    p.order.subsidiary_id,
    tx,
  );
  const inTransit = p.order.in_transit_account_id;
  for (const amount of amounts) {
    const accountProblem = inventoryOffsetAccountProblem(amount.assetAccountId, inTransit, "in-transit");
    if (accountProblem) throw new InventoryError(accountProblem);
  }
  // Asset legs stay at the endpoint stock location's business location so the
  // location's inventory GL keeps tying to its layers; the in-transit legs
  // share the transit location on both directions so they net to zero there.
  const endpointDim =
    p.direction === "ship"
      ? await stockLocationDim(tx, p.orgId, p.order.from_stock_location_id, null)
      : await stockLocationDim(tx, p.orgId, p.order.to_stock_location_id, null);
  // Orders without any transit stock location keep the endpoint attribution
  // rather than failing: resolveTransitLocation refuses those outright.
  let transitDim: string | null = null;
  try {
    transitDim = await stockLocationDim(tx, p.orgId, await resolveTransitLocation(tx, p.orgId, p.order), null);
  } catch {
    transitDim = null;
  }
  transitDim ??= endpointDim;
  const lines: JournalLineInput[] =
    p.direction === "ship"
      ? [
          { accountId: inTransit, amount: total, locationId: transitDim, memo: "Goods in transit" },
          ...amounts.map((a) => ({
            accountId: a.assetAccountId,
            amount: neg(a.value),
            locationId: endpointDim,
            memo: a.memo,
          })),
        ]
      : [
          ...amounts.map((a) => ({
            accountId: a.assetAccountId,
            amount: a.value,
            locationId: endpointDim,
            memo: a.memo,
          })),
          {
            accountId: inTransit,
            amount: neg(total),
            locationId: transitDim,
            memo: "Goods received from transit",
          },
        ];
  return postInventoryEntry(tx, {
    orgId: p.orgId,
    bookId,
    subsidiaryId: p.order.subsidiary_id,
    actorId: p.actorId,
    currency,
    periodId,
    date: p.date,
    entryNumber: `INV-XFER-${p.direction.toUpperCase()}-${p.order.document_number}`,
    memo: `Transfer ${p.order.document_number} ${p.direction === "ship" ? "shipped" : "received"}`,
    lines,
  });
}

/** Receipt clears its immutable shipment's book, even after a primary-book change. */
async function transferShipmentBook(tx: Runner, orgId: string, order: TransferOrderRow): Promise<string | null> {
  if (!order.ship_journal_entry_id) return null;
  const source = (await tx.execute<{ book_id: string; currency: string }>(sql`
    select j.book_id, min(l.currency) as currency from journal_entries j
    join journal_lines l on l.org_id=j.org_id and l.entry_id=j.id
    where j.org_id=${orgId} and j.id=${order.ship_journal_entry_id}
      and j.subsidiary_id=${order.subsidiary_id} and j.status='posted' and j.origin='inventory'
    group by j.book_id having count(distinct l.currency)=1`)).rows[0];
  if (!source || source.currency !== await subsidiaryCurrency(orgId, order.subsidiary_id, tx)) {
    throw new InventoryError("transfer shipment journal or functional currency is inconsistent");
  }
  return source.book_id;
}

/**
 * Ship a draft transfer order: every line's full quantity moves source →
 * transit location at carried cost (subledger), and — when the order names an
 * in-transit account — value reclasses into it. One-shot by design; partial
 * shipments ride additional transfer orders.
 */
export async function shipTransferOrder(
  orgId: string,
  actorId: string | null,
  orderId: string,
  date?: string,
): Promise<{ id: string; status: string; entryId: string | null }> {
  const shipDate = date ?? await businessToday(orgId);
  assertInventoryDate(shipDate, "ship date");
  return await db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const order = await loadTransferOrderForUpdate(tx, orgId, orderId);
    if (order.status !== "draft")
      throw new InventoryError(
        `transfer order ${order.document_number} is ${order.status}`,
      );
    if (shipDate < order.ordered_on) throw new InventoryError("ship date cannot precede order date");
    const transitId = await resolveTransitLocation(tx, orgId, order);
    const transit = (await tx.execute(sql`select id from stock_locations
      where org_id=${orgId} and id=${transitId} and kind='transit' and is_active for share`)).rows[0];
    if (!transit) throw new InventoryError("transfer orders require an active transit stock location");
    const lines = (await tx.execute<{
        id: string;
        item_id: string;
        quantity: string;
        lot_id: string | null;
        serial_id: string | null;
      }>(sql`
      select id, item_id, quantity, lot_id, serial_id from transfer_order_lines
       where org_id = ${orgId} and transfer_order_id = ${orderId} order by line_number for update`));
    const amounts: { assetAccountId: string; value: string; memo: string }[] =
      [];
    for (const line of lines.rows) {
      const profile = await resolveProfile(orgId, line.item_id, tx, true);
      const moved = await transferInventoryTx(tx, orgId, actorId, {
        itemId: line.item_id,
        fromStockLocationId: order.from_stock_location_id,
        toStockLocationId: transitId,
        quantity: line.quantity,
        lotId: line.lot_id,
        serialId: line.serial_id,
        subsidiaryId: order.subsidiary_id,
        date: shipDate,
        memo: `Transfer ${order.document_number} shipped`,
      });
      await tx.execute(sql`
        update transfer_order_lines
           set quantity_shipped = ${line.quantity}, ship_movement_id = ${moved.fromMovementId}, updated_at = now(), updated_by = ${actorId}
         where id = ${line.id} and org_id = ${orgId}`);
      amounts.push({
        assetAccountId: profile.assetAccountId,
        value: moved.value,
        memo: `Transfer ${order.document_number}`,
      });
    }
    const entryId = await postInTransitReclass(tx, {
      orgId,
      order,
      actorId,
      date: shipDate,
      direction: "ship",
      amounts,
    });
    await tx.execute(sql`
      update transfer_orders
         set status = 'in_transit', transit_stock_location_id = ${transitId}, shipped_on = ${shipDate}, ship_journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${orderId} and org_id = ${orgId}`);
    return { id: orderId, status: "in_transit", entryId };
  });
}

/** Receive an in-transit transfer order at its destination location. */
export async function receiveTransferOrder(
  orgId: string,
  actorId: string | null,
  orderId: string,
  date?: string,
): Promise<{ id: string; status: string; entryId: string | null }> {
  const receiveDate = date ?? await businessToday(orgId);
  assertInventoryDate(receiveDate, "receive date");
  return await db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const order = await loadTransferOrderForUpdate(tx, orgId, orderId);
    if (order.status !== "in_transit")
      throw new InventoryError(
        `transfer order ${order.document_number} is ${order.status}`,
      );
    if (!order.shipped_on || receiveDate < order.shipped_on) {
      throw new InventoryError("receive date cannot precede shipment");
    }
    const transitId = await resolveTransitLocation(tx, orgId, order);
    const postingBookId = await transferShipmentBook(tx, orgId, order);
    const lines = (await tx.execute<{
        id: string;
        item_id: string;
        quantity_shipped: string;
        ship_movement_id: string | null;
        lot_id: string | null;
        serial_id: string | null;
      }>(sql`
      select id, item_id, quantity_shipped, ship_movement_id, lot_id, serial_id from transfer_order_lines
       where org_id = ${orgId} and transfer_order_id = ${orderId} order by line_number for update`));
    const amounts: { assetAccountId: string; value: string; memo: string }[] =
      [];
    for (const line of lines.rows) {
      if (isZero(line.quantity_shipped)) continue;
      const profile = await resolveProfile(orgId, line.item_id, tx, true);
      const shipment = (await tx.execute<{ id: string; total_value: string }>(sql`
        select inbound.id, inbound.total_value from inventory_movements inbound
        join inventory_movements outbound on outbound.id=inbound.paired_movement_id and outbound.org_id=inbound.org_id
        where inbound.org_id=${orgId} and outbound.id=${line.ship_movement_id}
          and inbound.kind='transfer_in' and outbound.kind='transfer_out'
          and inbound.status='posted' and outbound.status='posted'
          and inbound.subsidiary_id=${order.subsidiary_id} and outbound.subsidiary_id=${order.subsidiary_id}
          and inbound.item_id=${line.item_id} and outbound.item_id=${line.item_id}
          and inbound.stock_location_id=${transitId} and outbound.stock_location_id=${order.from_stock_location_id}
          and inbound.quantity=${line.quantity_shipped} and outbound.quantity=-inbound.quantity
          and inbound.total_value=-outbound.total_value
          and inbound.lot_id is not distinct from ${line.lot_id}::uuid
          and inbound.serial_id is not distinct from ${line.serial_id}::uuid
          and not exists(select 1 from inventory_movements reversal where reversal.org_id=${orgId}
            and reversal.reverses_movement_id in (inbound.id,outbound.id))`)).rows;
      if (shipment.length !== 1) throw new InventoryError("transfer line has no intact shipment evidence");
      const moved = await transferInventoryTx(tx, orgId, actorId, {
        itemId: line.item_id,
        fromStockLocationId: transitId,
        toStockLocationId: order.to_stock_location_id,
        quantity: line.quantity_shipped,
        lotId: line.lot_id,
        serialId: line.serial_id,
        subsidiaryId: order.subsidiary_id,
        date: receiveDate,
        sourceReceiptMovementId: shipment[0]!.id,
        expectedSourceValue: shipment[0]!.total_value,
        postingBookId: postingBookId ?? undefined,
        memo: `Transfer ${order.document_number} received`,
      });
      await tx.execute(sql`
        update transfer_order_lines
           set quantity_received = ${line.quantity_shipped}, receive_movement_id = ${moved.toMovementId}, updated_at = now(), updated_by = ${actorId}
         where id = ${line.id} and org_id = ${orgId}`);
      amounts.push({
        assetAccountId: profile.assetAccountId,
        value: moved.value,
        memo: `Transfer ${order.document_number}`,
      });
    }
    const entryId = await postInTransitReclass(tx, {
      orgId,
      order,
      actorId,
      date: receiveDate,
      direction: "receive",
      amounts,
    });
    await tx.execute(sql`
      update transfer_orders
         set status = 'received', transit_stock_location_id = ${transitId}, received_on = ${receiveDate}, receive_journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${orderId} and org_id = ${orgId}`);
    return { id: orderId, status: "received", entryId };
  });
}
