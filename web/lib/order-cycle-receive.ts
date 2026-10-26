import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { add } from "@openbooks/engine/money/money";
import { nextDocumentNumber } from "./bills.ts";
import { PURCHASE_RECEIPT_KIND } from "./order-kinds";
import { lineRequiresReceipt } from "@openbooks/engine/records/stock-receipt";
import {
  openQuantitySql,
  orderedNetOfCancelledSql,
} from "@openbooks/engine/records/order-line-remainders";
import { fromQuantityUnits, orderLineAmount, toQuantityUnits } from "./order-cycle-math";
import { overReceiptAllowanceUnits, resolveOverReceiptTolerance } from "./purchase-over-receipt";
import { isFeatureEnabled } from "./features";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { applyPurchaseReceiptInventory } from "@openbooks/engine/inventory/documents-purchasing";
import { linkedBillReceivedCover } from "@openbooks/engine/inventory/bill-matchable-lines";
import {
  receivedNotBilledMissingMessage,
  resolveReceivedNotBilledAccount,
} from "@openbooks/engine/records/control-accounts";
import { activeStockLocations } from "./stock-locations";
import {
  type CanonicalFulfillmentLine,
  ConversionError,
  type ConvertResult,
  ITEM_MISSING_RNB_ACCOUNT,
  ORDER_LINE_WAREHOUSE_REQUIRED,
  type OrderCycleTx,
  type SalesFulfillmentLineInput,
  type SalesFulfillmentSourceRow,
  canonicalFulfillmentLines,
  missingOrderLineWarehouses,
  stampDefaultWarehouse,
} from "./order-cycle-shared";

export type PurchaseReceiptLineInput = SalesFulfillmentLineInput;

export interface PurchaseReceiptInput {
  receiptDate: string;
  /** Required stable command identity: a lost response retried with the same
   * key returns the stored receipt instead of receiving the stock twice. */
  idempotencyKey: string;
  lines: PurchaseReceiptLineInput[];
  dropShipConfirmation?: { idempotencyKey: string };
}

type PurchaseReceiptSourceLineRow = Record<string, unknown> & {
  id: string;
  line_number: number;
  item_id: string | null;
  account_id: string | null;
  description: string | null;
  quantity: string;
  unit: string | null;
  unit_price: string;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: Record<string, unknown> | null;
  stock_location_id: string | null;
  quantity_fulfilled: string;
  quantity_cancelled: string;
  open_quantity: string;
  custom: Record<string, unknown> | null;
  item_kind: string | null;
  item_name: string | null;
  item_category: string | null;
  has_inventory_profile: boolean;
  received_not_billed_account_id: string | null;
};

/**
 * Canonical receipt lines for a purchase order. A zero quantity means "not
 * received now", so a partial receipt carries only its nonzero lines and a
 * receipt with nothing entered refuses naming what to do. Canonicalization
 * names raw source ids, which the sanitizer redacts to an ellipsis on
 * screen — unresolvable for the operator — so a refusal on the error path
 * resolves the human line numbers with a lock-free lookup (never a new lock,
 * so lock ordering is unchanged) and names those instead.
 */
async function canonicalPurchaseReceiptLines(
  tx: OrderCycleTx,
  orgId: string,
  sourceId: string,
  lines: PurchaseReceiptLineInput[],
): Promise<CanonicalFulfillmentLine[]> {
  const live = lines.filter((line) => {
    try {
      return toQuantityUnits(line.quantity) !== 0n;
    } catch {
      return true;
    }
  });
  if (live.length === 0 && lines.length > 0) {
    throw new ConversionError("Enter a quantity on at least one line");
  }
  try {
    return canonicalFulfillmentLines(live);
  } catch (error) {
    if (!(error instanceof ConversionError)) throw error;
    const ids = [
      ...new Set(live.map((line) => line.sourceLineId.trim()).filter((id) => id !== "")),
    ];
    if (ids.length === 0) throw error;
    const numbers = new Map(
      (
        await tx.execute<{ id: string; line_number: number }>(
          sql`
      select id, line_number from document_lines
       where org_id = ${orgId} and document_id = ${sourceId} and id in (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
    `,
          "objects",
        )
      ).map((row) => [row.id, row.line_number]),
    );
    if (numbers.size === 0) throw error;
    throw new ConversionError(
      error.message.replace(
        /line ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
        (match, id: string) => {
          const lineNumber = numbers.get(id);
          return lineNumber === undefined ? match : `line ${lineNumber}`;
        },
      ),
      error.status,
      error.code,
      error.details,
    );
  }
}

