import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { nextDocumentNumber } from "./bills.ts";
import { SALES_FULFILLMENT_KIND } from "./order-kinds";
import { cmp } from "@openbooks/engine/money/money";
import {
  kitComponentMovesStock,
  kitComponentQuantities,
  loadKitComponents,
} from "@openbooks/engine/inventory";
import { fromQuantityUnits, toQuantityUnits } from "./order-cycle-math";
import { isFeatureEnabled } from "./features";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { applySalesFulfillmentInventoryIssues } from "@openbooks/engine/inventory/documents-sales";
import { openQuantitySql } from "@openbooks/engine/records/order-line-remainders";
import { activeStockLocations } from "./stock-locations";
import { isUuid } from "./list-params";
import {
  ConversionError,
  type ConvertResult,
  FULFILLMENT_BIN_OUTSIDE_WAREHOUSE,
  INVENTORY_ITEM_KINDS,
  ORDER_LINE_WAREHOUSE_REQUIRED,
  type OrderCycleTx,
  type SalesFulfillmentLineInput,
  type SalesFulfillmentSourceRow,
  canonicalFulfillmentLines,
  missingOrderLineWarehouses,
  stampDefaultWarehouse,
} from "./order-cycle-shared";

export interface SalesFulfillmentInput {
  fulfillmentDate: string;
  /** Required stable command identity. A lost response can be retried with the
   * same key; the stored fulfillment is returned instead of shipping twice. */
  idempotencyKey: string;
  lines: SalesFulfillmentLineInput[];
  dropShipConfirmation?: { purchaseReceiptId: string };
}

type SalesFulfillmentSourceLineRow = Record<string, unknown> & {
  id: string;
  line_number: number;
  item_id: string | null;
  account_id: string | null;
  description: string | null;
  quantity: string;
  unit: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: Record<string, unknown> | null;
  stock_location_id: string | null;
  /** Warehouse enclosing the line's location, null when it sits in none. */
  warehouse_id: string | null;
  quantity_fulfilled: string;
  /** Quantity still owed: ordered less shipped and cancelled. */
  open_quantity: string;
  custom: Record<string, unknown> | null;
  item_kind: string | null;
  has_inventory_profile: boolean;
};

/**
 * Record one immutable sales shipment and relieve inventory/COGS in the same
 * transaction. Source order and line locks fence concurrent partial shipments;
 * a stable command key makes serial and concurrent retries exactly-once.
 */
export async function fulfillSalesOrder(
  orgId: string,
  userId: string,
  sourceId: string,
  input: SalesFulfillmentInput,
): Promise<ConvertResult> {
  return db.transaction((tx) =>
    fulfillSalesOrderInTx(tx, orgId, userId, sourceId, input, { inventory: "apply" }),
  );
}

/**
 * The fulfilment path inside a caller's transaction, so a caller that owns
 * more of the unit (shipment completion) records the fulfilment atomically
 * with its own writes.
 */