/**
 * Record one immutable goods receipt against a purchase order and bring the
 * stock in within the same transaction (DR inventory / CR received-not-billed
 * at the order price). Advances the order lines' received quantity, which is
 * the ceiling the receipt-governed vendor bill later bills against. Source
 * header and line locks fence concurrent partial receipts; a stable command
 * key makes serial and concurrent retries exactly-once — the same shape as
 * fulfillSalesOrder, on the inbound side.
 */
export async function receivePurchaseOrder(
  orgId: string,
  userId: string,
  sourceId: string,
  input: PurchaseReceiptInput,
): Promise<ConvertResult> {
  return db.transaction((tx) =>
    receivePurchaseOrderInTx(tx, orgId, userId, sourceId, input, { inventory: "apply" }),
  );
}

/** Receive a purchase order inside the caller's transaction. */
export async function receivePurchaseOrderInTx(
  tx: OrderCycleTx,
  orgId: string,
  userId: string,
  sourceId: string,
  input: PurchaseReceiptInput,
  options: { inventory: "apply" | "none" },
): Promise<ConvertResult> {
  if (!(await isFeatureEnabled(orgId, "orders")))
    throw new ConversionError("Orders feature is disabled");
  if (!(await isFeatureEnabled(orgId, "inventory")))
    throw new ConversionError("Inventory is disabled");
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 500) {
    throw new ConversionError("Receipt idempotency key must be between 1 and 500 characters");
  }
  if (!isIsoCalendarDate(input.receiptDate))
    throw new ConversionError("Receipt date must be YYYY-MM-DD");
  const requested = await canonicalPurchaseReceiptLines(tx, orgId, sourceId, input.lines);
  const command = {
    receiptDate: input.receiptDate,
    lines: requested,
    ...(input.dropShipConfirmation ? { dropShipConfirmation: input.dropShipConfirmation } : {}),
  };
  const source = (
    await tx.execute<SalesFulfillmentSourceRow>(
      sql`
      select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
             subsidiary_id, department_id, project_id, location_id, class_id,
             extra_dims, memo, billing_method
        from documents
       where id = ${sourceId} and org_id = ${orgId}
       for update
    `,
      "objects",
    )
  )[0];
  if (!source) throw new ConversionError("Purchase order not found");
  if (source.kind !== "purchase_order")
    throw new ConversionError("Only a purchase order can be received");
  if (source.status === "draft")
    throw new ConversionError("Issue the purchase order before receiving it");
  if (source.status === "voided") throw new ConversionError("This purchase order is voided");
  if (source.status !== "approved")
    throw new ConversionError(`This purchase order is ${source.status}`);

  const dropShipOrder = (
    await tx.execute<{ sales_order_id: string }>(
      sql`
      select sales_order_id from drop_ship_orders
       where org_id = ${orgId} and purchase_order_id = ${sourceId}
    `,
      "objects",
    )
  )[0];
  if (options.inventory === "apply" && dropShipOrder) {
    throw new ConversionError(
      "This purchase order is routed for direct vendor shipment and cannot be received into stock",
      409,
      "drop_ship_confirmation_required",
      { remedy: "Confirm the vendor shipment from the drop-ship purchase order" },
    );
  }
  if (options.inventory === "none" && (!input.dropShipConfirmation || !dropShipOrder)) {
    throw new ConversionError(
      "Stock movements can be skipped only for a confirmed drop-ship purchase order",
      422,
      "drop_ship_confirmation_required",
      { remedy: "Confirm the vendor shipment from the drop-ship purchase order" },
    );
  }

  const replay = (
    await tx.execute<{ id: string; document_number: string; command_matches: boolean }>(
      sql`
      select target.id, target.document_number,
             target.custom->'purchaseReceiptCommand' = ${JSON.stringify(command)}::jsonb as command_matches
        from document_links link
        join documents target
          on target.id = link.to_document_id and target.org_id = link.org_id
       where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
         and link.link_type = 'fulfills' and target.kind = ${PURCHASE_RECEIPT_KIND}
         and target.custom->>'receiptIdempotencyKey' = ${idempotencyKey}
       limit 1
    `,
      "objects",
    )
  )[0];
  if (replay) {
    if (!replay.command_matches) {
      throw new ConversionError(
        "Receipt idempotency key was already used with a different receipt",
        409,
      );
    }
    return {
      id: replay.id,
      documentNumber: replay.document_number,
      kind: PURCHASE_RECEIPT_KIND,
      replayed: true,
    };
  }

  const sourceLines = await tx.execute<PurchaseReceiptSourceLineRow>(
    sql`
      select dl.id, dl.line_number, dl.item_id, dl.account_id, dl.description,
             dl.quantity, dl.unit, dl.unit_price, dl.department_id, dl.project_id, dl.location_id,
             dl.class_id, dl.extra_dims, dl.stock_location_id, dl.quantity_fulfilled,
             dl.quantity_cancelled, ${openQuantitySql("dl")} as open_quantity,
             dl.custom, i.kind as item_kind, i.name as item_name, i.category as item_category,
             profile.item_id is not null as has_inventory_profile,
             profile.received_not_billed_account_id
        from document_lines dl
        left join items i on i.id = dl.item_id and i.org_id = dl.org_id
        left join item_inventory_profiles profile
          on profile.item_id = dl.item_id and profile.org_id = dl.org_id
       where dl.document_id = ${sourceId} and dl.org_id = ${orgId}
       order by dl.line_number
       for update of dl
    `,
    "objects",
  );
  const sourceById = new Map(sourceLines.map((line) => [line.id, line]));
  // One authoritative clearing policy for the whole receipt: the item's
  // costing profile wins, otherwise the company control account. Resolved
  // once per item — never a policy lookup per line below.
  const rnbByItem = new Map<string, string>();
  for (const line of sourceLines) {
    if (line.item_id == null || rnbByItem.has(line.item_id)) continue;
    const resolved = await resolveReceivedNotBilledAccount(tx, orgId, line.item_id);
    if (resolved) rnbByItem.set(line.item_id, resolved.accountId);
  }
  const selected: {
    request: (typeof requested)[number];
    line: PurchaseReceiptSourceLineRow;
    billReceived: bigint;
    allowanceUnits: bigint;
    overReceipt: { excess: string; tolerancePercent: string; toleranceQuantity: string } | null;
  }[] = [];
  const receivingByLine = new Map<string, bigint>();
  for (const request of requested) {
    const line = sourceById.get(request.sourceLineId);
    if (!line)
      throw new ConversionError(`Purchase-order line ${request.sourceLineId} was not found`);
    if (line.item_id == null || !lineRequiresReceipt(line.item_kind)) {
      throw new ConversionError(
        `Purchase-order line ${line.line_number} is not stock and is billed on a two-way match, not received`,
      );
    }
    if (!line.has_inventory_profile) {
      throw new ConversionError(
        `Purchase-order line ${line.line_number} is an inventory item without a costing profile`,
      );
    }
    if (line.item_kind === "kit") {
      const itemLabel = line.item_name ? ` (${line.item_name})` : "";
      throw new ConversionError(
        `Purchase-order line ${line.line_number}${itemLabel} is a kit: kits hold no stock; receive the components — receive each component on its own purchase-order line instead`,
      );
    }
    if (line.item_id == null || !rnbByItem.has(line.item_id)) {
      const itemLabel = line.item_name ? ` (${line.item_name})` : "";
      throw new ConversionError(
        `Purchase-order line ${line.line_number}${itemLabel} cannot be received: ${receivedNotBilledMissingMessage(line.item_name ?? (line.item_id == null ? "this item" : `item ${line.item_id}`))}`,
        422,
        ITEM_MISSING_RNB_ACCOUNT,
        { lineNumber: line.line_number, itemId: line.item_id, itemName: line.item_name },
      );
    }
    // Stock a linked vendor bill already received through the bill drain
    // counts as received here: the shared cover reports it floored into
    // this line's unit with the bills behind it, so the receipt can only
    // bring what the bills have not. Unlinked bill-direct stock names no
    // order line and stays invisible — that receipt stays permissive.
    const billCover = await linkedBillReceivedCover(tx, orgId, {
      purchaseOrderLineId: line.id,
      itemId: line.item_id,
      unit: line.unit,
    });
    const billReceived = toQuantityUnits(billCover.quantity);
    const billNumbers = billCover.bills.map((bill) => bill.billNumber);
    const billLabel =
      billNumbers.length > 1
        ? `vendor bills ${billNumbers.join(", ")}`
        : `vendor bill ${billNumbers[0]}`;
    const billRefusal = (rest: bigint) =>
      new ConversionError(
        rest > 0n
          ? `Purchase-order line ${line.line_number} was already received on ${billLabel} (${fromQuantityUnits(billReceived)} ${line.unit}): the stock is on hand through the bill. Receive at most ${fromQuantityUnits(rest)} ${line.unit} now, or void ${billLabel} to unwind its receipt and receive again`
          : `Purchase-order line ${line.line_number} was already received on ${billLabel} (${fromQuantityUnits(billReceived)} ${line.unit}): the stock is on hand through the bill. Void ${billLabel} to unwind its receipt and receive again, or do not receive`,
        422,
        "BILL_ALREADY_RECEIVED",
        {
          lineNumber: line.line_number,
          billNumbers,
          remedy:
            rest > 0n
              ? `Receive at most ${fromQuantityUnits(rest)} ${line.unit} on this line, or void ${billLabel} first`
              : `Void ${billLabel} to unwind its receipt, then receive again`,
        },
      );
    const remaining = toQuantityUnits(String(line.open_quantity)) - billReceived;
    const receiving = toQuantityUnits(request.quantity);
    const priorReceiving = receivingByLine.get(line.id) ?? 0n;
    const cumulativeReceiving = priorReceiving + receiving;
    receivingByLine.set(line.id, cumulativeReceiving);
    if (remaining <= 0n) {
      if (billNumbers.length > 0) throw billRefusal(remaining);
      throw new ConversionError(
        `Purchase-order line ${line.line_number} is already fully received`,
      );
    }
    let allowanceUnits = 0n;
    let overReceipt: {
      excess: string;
      tolerancePercent: string;
      toleranceQuantity: string;
    } | null = null;
    if (cumulativeReceiving > remaining) {
      // Over-receipt tolerance: the Setup policy effective on the receipt
      // date for the item's exact stored category (else the org-wide
      // default) lets a receipt exceed the remainder within tolerance.
      // Both tolerances default to zero, keeping the exact refusal below.
      const tolerance = await resolveOverReceiptTolerance(
        tx,
        orgId,
        line.item_category,
        input.receiptDate,
      );
      const netOrdered =
        toQuantityUnits(String(line.quantity)) - toQuantityUnits(String(line.quantity_cancelled));
      allowanceUnits = overReceiptAllowanceUnits(netOrdered, tolerance);
      const cumulativeExcess = cumulativeReceiving - remaining;
      if (cumulativeExcess > allowanceUnits) {
        if (billNumbers.length > 0) throw billRefusal(remaining);
        throw new ConversionError(
          `Purchase-order line ${line.line_number} has only ${fromQuantityUnits(remaining)} remaining to receive`,
        );
      }
      const priorExcess = priorReceiving > remaining ? priorReceiving - remaining : 0n;
      overReceipt = {
        excess: fromQuantityUnits(cumulativeExcess - priorExcess),
        tolerancePercent: tolerance?.percent ?? "0",
        toleranceQuantity: tolerance?.quantity ?? "0",
      };
    }
    selected.push({ request, line, billReceived, allowanceUnits, overReceipt });
  }

  if (options.inventory === "none") {
    const routed = await tx.execute<{ purchase_order_line_id: string }>(
      sql`
        select purchase_order_line_id from drop_ship_lines
         where org_id = ${orgId} and purchase_order_line_id in (
           ${sql.join(
             selected.map(({ line }) => sql`${line.id}`),
             sql`, `,
           )}
         )`,
      "objects",
    );
    if (routed.length !== selected.length) {
      throw new ConversionError(
        "Every stockless receipt line must be paired to this drop-ship purchase order",
        422,
        "drop_ship_confirmation_required",
        { remedy: "Confirm the vendor shipment from the drop-ship purchase order" },
      );
    }
  }

  // Same legacy trap as the sales side: a NULL warehouse on a stocked
  // line would fail inside the inventory kernel with a generic error.
  // Blank stocked lines take the entity's default warehouse (designated,
  // then the implicit single) stamped onto the in-memory line before any
  // check below; a first receipt for a single-site org with no warehouse
  // yet creates it through the warehouse service. Refuse up front naming
  // the line and the way forward only when no default answers.
  if (options.inventory === "apply") {
    await stampDefaultWarehouse(
      tx,
      orgId,
      userId,
      source.subsidiary_id,
      selected.map(({ line }) => line),
    );
    const receiptWarehouses = await activeStockLocations(orgId);
    const unwarehousedReceipt = missingOrderLineWarehouses(
      selected.map(({ line }) => ({
        lineNumber: line.line_number,
        itemId: line.item_id,
        hasInventoryProfile: line.has_inventory_profile,
        stockLocationId: line.stock_location_id,
      })),
      receiptWarehouses.length,
    )[0];
    if (unwarehousedReceipt) {
      const details = {
        lineNumber: unwarehousedReceipt.lineNumber,
        activeWarehouses: receiptWarehouses.length,
      };
      if (receiptWarehouses.length === 0) {
        throw new ConversionError(
          `Purchase-order line ${unwarehousedReceipt.lineNumber} is a stocked item with no warehouse, and this organization has no active warehouse — create one in Warehouse → Warehouses, assign it to the line, then receive again`,
          422,
          ORDER_LINE_WAREHOUSE_REQUIRED,
          details,
        );
      }
      throw new ConversionError(
        `Purchase-order line ${unwarehousedReceipt.lineNumber} is a stocked item with no warehouse, and this organization has ${receiptWarehouses.length} active warehouses, so receipt cannot choose one — assign a warehouse to the line, then receive again`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        details,
      );
    }
  }

  const documentNumber = await nextDocumentNumber(
    orgId,
    PURCHASE_RECEIPT_KIND,
    "RCPT-",
    source.subsidiary_id,
  );
  const receiptId = randomUUID();
  const custom = {
    receiptIdempotencyKey: idempotencyKey,
    purchaseReceiptCommand: command,
    ...(input.dropShipConfirmation ? { dropShipConfirmation: input.dropShipConfirmation } : {}),
  };
  await tx.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, document_date, currency,
         fx_rate, status, subsidiary_id, department_id, project_id, location_id,
         class_id, extra_dims, billing_method, memo, subtotal, tax_total, total,
         custom, created_by, updated_by)
      values
        (${receiptId}, ${orgId}, ${PURCHASE_RECEIPT_KIND}, ${documentNumber},
         ${source.party_id}, ${input.receiptDate}, ${source.currency}, ${source.fx_rate},
         'draft', ${source.subsidiary_id}, ${source.department_id}, ${source.project_id},
         ${source.location_id}, ${source.class_id}, ${JSON.stringify(source.extra_dims ?? {})}::jsonb,
         ${source.billing_method}, ${source.memo}, '0', '0', '0',
         ${JSON.stringify(custom)}::jsonb, ${userId}, ${userId})
    `);

  // Approved lines are storage-immutable (migration 0034); advancing the
  // received quantity is operational evidence, not a commercial edit. The
  // header is locked for this transaction, so reopen, advance, restore.
  const reopened = (
    await tx.execute<{ id: string }>(
      sql`
      update documents set status = 'draft', updated_by = ${userId}
       where id = ${sourceId} and org_id = ${orgId} and status = 'approved'
      returning id
    `,
      "objects",
    )
  )[0];
  if (!reopened)
    throw new ConversionError("Purchase order changed while it was being received", 409);

  let lineNumber = 1;
  let subtotal = "0";
  for (const { request, line, billReceived, allowanceUnits, overReceipt } of selected) {
    // Received at the order price: the amount is the value the receipt
    // credits to received-not-billed and the bill later clears. A tolerated
    // over-receipt records its excess and the applied policy on the line,
    // so the above-ordered quantity stays inspectable evidence.
    const amount = orderLineAmount(request.quantity, String(line.unit_price));
    subtotal = add(subtotal, amount);
    const lineCustom = {
      ...(line.custom ?? {}),
      receipt: { sourceLineId: line.id, lotId: request.lotId, serialId: request.serialId },
      ...(overReceipt ? { overReceipt } : {}),
    };
    await tx.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, description,
           quantity, unit, unit_price, amount, tax_amount, department_id,
           project_id, location_id, class_id, extra_dims, stock_location_id,
           is_billable, custom, created_by, updated_by)
        values
          (${orgId}, ${receiptId}, ${lineNumber}, ${line.item_id}, ${line.account_id},
           ${line.description}, ${request.quantity}, ${line.unit}, ${line.unit_price}, ${amount}, '0',
           ${line.department_id}, ${line.project_id}, ${line.location_id}, ${line.class_id},
           ${JSON.stringify(line.extra_dims ?? {})}::jsonb, ${line.stock_location_id}, false,
           ${JSON.stringify(lineCustom)}::jsonb, ${userId}, ${userId})
      `);
    const advanced = (
      await tx.execute<{ id: string }>(
        sql`
        update document_lines
           set quantity_fulfilled = quantity_fulfilled + ${request.quantity},
               updated_by = ${userId}
         where id = ${line.id} and org_id = ${orgId}
           -- The received quantity may land above ordered within the
           -- validated tolerance (zero by default: the exact ceiling stands).
           and quantity_fulfilled + ${request.quantity} <= ${orderedNetOfCancelledSql("document_lines")}
             - ${fromQuantityUnits(billReceived)} + ${fromQuantityUnits(allowanceUnits)}
        returning id
      `,
        "objects",
      )
    )[0];
    if (!advanced) {
      throw new ConversionError(
        `Purchase-order line ${line.line_number} changed while it was being received`,
        409,
      );
    }
    lineNumber++;
  }

  const totalled = await tx.execute<{ id: string }>(
    sql`
      update documents set subtotal = ${subtotal}, tax_total = '0', total = ${subtotal}, updated_by = ${userId}
       where id = ${receiptId} and org_id = ${orgId} and kind = 'purchase_receipt' and status = 'draft'
      returning id
    `,
    "objects",
  );
  if (totalled.length !== 1)
    throw new ConversionError("Purchase receipt changed while its totals were saved", 409);

  const restored = (
    await tx.execute<{ id: string }>(
      sql`
      update documents set status = 'approved', updated_by = ${userId}
       where id = ${sourceId} and org_id = ${orgId} and status = 'draft'
      returning id
    `,
      "objects",
    )
  )[0];
  if (!restored)
    throw new ConversionError("Purchase order changed while it was being received", 409);

  await tx.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${receiptId}, 'fulfills', ${userId})
    `);
  if (options.inventory === "apply") {
    await applyPurchaseReceiptInventory(
      tx,
      orgId,
      userId,
      receiptId,
      input.receiptDate,
      source.subsidiary_id,
    );
  }
  await tx.execute(sql`
      update documents set status = 'approved', updated_by = ${userId}
       where id = ${receiptId} and org_id = ${orgId}
    `);
  return { id: receiptId, documentNumber, kind: PURCHASE_RECEIPT_KIND };
}

/** Receive every stock line's remaining quantity through the conversion
 * surface, with a key derived from the observed source state so concurrent
 * clicks replay one receipt. Call receivePurchaseOrder directly for explicit
 * partial quantities or lot/serial selections. */
export async function receivePurchaseOrderRemainder(
  orgId: string,
  userId: string,
  sourceId: string,
): Promise<ConvertResult> {
  const receiptDate = await businessToday(orgId);
  const rows = await db.execute<{
    id: string;
    open_quantity: string;
    item_id: string | null;
    unit: string | null;
    item_kind: string | null;
  }>(
    sql`
    select line.id, ${openQuantitySql("line")}::text as open_quantity,
           line.item_id, line.unit, i.kind as item_kind
      from document_lines line
      join documents source on source.id = line.document_id and source.org_id = line.org_id
      left join items i on i.id = line.item_id and i.org_id = line.org_id
     where line.org_id = ${orgId} and source.id = ${sourceId}
       and source.kind = 'purchase_order'
     order by line.id
  `,
    "objects",
  );
  const lines: PurchaseReceiptLineInput[] = [];
  for (const line of rows) {
    if (line.item_id == null || !lineRequiresReceipt(line.item_kind)) continue;
    const billCover = await linkedBillReceivedCover(db, orgId, {
      purchaseOrderLineId: line.id,
      itemId: line.item_id,
      unit: line.unit,
    });
    const remaining = toQuantityUnits(line.open_quantity) - toQuantityUnits(billCover.quantity);
    if (remaining > 0n)
      lines.push({ sourceLineId: line.id, quantity: fromQuantityUnits(remaining) });
  }
  if (lines.length === 0) {
    const latest = (
      await db.execute<{ id: string; document_number: string }>(
        sql`
      select target.id, target.document_number
        from document_links link
        join documents target on target.id = link.to_document_id and target.org_id = link.org_id
       where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
         and link.link_type = 'fulfills' and target.kind = ${PURCHASE_RECEIPT_KIND}
       order by target.created_at desc, target.id desc
       limit 1
    `,
        "objects",
      )
    )[0];
    if (!latest)
      throw new ConversionError("This purchase order has no stock lines left to receive");
    return {
      id: latest.id,
      documentNumber: latest.document_number,
      kind: PURCHASE_RECEIPT_KIND,
      replayed: true,
    };
  }
  const idempotencyKey = `purchase-receipt-remainder:${createHash("sha256")
    .update(JSON.stringify({ sourceId, receiptDate, lines }))
    .digest("hex")}`;
  return receivePurchaseOrder(orgId, userId, sourceId, { receiptDate, idempotencyKey, lines });
}