export async function fulfillSalesOrderInTx(
  tx: OrderCycleTx,
  orgId: string,
  userId: string,
  sourceId: string,
  input: SalesFulfillmentInput,
  options: { inventory: "apply" | "none" },
): Promise<ConvertResult> {
  if (!(await isFeatureEnabled(orgId, "orders")))
    throw new ConversionError("Orders feature is disabled");
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 500) {
    throw new ConversionError("Fulfillment idempotency key must be between 1 and 500 characters");
  }
  if (!isIsoCalendarDate(input.fulfillmentDate))
    throw new ConversionError("Fulfillment date must be YYYY-MM-DD");
  const requested = canonicalFulfillmentLines(input.lines);
  const command = {
    fulfillmentDate: input.fulfillmentDate,
    lines: requested,
    ...(input.dropShipConfirmation ? { dropShipConfirmation: input.dropShipConfirmation } : {}),
  };
  const sourceResult = await tx.execute<SalesFulfillmentSourceRow>(
    sql`
    select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
           subsidiary_id, department_id, project_id, location_id, class_id,
           extra_dims, memo, billing_method
      from documents
     where id = ${sourceId} and org_id = ${orgId}
     for update
  `,
    "objects",
  );
  const source = sourceResult[0];
  if (!source) throw new ConversionError("Sales order not found");
  if (source.kind !== "sales_order")
    throw new ConversionError("Only a sales order can be fulfilled");
  if (
    (
      await tx.execute(
        sql`select id from subscription_renewal_occurrences where org_id=${orgId} and document_id=${sourceId} and occurrence='document' limit 1`,
        "objects",
      )
    )[0]
  )
    throw new ConversionError(
      "This renewal order commits a subscription term; accept it in Collections and use subscription billing for periodic delivery",
    );
  if (source.status === "draft")
    throw new ConversionError("Issue the sales order before fulfilling it");
  if (source.status === "voided") throw new ConversionError("This sales order is voided");
  if (source.status !== "approved")
    throw new ConversionError(`This sales order is ${source.status}`);

  // The source header lock serializes every fulfillment command for this SO.
  // That makes the JSON key unique at the owning aggregate boundary without
  // a second global command table, and lets a retry compare its exact payload.
  const replay = (
    await tx.execute<{
      id: string;
      document_number: string;
      command_matches: boolean;
    }>(
      sql`
    select target.id, target.document_number,
           target.custom->'salesFulfillmentCommand' = ${JSON.stringify(command)}::jsonb as command_matches
      from document_links link
      join documents target
        on target.id = link.to_document_id and target.org_id = link.org_id
     where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
       and link.link_type = 'fulfills' and target.kind = ${SALES_FULFILLMENT_KIND}
       and target.custom->>'fulfillmentIdempotencyKey' = ${idempotencyKey}
     limit 1
  `,
      "objects",
    )
  )[0];
  if (replay) {
    if (!replay.command_matches) {
      throw new ConversionError(
        "Fulfillment idempotency key was already used with a different shipment",
        409,
      );
    }
    return {
      id: replay.id,
      documentNumber: replay.document_number,
      kind: SALES_FULFILLMENT_KIND,
      replayed: true,
    };
  }

  const sourceLines = await tx.execute<SalesFulfillmentSourceLineRow>(
    sql`
    select dl.id, dl.line_number, dl.item_id, dl.account_id, dl.description,
           dl.quantity, dl.unit, dl.department_id, dl.project_id, dl.location_id,
           dl.class_id, dl.extra_dims, dl.stock_location_id,
           stock_location_warehouse(dl.org_id, dl.stock_location_id) as warehouse_id,
           dl.quantity_fulfilled,
           ${openQuantitySql("dl")}::text as open_quantity,
           dl.custom, i.kind as item_kind,
           profile.item_id is not null as has_inventory_profile
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
  const shippingByLine = new Map<string, bigint>();
  const selected = requested.map((request) => {
    const line = sourceById.get(request.sourceLineId);
    if (!line) throw new ConversionError(`Sales-order line ${request.sourceLineId} was not found`);
    const remaining = toQuantityUnits(line.open_quantity);
    const shipping = (shippingByLine.get(line.id) ?? 0n) + toQuantityUnits(request.quantity);
    shippingByLine.set(line.id, shipping);
    if (remaining <= 0n) {
      throw new ConversionError(
        `Sales-order line ${line.line_number} is already fully fulfilled or cancelled`,
      );
    }
    if (shipping > remaining) {
      throw new ConversionError(
        `Sales-order line ${line.line_number} has only ${fromQuantityUnits(remaining)} remaining to fulfill`,
      );
    }
    return { request, line };
  });

  const routedLine =
    selected.length > 0
      ? (
          await tx.execute<{ line_number: number }>(
            sql`
        select dl.line_number
          from drop_ship_lines ds
          join document_lines dl on dl.org_id = ds.org_id and dl.id = ds.sales_order_line_id
         where ds.org_id = ${orgId} and dl.document_id = ${sourceId}
           and dl.id in (${sql.join(
             selected.map(({ line }) => sql`${line.id}`),
             sql`, `,
           )})
         order by dl.line_number limit 1`,
            "objects",
          )
        )[0]
      : undefined;
  if (routedLine && options.inventory === "apply") {
    throw new ConversionError(
      `Sales-order line ${routedLine.line_number} is routed for vendor shipment and cannot be fulfilled from stock`,
      409,
      "drop_ship_confirmation_required",
      { remedy: "Confirm the vendor shipment from the drop-ship purchase order" },
    );
  }
  if (options.inventory === "none" && !input.dropShipConfirmation) {
    throw new ConversionError(
      "Stock movements can be skipped only for a confirmed drop-ship order",
      422,
      "drop_ship_confirmation_required",
      { remedy: "Confirm the vendor shipment from the drop-ship purchase order" },
    );
  }
  if (options.inventory === "none") {
    const receiptId = input.dropShipConfirmation!.purchaseReceiptId;
    const receiptEvidence = await tx.execute<{ sales_order_line_id: string; quantity: string }>(
      sql`
      select routed.sales_order_line_id, receipt_line.quantity::text as quantity
        from drop_ship_lines routed
        join document_lines po_line on po_line.id = routed.purchase_order_line_id and po_line.org_id = routed.org_id
        join drop_ship_orders pair on pair.org_id = routed.org_id and pair.purchase_order_id = po_line.document_id
        join document_links receipt_link on receipt_link.org_id = routed.org_id
          and receipt_link.from_document_id = pair.purchase_order_id
          and receipt_link.to_document_id = ${receiptId} and receipt_link.link_type = 'fulfills'
        join document_lines receipt_line on receipt_line.org_id = routed.org_id
          and receipt_line.document_id = ${receiptId}
          and receipt_line.custom->'receipt'->>'sourceLineId' = po_line.id::text
       where routed.org_id = ${orgId} and pair.sales_order_id = ${sourceId}
         and routed.sales_order_line_id in (${sql.join(
           selected.map(({ line }) => sql`${line.id}`),
           sql`, `,
         )})
    `,
      "objects",
    );
    const receiptBySalesLine = new Map(
      receiptEvidence.map((row) => [row.sales_order_line_id, row.quantity]),
    );
    if (
      receiptBySalesLine.size !== new Set(selected.map(({ line }) => line.id)).size ||
      selected.some(({ request, line }) => {
        const confirmed = receiptBySalesLine.get(line.id);
        return (
          confirmed === undefined ||
          toQuantityUnits(confirmed) !== toQuantityUnits(request.quantity)
        );
      })
    ) {
      throw new ConversionError(
        "The receipt does not confirm the same routed sales-order quantities",
        422,
        "drop_ship_confirmation_required",
        { remedy: "Confirm the vendor shipment from the drop-ship purchase order" },
      );
    }
  }

  // Blank stocked lines take the entity's default before any check below,
  // so picks validate against the warehouse the fulfillment will relieve.
  // Stock movements only: drop-ship lines route to the vendor, never here.
  if (options.inventory === "apply") {
    await stampDefaultWarehouse(
      tx,
      orgId,
      userId,
      source.subsidiary_id,
      selected.map(({ line }) => line),
    );
  }
  // A named bin must be the line's own location or lie inside the
  // warehouse that location belongs to. Kit component bins ride the same
  // rule against the kit line's warehouse.
  const binIds = [
    ...new Set(
      selected.flatMap(({ request }) => [
        ...(request.stockLocationId ? [request.stockLocationId] : []),
        ...(request.kitComponents ?? []).flatMap((pick) =>
          pick.stockLocationId ? [pick.stockLocationId] : [],
        ),
      ]),
    ),
  ];
  if (binIds.length > 0) {
    const bins = new Map(
      (
        await tx.execute<{ id: string; code: string; warehouse_id: string | null }>(
          sql`
      select id, code, stock_location_warehouse(org_id, id) as warehouse_id
        from stock_locations
       where org_id = ${orgId} and id = any(${`{${binIds.join(",")}}`}::uuid[])
    `,
          "objects",
        )
      ).map((bin) => [bin.id, bin]),
    );
    const assertBinInsideLineWarehouse = (
      binId: string,
      line: { line_number: number; warehouse_id: string | null; stock_location_id: string | null },
    ) => {
      if (binId === line.stock_location_id) return;
      const bin = bins.get(binId);
      if (!line.warehouse_id) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} ships from no warehouse, so it cannot issue from a bin — assign a warehouse to the line, then fulfill again`,
          422,
          ORDER_LINE_WAREHOUSE_REQUIRED,
          { lineNumber: line.line_number },
        );
      }
      if (!bin || bin.warehouse_id !== line.warehouse_id) {
        throw new ConversionError(
          `${bin ? `Bin ${bin.code}` : "The selected bin"} is not inside the warehouse sales-order line ${line.line_number} ships from — choose a bin in that warehouse`,
          422,
          FULFILLMENT_BIN_OUTSIDE_WAREHOUSE,
          { lineNumber: line.line_number },
        );
      }
    };
    for (const { request, line } of selected) {
      if (request.stockLocationId) assertBinInsideLineWarehouse(request.stockLocationId, line);
      for (const pick of request.kitComponents ?? []) {
        if (pick.stockLocationId) assertBinInsideLineWarehouse(pick.stockLocationId, line);
      }
    }
  }

  if (options.inventory === "apply" && !(await isFeatureEnabled(orgId, "inventory"))) {
    const inventoryLine = selected.find(
      ({ line }) => line.item_id != null && INVENTORY_ITEM_KINDS.has(String(line.item_kind)),
    );
    if (inventoryLine) throw new ConversionError("Inventory is disabled");
  }
  const uncostedInventoryLine = selected.find(
    ({ line }) =>
      line.item_id != null &&
      INVENTORY_ITEM_KINDS.has(String(line.item_kind)) &&
      !line.has_inventory_profile,
  );
  if (uncostedInventoryLine) {
    throw new ConversionError(
      `Sales-order line ${uncostedInventoryLine.line.line_number} is an inventory item without a costing profile`,
    );
  }

  // Kit order lines ship their components, never themselves: the request
  // names the per-component lot/serial/bin picks, which are validated here —
  // before anything is written — against the recipe effective on the ship
  // date. The issue drain re-checks the same contract under its locks.
  for (const { request, line } of selected) {
    const picks = request.kitComponents ?? [];
    if (line.item_kind !== "kit") {
      if (picks.length > 0) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} is not a kit; only kit lines ship by component`,
        );
      }
      continue;
    }
    if (request.lotId || request.serialId) {
      throw new ConversionError(
        `Sales-order line ${line.line_number} is a kit; choose lots and serials per component, not on the kit line`,
      );
    }
    const components = (
      await loadKitComponents(tx, orgId, line.item_id!, input.fulfillmentDate)
    ).filter((component) => kitComponentMovesStock(component.componentKind));
    const seenComponents = new Set<string>();
    for (const pick of picks) {
      if (!isUuid(pick.componentItemId)) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} names an invalid kit component`,
        );
      }
      if (seenComponents.has(pick.componentItemId)) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} names the same kit component twice; list each component once`,
        );
      }
      seenComponents.add(pick.componentItemId);
      if (!components.some((component) => component.componentItemId === pick.componentItemId)) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} names a component outside the kit's recipe on ${input.fulfillmentDate}`,
        );
      }
    }
    if (components.length === 0) continue;
    const profiles = await tx.execute<{ item_id: string; tracking: string }>(
      sql`
      select item_id, tracking from item_inventory_profiles
       where org_id = ${orgId}
         and item_id in (${sql.join(
           components.map((component) => sql`${component.componentItemId}`),
           sql`, `,
         )})`,
      "objects",
    );
    const trackingByComponent = new Map(
      profiles.map((profile) => [profile.item_id, profile.tracking]),
    );
    const quantities = kitComponentQuantities(
      `line ${line.line_number}`,
      request.quantity,
      components,
    );
    for (const component of components) {
      const tracking = trackingByComponent.get(component.componentItemId) ?? "none";
      const pick = picks.find(
        (candidate) => candidate.componentItemId === component.componentItemId,
      );
      if (tracking !== "none" && !pick) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} needs the ${tracking} for its ${tracking}-tracked component; name it per component`,
        );
      }
      if (
        pick &&
        ((["lot", "lot_serial"].includes(tracking) && !pick.lotId) ||
          (["serial", "lot_serial"].includes(tracking) && !pick.serialId))
      ) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} names no ${tracking} for its ${tracking}-tracked component; choose the ${tracking} per component`,
        );
      }
      const componentQuantity = quantities.find(
        (entry) => entry.componentItemId === component.componentItemId,
      )!.quantity;
      if (["serial", "lot_serial"].includes(tracking) && cmp(componentQuantity, "1") !== 0) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} ships ${componentQuantity} units of a serial-tracked component, but one line names one serial; split the fulfillment so each line ships one`,
        );
      }
    }
  }

  // Orders approved before line warehouses existed carry NULL warehouses
  // and are storage-immutable, so fulfillment would otherwise fail deep
  // inside the inventory kernel with a generic stock-location error. Blank
  // stocked lines take the entity's default warehouse (designated, then the
  // implicit single); a first fulfillment for a single-site org with no
  // warehouse yet creates it through the warehouse service. Refuse up front
  // naming the line and the way forward only when no default answers.
  if (options.inventory === "apply") {
    const activeWarehouses = await activeStockLocations(orgId);
    const unwarehoused = missingOrderLineWarehouses(
      selected.map(({ line, request }) => ({
        lineNumber: line.line_number,
        itemId: line.item_id,
        hasInventoryProfile: line.has_inventory_profile,
        stockLocationId: request.stockLocationId ?? line.stock_location_id,
      })),
      activeWarehouses.length,
    );
    const warehouseless = unwarehoused[0];
    if (warehouseless) {
      const details = {
        lineNumber: warehouseless.lineNumber,
        activeWarehouses: activeWarehouses.length,
      };
      if (activeWarehouses.length === 0) {
        throw new ConversionError(
          `Sales-order line ${warehouseless.lineNumber} is a stocked item with no warehouse, and this organization has no active warehouse — create one in Warehouse → Warehouses, assign it to the line, then fulfill again`,
          422,
          ORDER_LINE_WAREHOUSE_REQUIRED,
          details,
        );
      }
      throw new ConversionError(
        `Sales-order line ${warehouseless.lineNumber} is a stocked item with no warehouse, and this organization has ${activeWarehouses.length} active warehouses, so fulfillment cannot choose one — assign a warehouse to the line, then fulfill again`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        details,
      );
    }
  }

  const documentNumber = await nextDocumentNumber(
    orgId,
    SALES_FULFILLMENT_KIND,
    "SHIP-",
    source.subsidiary_id,
  );
  const fulfillmentId = randomUUID();
  const custom = {
    fulfillmentIdempotencyKey: idempotencyKey,
    salesFulfillmentCommand: command,
    ...(input.dropShipConfirmation ? { dropShipConfirmation: input.dropShipConfirmation } : {}),
  };
  await tx.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, document_date, currency,
       fx_rate, status, subsidiary_id, department_id, project_id, location_id,
       class_id, extra_dims, billing_method, memo, subtotal, tax_total, total,
       custom, created_by, updated_by)
    values
      (${fulfillmentId}, ${orgId}, ${SALES_FULFILLMENT_KIND}, ${documentNumber},
       ${source.party_id}, ${input.fulfillmentDate}, ${source.currency}, ${source.fx_rate},
       'draft', ${source.subsidiary_id}, ${source.department_id}, ${source.project_id},
       ${source.location_id}, ${source.class_id}, ${JSON.stringify(source.extra_dims ?? {})}::jsonb,
       ${source.billing_method}, ${source.memo}, '0', '0', '0',
       ${JSON.stringify(custom)}::jsonb, ${userId}, ${userId})
  `);

  // Migration 0034 makes approved document lines immutable. Advancing
  // quantity_fulfilled is operational shipment evidence, not an edit to the
  // approved commercial source. The source header is locked for this
  // transaction, so briefly reopen it while the shipment lines advance and
  // restore approved before another caller can observe the transaction.
  const reopenSourceForLineAdvances = source.status === "approved";
  if (reopenSourceForLineAdvances) {
    const reopened = (
      await tx.execute<{ id: string }>(
        sql`
      update documents
         set status = 'draft', updated_by = ${userId}
       where id = ${sourceId} and org_id = ${orgId} and status = 'approved'
      returning id
    `,
        "objects",
      )
    )[0];
    if (!reopened)
      throw new ConversionError("Sales order changed while it was being fulfilled", 409);
  }

  let lineNumber = 1;
  for (const { request, line } of selected) {
    const lineCustom = {
      ...(line.custom ?? {}),
      fulfillment: {
        sourceLineId: line.id,
        lotId: request.lotId,
        serialId: request.serialId,
        ...(request.kitComponents && request.kitComponents.length > 0
          ? {
              kitComponents: request.kitComponents.map((pick) => ({
                componentItemId: pick.componentItemId,
                lotId: pick.lotId,
                serialId: pick.serialId,
                ...(pick.stockLocationId ? { stockLocationId: pick.stockLocationId } : {}),
              })),
            }
          : {}),
      },
    };
    await tx.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, description,
         quantity, unit, unit_price, amount, tax_amount, department_id,
         project_id, location_id, class_id, extra_dims, stock_location_id,
         is_billable, custom, created_by, updated_by)
      values
        (${orgId}, ${fulfillmentId}, ${lineNumber}, ${line.item_id}, ${line.account_id},
         ${line.description}, ${request.quantity}, ${line.unit}, '0', '0', '0',
         ${line.department_id}, ${line.project_id}, ${line.location_id}, ${line.class_id},
         ${JSON.stringify(line.extra_dims ?? {})}::jsonb, ${request.stockLocationId ?? line.stock_location_id}, false,
         ${JSON.stringify(lineCustom)}::jsonb, ${userId}, ${userId})
    `);
    const advanced = (
      await tx.execute<{ id: string }>(
        sql`
      update document_lines
         set quantity_fulfilled = quantity_fulfilled + ${request.quantity},
             updated_by = ${userId}
       where id = ${line.id} and org_id = ${orgId}
         and ${openQuantitySql("document_lines")} >= ${request.quantity}
      returning id
    `,
        "objects",
      )
    )[0];
    if (!advanced) {
      throw new ConversionError(
        `Sales-order line ${line.line_number} changed while it was being fulfilled`,
        409,
      );
    }
    lineNumber++;
  }

  if (reopenSourceForLineAdvances) {
    const restored = (
      await tx.execute<{ id: string }>(
        sql`
      update documents
         set status = 'approved', updated_by = ${userId}
       where id = ${sourceId} and org_id = ${orgId} and status = 'draft'
      returning id
    `,
        "objects",
      )
    )[0];
    if (!restored)
      throw new ConversionError("Sales order changed while it was being fulfilled", 409);
  }

  await tx.execute(sql`
    insert into document_links
      (org_id, from_document_id, to_document_id, link_type, created_by)
    values (${orgId}, ${sourceId}, ${fulfillmentId}, 'fulfills', ${userId})
  `);
  if (options.inventory === "apply") {
    await applySalesFulfillmentInventoryIssues(
      tx,
      orgId,
      userId,
      fulfillmentId,
      input.fulfillmentDate,
      source.subsidiary_id,
    );
  }
  await tx.execute(sql`
    update documents
       set status = 'approved', updated_by = ${userId}
     where id = ${fulfillmentId} and org_id = ${orgId}
  `);
  return { id: fulfillmentId, documentNumber, kind: SALES_FULFILLMENT_KIND };
}

/** Existing conversion routes carry only a target kind. Fulfill the complete
 * current remainder through that established surface while deriving a stable
 * key from the observed source state: concurrent clicks share a key and replay
 * the winner instead of creating two shipments. Call fulfillSalesOrder
 * directly when a picker supplies explicit partial quantities. */
export async function fulfillSalesOrderRemainder(
  orgId: string,
  userId: string,
  sourceId: string,
): Promise<ConvertResult> {
  const fulfillmentDate = await businessToday(orgId);
  const rows = await db.execute<{
    id: string;
    open_quantity: string;
  }>(
    sql`
    select line.id, ${openQuantitySql("line")}::text as open_quantity
      from document_lines line
      join documents source
        on source.id = line.document_id and source.org_id = line.org_id
     where line.org_id = ${orgId} and source.id = ${sourceId}
       and source.kind = 'sales_order'
     order by line.id
  `,
    "objects",
  );
  const lines = rows.flatMap((line) => {
    const remaining = toQuantityUnits(line.open_quantity);
    return remaining > 0n
      ? [{ sourceLineId: line.id, quantity: fromQuantityUnits(remaining) }]
      : [];
  });
  if (lines.length === 0) {
    const latest = (
      await db.execute<{ id: string; document_number: string }>(
        sql`
      select target.id, target.document_number
        from document_links link
        join documents target
          on target.id = link.to_document_id and target.org_id = link.org_id
       where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
         and link.link_type = 'fulfills' and target.kind = ${SALES_FULFILLMENT_KIND}
       order by target.created_at desc, target.id desc
       limit 1
    `,
        "objects",
      )
    )[0];
    if (!latest) throw new ConversionError("Every line is already fully fulfilled or cancelled");
    return {
      id: latest.id,
      documentNumber: latest.document_number,
      kind: SALES_FULFILLMENT_KIND,
      replayed: true,
    };
  }
  const idempotencyKey = `sales-fulfillment-remainder:${createHash("sha256")
    .update(JSON.stringify({ sourceId, fulfillmentDate, lines }))
    .digest("hex")}`;
  return fulfillSalesOrder(orgId, userId, sourceId, {
    fulfillmentDate,
    idempotencyKey,
    lines,
  });
}
