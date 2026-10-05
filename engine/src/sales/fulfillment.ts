import { sql } from "drizzle-orm";
import { fulfillmentDocuments, fulfillmentLines, type ShipToAddress } from "@openbooks/schema";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalDecimal, isPositiveDecimal } from "../money/exact-decimal.ts";
import { isUuid } from "../platform/uuid.ts";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { openQuantitySql } from "../records/order-line-remainders.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { assertWarehouseAdmitsMovement } from "../inventory/warehouses.ts";
import { getOnHandWith, lockInventoryPosition } from "../inventory/position.ts";
import { pickReservationsCte } from "../inventory/pick-reservations.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Scope = ReadonlySet<string> | null;

export const PICK_LIST_KIND = "pick_list";
export const SHIPMENT_KIND = "shipment";
export type FulfillmentKind = typeof PICK_LIST_KIND | typeof SHIPMENT_KIND;

export type FulfillmentRefusalCode =
  | "feature_disabled"
  | "not_found"
  | "order_not_open"
  | "invalid_input"
  | "invalid_quantity"
  | "not_a_stock_line"
  | "line_without_warehouse"
  | "pick_list_spans_warehouses"
  | "bin_not_in_warehouse"
  | "bin_inactive"
  | "lot_or_serial_mismatch"
  | "exceeds_open_quantity"
  | "bin_short"
  | "approval_routing_failed"
  | "wrong_stage"
  | "shipment_exists"
  | "carrier_invalid"
  | "carrier_required"
  | "changed_concurrently";

/**
 * A pick-list or shipment request the business rules refuse. Carries the
 * HTTP status the route factory answers with, a stable code, and a remedy
 * naming an action that exists.
 */
export class FulfillmentRefusal extends Error {
  readonly name = "FulfillmentRefusal";

  constructor(
    message: string,
    readonly code: FulfillmentRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

const FULFILLMENT_FEATURE = "fulfillment";
export const FULFILLMENT_FEATURES_REMEDY = "Turn on Warehousing and Fulfillment on Company Settings → Features";
export const CARRIERS_REMEDY = "Warehouse → Carriers";

function fulfillmentDisabled(): FulfillmentRefusal {
  return new FulfillmentRefusal(
    "Fulfillment is turned off for this organization",
    "feature_disabled",
    409,
    FULFILLMENT_FEATURES_REMEDY,
  );
}

/**
 * Every fulfilment function asserts the feature first. Fulfillment requires
 * Orders and Warehousing, so the registry resolves it off whenever either is
 * off. The switchboard is read on the caller's runner without a row lock:
 * completion posts, and posting ends by locking the organization row FOR
 * UPDATE, so a writer holding that row FOR SHARE while it waits for the
 * sales order would deadlock against a completion holding the order.
 */
export async function assertFulfillmentFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, FULFILLMENT_FEATURE, runner))) throw fulfillmentDisabled();
}

function notFound(what: string): FulfillmentRefusal {
  return new FulfillmentRefusal(`${what} not found`, "not_found", 404);
}

/** Trim a numeric(28,8) database string for a message: "4.00000000" → "4". */
function shown(quantity: string): string {
  return canonicalDecimal(quantity, 8) ?? quantity;
}

function parseQuantity(raw: unknown, field: string): string {
  const quantity = canonicalDecimal(raw, 8);
  if (quantity === null) {
    throw new FulfillmentRefusal(decimalNullRefusal(field, "a quantity", raw, 8), "invalid_quantity", 422);
  }
  if (!isPositiveDecimal(quantity)) {
    throw new FulfillmentRefusal(`${field} must be greater than zero`, "invalid_quantity", 422, "Enter a positive quantity");
  }
  return quantity;
}

function parseDocumentDate(raw: string | undefined, orgId: string): Promise<string> {
  if (raw === undefined) return businessToday(orgId);
  if (!isIsoCalendarDate(raw)) {
    throw new FulfillmentRefusal("Date must be a valid YYYY-MM-DD date", "invalid_input", 422);
  }
  return Promise.resolve(raw);
}

async function writeAudit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  action: "insert" | "update" | "void",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'fulfillment_documents', ${documentId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`);
  if (written.rows.length === 0) throw new Error("fulfilment change was not audited");
}

interface OrderRow extends Record<string, unknown> {
  id: string;
  kind: string;
  status: string;
  document_number: string;
  party_id: string | null;
  currency: string;
  fx_rate: string;
  subsidiary_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: Record<string, unknown> | null;
}

/** Lock a sales order FOR UPDATE — every order-cycle writer takes the order
 *  before anything that hangs off it. Absent and out-of-scope answer alike. */
async function lockSalesOrder(tx: SqlExecutor, orgId: string, salesOrderId: string, scope: Scope): Promise<OrderRow> {
  const order = (await tx.execute<OrderRow>(sql`
    select id, kind, status, document_number, party_id, currency, fx_rate::text as fx_rate, subsidiary_id,
           department_id, project_id, location_id, class_id, extra_dims
      from documents
     where org_id = ${orgId} and id = ${salesOrderId}
     for update`)).rows[0];
  if (!order || order.kind !== "sales_order" || !subsidiaryScopeAllows(scope, order.subsidiary_id)) {
    throw notFound("Sales order");
  }
  return order;
}

function assertOrderOpen(order: OrderRow): void {
  if (order.status === "approved") return;
  throw new FulfillmentRefusal(
    `${order.document_number} is ${order.status}; only an issued sales order can be picked and shipped`,
    "order_not_open",
    409,
    order.status === "draft" ? `Issue ${order.document_number} first` : undefined,
  );
}

interface FulfillmentDocRow extends Record<string, unknown> {
  id: string;
  kind: string;
  status: string;
  document_number: string;
  document_date: string;
  subsidiary_id: string | null;
  stage: "open" | "done";
  warehouse_id: string;
  carrier_id: string | null;
  carrier_service: string | null;
  tracking_number: string | null;
  sales_fulfillment_id: string | null;
}

/** The upstream documents of a pick list or shipment, read without locks so
 *  the caller can lock them in the canonical order. */
async function upstreamOf(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<{ salesOrderId: string | null; pickListId: string | null }> {
  const row = (await runner.execute<{ sales_order_id: string | null; pick_list_id: string | null }>(sql`
    select (select l.from_document_id from document_links l
             where l.org_id = ${orgId} and l.to_document_id = ${documentId}
               and l.link_type in ('reserves', 'ships') limit 1) as sales_order_id,
           (select l.from_document_id from document_links l
             where l.org_id = ${orgId} and l.to_document_id = ${documentId}
               and l.link_type = 'created_from' limit 1) as pick_list_id`)).rows[0];
  return { salesOrderId: row?.sales_order_id ?? null, pickListId: row?.pick_list_id ?? null };
}

async function lockFulfillmentDocument(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  kind: FulfillmentKind,
  scope: Scope,
): Promise<FulfillmentDocRow> {
  const row = (await tx.execute<FulfillmentDocRow>(sql`
    select d.id, d.kind, d.status, d.document_number, d.document_date::text as document_date, d.subsidiary_id,
           fd.stage, fd.warehouse_id, fd.carrier_id, fd.carrier_service, fd.tracking_number,
           fd.sales_fulfillment_id
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
     where d.org_id = ${orgId} and d.id = ${documentId}
     for update of d, fd`)).rows[0];
  if (!row || row.kind !== kind || !subsidiaryScopeAllows(scope, row.subsidiary_id)) {
    throw notFound(kind === PICK_LIST_KIND ? "Pick list" : "Shipment");
  }
  return row;
}

/** Lock order: sales order, then the pick list, then the shipment. */
async function lockChain(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  kind: FulfillmentKind,
  scope: Scope,
): Promise<{ order: OrderRow; pickList: FulfillmentDocRow; shipment: FulfillmentDocRow | null }> {
  const upstream = await upstreamOf(tx, orgId, documentId);
  const label = kind === PICK_LIST_KIND ? "Pick list" : "Shipment";
  if (!upstream.salesOrderId) throw notFound(label);
  const order = await lockSalesOrder(tx, orgId, upstream.salesOrderId, scope);
  if (kind === PICK_LIST_KIND) {
    return { order, pickList: await lockFulfillmentDocument(tx, orgId, documentId, kind, scope), shipment: null };
  }
  if (!upstream.pickListId) throw notFound(label);
  const pickList = await lockFulfillmentDocument(tx, orgId, upstream.pickListId, PICK_LIST_KIND, scope);
  const shipment = await lockFulfillmentDocument(tx, orgId, documentId, kind, scope);
  return { order, pickList, shipment };
}

interface HeldRow extends Record<string, unknown> {
  sales_order_line_id: string;
  line_number: number;
  item_id: string;
  item_label: string;
  order_item_id: string;
  open: string;
  cap: string;
  reserved: string;
  held_by: string | null;
  requested: string;
  pickable: string;
  fits: boolean;
}

export interface OpenQuantityRequest {
  salesOrderLineId: string;
  quantity: string;
  /** The picked item: the order line's own item, or a kit's component. */
  itemId: string;
}

/**
 * Refuse when a pick request would hold more of an order line than its open
 * quantity leaves after other pick lists. `heldBy` chooses which other pick
 * lists count: every active one when a pick list is created, only released
 * ones when it is released (drafts do not hold stock).
 *
 * Kit component rows are capped in component units — the line's open kit
 * quantity times the recipe quantity — so every component is held against
 * its own requirement, never against the kit count.
 */
async function assertWithinOpenQuantity(
  tx: SqlExecutor,
  orgId: string,
  orderNumber: string,
  requested: OpenQuantityRequest[],
  heldBy: "active" | "released",
  excludePickListId: string | null,
): Promise<void> {
  const rows = (await tx.execute<HeldRow>(sql`
    with ${pickReservationsCte(orgId)},
    requested as (
      select r.sales_order_line_id, r.item_id, sum(r.quantity::numeric) as requested
        from jsonb_to_recordset(${JSON.stringify(
          requested.map((line) => ({ sales_order_line_id: line.salesOrderLineId, item_id: line.itemId, quantity: line.quantity })),
        )}::jsonb) as r(sales_order_line_id uuid, item_id uuid, quantity text)
       group by r.sales_order_line_id, r.item_id
    ),
    held as (
      select sales_order_line_id, item_id, sum(reserved) as reserved,
             string_agg(distinct pick_list_number, ', ' order by pick_list_number) as held_by
        from pick_reservations
       where reserved > 0
         ${heldBy === "released" ? sql`and pick_list_status = 'approved'` : sql``}
         ${excludePickListId ? sql`and pick_list_id <> ${excludePickListId}` : sql``}
       group by sales_order_line_id, item_id
    )
    select q.sales_order_line_id, so.line_number, q.item_id, coalesce(i.code || ' · ' || i.name, i.name) as item_label,
           so.item_id as order_item_id, ${openQuantitySql("so")}::text as open,
           (${openQuantitySql("so")} * coalesce(bom.quantity_per, 1))::text as cap,
           coalesce(h.reserved, 0)::text as reserved, h.held_by, q.requested::text as requested,
           greatest(0, (${openQuantitySql("so")} * coalesce(bom.quantity_per, 1)) - coalesce(h.reserved, 0))::text as pickable,
           q.requested <= (${openQuantitySql("so")} * coalesce(bom.quantity_per, 1)) - coalesce(h.reserved, 0) as fits
      from requested q
      join document_lines so on so.id = q.sales_order_line_id and so.org_id = ${orgId}
      join documents so_doc on so_doc.id = so.document_id and so_doc.org_id = ${orgId}
      join items i on i.id = q.item_id and i.org_id = ${orgId}
      left join bom_components bom
        on bom.org_id = ${orgId}
       and bom.assembly_item_id = so.item_id
       and bom.component_item_id = q.item_id
       and bom.operation_seq is null
       and bom.is_byproduct = false
       and (bom.effective_from is null or bom.effective_from <= so_doc.document_date)
       and (bom.effective_to is null or so_doc.document_date < bom.effective_to)
      left join held h on h.sales_order_line_id = q.sales_order_line_id and h.item_id = q.item_id
     order by so.line_number`)).rows;
  const over = rows.find((row) => !row.fits);
  if (!over) return;
  const heldText = over.held_by ? `, ${shown(over.reserved)} already on ${over.held_by}` : "";
  const kitText = over.item_id !== over.order_item_id
    ? ` component ${over.item_label} (${shown(over.open)} kits open)`
    : "";
  throw new FulfillmentRefusal(
    `${orderNumber} line ${over.line_number}${kitText} has ${shown(over.cap)} open${heldText}; cannot pick ${shown(over.requested)}`,
    "exceeds_open_quantity",
    422,
    isPositiveDecimal(over.pickable)
      ? `Pick at most ${shown(over.pickable)}, or void a pick list holding this line`
      : "Void a pick list holding this line, or leave the line on backorder",
  );
}

export interface PickListLineInput {
  salesOrderLineId: string;
  binId: string;
  quantity: unknown;
  lotId?: string | null;
  serialId?: string | null;
  /**
   * A kit order line is picked by component: this names the kit's component
   * the row covers, in the component's own base units. Refused on any other
   * line — ordinary lines pick themselves.
   */
  kitComponentItemId?: string | null;
}

export interface CreatePickListInput {
  salesOrderId: string;
  documentDate?: string;
  memo?: string | null;
  lines: PickListLineInput[];
  /** Null means unrestricted, by explicit sentinel only. */
  allowedSubsidiaryIds: Scope;
}

export interface CreatedFulfillmentDocument {
  id: string;
  documentNumber: string;
}

interface OrderLineRow extends Record<string, unknown> {
  id: string;
  line_number: number;
  item_id: string | null;
  item_kind: string | null;
  description: string | null;
  unit: string | null;
  stock_location_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: Record<string, unknown> | null;
  is_stock_line: boolean;
  warehouse_id: string | null;
  warehouse_code: string | null;
}

interface BinRow extends Record<string, unknown> {
  id: string;
  code: string;
  is_active: boolean;
  warehouse_id: string | null;
}

/**
 * Create a draft pick list reserving bin stock for an issued sales order's
 * stock lines. Every bin lies inside the warehouse its order line ships
 * from, one pick list serves one warehouse, and the quantity picked for a
 * line never exceeds its open quantity less what other pick lists already
 * hold for it.
 */
export async function createPickList(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: CreatePickListInput,
): Promise<CreatedFulfillmentDocument> {
  await assertFulfillmentFeature(tx, orgId);
  if (input.lines.length === 0) {
    throw new FulfillmentRefusal("Select at least one order line to pick", "invalid_input", 422);
  }
  const documentDate = await parseDocumentDate(input.documentDate, orgId);
  const requested = input.lines.map((line, index) => {
    const kitComponentItemId = line.kitComponentItemId ?? null;
    if (kitComponentItemId !== null && !isUuid(kitComponentItemId)) {
      throw new FulfillmentRefusal(
        `Kit component on pick line ${index + 1} is not a valid item`,
        "invalid_input",
        422,
        "Pick the component from the kit's recipe",
      );
    }
    // Kit components issue into four-decimal stock: a finer pick could never
    // issue. Ordinary picks keep the order's eight-decimal scale.
    if (kitComponentItemId !== null && canonicalDecimal(line.quantity, 4) === null) {
      throw new FulfillmentRefusal(
        `Quantity on pick line ${index + 1} must have at most four decimal places; stock is kept to four`,
        "invalid_quantity",
        422,
        "Enter the component quantity with at most four decimal places",
      );
    }
    return {
      salesOrderLineId: line.salesOrderLineId,
      binId: line.binId,
      lotId: line.lotId ?? null,
      serialId: line.serialId ?? null,
      kitComponentItemId,
      quantity: parseQuantity(line.quantity, `Quantity on pick line ${index + 1}`),
    };
  });
  const seen = new Set<string>();
  for (const line of requested) {
    const key = [line.salesOrderLineId, line.kitComponentItemId ?? "", line.binId, line.lotId ?? "", line.serialId ?? ""].join(":");
    if (seen.has(key)) {
      throw new FulfillmentRefusal(
        "An order line appears twice for the same bin, lot and serial",
        "invalid_input",
        422,
        "Combine the quantities into one pick line",
      );
    }
    seen.add(key);
  }

  const order = await lockSalesOrder(tx, orgId, input.salesOrderId, input.allowedSubsidiaryIds);
  assertOrderOpen(order);

  const lineIds = [...new Set(requested.map((line) => line.salesOrderLineId))];
  const orderLines = (await tx.execute<OrderLineRow>(sql`
    select dl.id, dl.line_number, dl.item_id, i.kind as item_kind,
           dl.description, dl.unit, dl.stock_location_id,
           dl.department_id, dl.project_id, dl.location_id, dl.class_id, dl.extra_dims,
           exists (select 1 from item_inventory_profiles profile
                    where profile.org_id = dl.org_id and profile.item_id = dl.item_id) as is_stock_line,
           wl.id as warehouse_id, wl.code as warehouse_code
      from document_lines dl
      left join items i on i.id = dl.item_id and i.org_id = dl.org_id
      left join stock_locations wl
        on wl.org_id = dl.org_id
       and wl.id = stock_location_warehouse(dl.org_id, dl.stock_location_id)
     where dl.org_id = ${orgId} and dl.document_id = ${order.id}
       and dl.id = any(${`{${lineIds.join(",")}}`}::uuid[])`)).rows;
  const lineById = new Map(orderLines.map((line) => [line.id, line]));
  let warehouse: { id: string; code: string } | null = null;
  for (const id of lineIds) {
    const line = lineById.get(id);
    if (!line) throw notFound("Order line");
    const label = `${order.document_number} line ${line.line_number}`;
    if (!line.is_stock_line || !line.item_id) {
      throw new FulfillmentRefusal(`${label} is not a stock line; only stock lines are picked`, "not_a_stock_line", 422);
    }
    if (!line.warehouse_id || !line.warehouse_code) {
      throw new FulfillmentRefusal(
        `${label} ships from no warehouse`,
        "line_without_warehouse",
        422,
        `Assign a warehouse to ${label} in the order drawer, then pick again`,
      );
    }
    if (warehouse && warehouse.id !== line.warehouse_id) {
      throw new FulfillmentRefusal(
        `The selected lines ship from warehouses ${warehouse.code} and ${line.warehouse_code}`,
        "pick_list_spans_warehouses",
        422,
        "Create one pick list per warehouse",
      );
    }
    warehouse = { id: line.warehouse_id, code: line.warehouse_code };
  }
  if (!warehouse) throw notFound("Order line");

  const binIds = [...new Set(requested.map((line) => line.binId))];
  const bins = new Map((await tx.execute<BinRow>(sql`
    select sl.id, sl.code, sl.is_active, stock_location_warehouse(sl.org_id, sl.id) as warehouse_id
      from stock_locations sl
     where sl.org_id = ${orgId} and sl.id = any(${`{${binIds.join(",")}}`}::uuid[])`)).rows
    .map((bin) => [bin.id, bin]));
  for (const id of binIds) {
    const bin = bins.get(id);
    if (!bin || bin.warehouse_id !== warehouse.id) {
      throw new FulfillmentRefusal(
        `${bin ? `Bin ${bin.code}` : "The selected bin"} is not inside warehouse ${warehouse.code}`,
        "bin_not_in_warehouse",
        422,
        `Choose a bin inside ${warehouse.code}`,
      );
    }
    if (!bin.is_active) {
      throw new FulfillmentRefusal(`Bin ${bin.code} is inactive`, "bin_inactive", 422, `Choose an active bin inside ${warehouse.code}`);
    }
    await assertWarehouseAdmitsMovement(tx, orgId, bin.id, "outbound");
  }

  // Kit lines are picked by component, never as a unit: a kit holds no
  // stock, so a pick row naming the kit itself could never be covered by a
  // bin. Each component row is checked against the recipe effective on the
  // pick date; the shipment re-checks it against the ship date.
  const kitComponentUnits = new Map<string, string | null>();
  const kitLines = requested.filter((line) => lineById.get(line.salesOrderLineId)?.item_kind === "kit");
  if (kitLines.some((line) => line.kitComponentItemId === null)) {
    const direct = kitLines.find((line) => line.kitComponentItemId === null)!;
    throw new FulfillmentRefusal(
      `${order.document_number} line ${lineById.get(direct.salesOrderLineId)!.line_number} is a kit; pick its components, not the kit`,
      "not_a_stock_line",
      422,
      "Add one pick row per kit component instead",
    );
  }
  const nonKitWithComponent = requested.find(
    (line) => line.kitComponentItemId !== null && lineById.get(line.salesOrderLineId)?.item_kind !== "kit",
  );
  if (nonKitWithComponent) {
    throw new FulfillmentRefusal(
      `${order.document_number} line ${lineById.get(nonKitWithComponent.salesOrderLineId)!.line_number} is not a kit; only kit lines are picked by component`,
      "invalid_input",
      422,
      "Remove the component from the pick row",
    );
  }
  for (const line of kitLines) {
    const source = lineById.get(line.salesOrderLineId)!;
    const recipe = (await tx.execute<{ component_item_id: string; unit: string | null }>(sql`
      select b.component_item_id, component.unit
        from bom_components b
        join items component on component.org_id = b.org_id and component.id = b.component_item_id
       where b.org_id = ${orgId} and b.assembly_item_id = ${source.item_id}
         and b.component_item_id = ${line.kitComponentItemId}
         and (b.effective_from is null or b.effective_from <= ${documentDate}::date)
         and (b.effective_to is null or ${documentDate}::date < b.effective_to)
       limit 1`)).rows[0];
    if (!recipe) {
      throw new FulfillmentRefusal(
        `${order.document_number} line ${source.line_number} names a component outside the kit's recipe on ${documentDate}`,
        "lot_or_serial_mismatch",
        422,
        "Pick a component from the kit's current recipe",
      );
    }
    kitComponentUnits.set(line.kitComponentItemId!, recipe.unit);
  }

  for (const line of requested) {
    if (!line.lotId && !line.serialId) continue;
    const source = lineById.get(line.salesOrderLineId)!;
    const itemId = line.kitComponentItemId ?? source.item_id!;
    const matches = (await tx.execute<{ ok: boolean }>(sql`
      select (${line.lotId}::uuid is null or exists (
                select 1 from lots where org_id = ${orgId} and id = ${line.lotId}::uuid and item_id = ${itemId}))
         and (${line.serialId}::uuid is null or exists (
                select 1 from serials where org_id = ${orgId} and id = ${line.serialId}::uuid and item_id = ${itemId})) as ok`)).rows[0];
    if (!matches?.ok) {
      throw new FulfillmentRefusal(
        `The lot or serial chosen for ${order.document_number} line ${source.line_number} is not of that line's ${line.kitComponentItemId ? "component" : "item"}`,
        "lot_or_serial_mismatch",
        422,
        `Choose a lot or serial of the ${line.kitComponentItemId ? "kit component" : "ordered item"}`,
      );
    }
  }

  await assertWithinOpenQuantity(
    tx,
    orgId,
    order.document_number,
    requested.map((line) => ({
      salesOrderLineId: line.salesOrderLineId,
      quantity: line.quantity,
      itemId: line.kitComponentItemId ?? lineById.get(line.salesOrderLineId)!.item_id!,
    })),
    "active",
    null,
  );

  const documentNumber = await allocateDocumentNumber(tx, orgId, PICK_LIST_KIND, "PICK-");
  const pickListId = await insertFulfillmentDocument(tx, orgId, actorId, {
    kind: PICK_LIST_KIND,
    documentNumber,
    documentDate,
    memo: input.memo ?? null,
    order,
    warehouseId: warehouse.id,
    shipToAddress: null,
  });

  let lineNumber = 1;
  for (const line of requested) {
    const source = lineById.get(line.salesOrderLineId)!;
    // A kit component row carries the component — the thing the bin actually
    // holds — while still pointing at the kit's order line. Its unit is the
    // component's own, so the picked quantity reads in the unit it issues in.
    const componentItemId = line.kitComponentItemId;
    const shaped = componentItemId
      ? { ...source, item_id: componentItemId, unit: kitComponentUnits.get(componentItemId) ?? null }
      : source;
    await insertFulfillmentLine(tx, orgId, actorId, pickListId, lineNumber++, shaped, {
      binId: line.binId,
      quantity: line.quantity,
      lotId: line.lotId,
      serialId: line.serialId,
      pickLineId: null,
      carton: null,
    });
  }
  await insertLink(tx, orgId, actorId, order.id, pickListId, "reserves");
  await writeAudit(tx, orgId, actorId, pickListId, "insert", {
    kind: PICK_LIST_KIND,
    documentNumber,
    salesOrderId: order.id,
    warehouseId: warehouse.id,
    stage: "open",
    lines: requested,
  });
  return { id: pickListId, documentNumber };
}

async function insertFulfillmentDocument(
  tx: Tx,
  orgId: string,
  actorId: string,
  doc: {
    kind: FulfillmentKind;
    documentNumber: string;
    documentDate: string;
    memo: string | null;
    order: OrderRow;
    warehouseId: string;
    shipToAddress: ShipToAddress | null;
  },
): Promise<string> {
  const { order } = doc;
  const inserted = (await tx.execute<{ id: string }>(sql`
    insert into documents
      (org_id, kind, document_number, party_id, document_date, currency, fx_rate, status,
       subsidiary_id, department_id, project_id, location_id, class_id, extra_dims, memo,
       subtotal, tax_total, total, created_by, updated_by)
    values
      (${orgId}, ${doc.kind}, ${doc.documentNumber}, ${order.party_id}, ${doc.documentDate},
       ${order.currency}, ${order.fx_rate}, 'draft', ${order.subsidiary_id}, ${order.department_id},
       ${order.project_id}, ${order.location_id}, ${order.class_id},
       ${JSON.stringify(order.extra_dims ?? {})}::jsonb, ${doc.memo}, '0', '0', '0', ${actorId}, ${actorId})
    returning id`)).rows[0];
  if (!inserted) throw new Error("fulfilment document was not recorded");
  const [side] = await tx
    .insert(fulfillmentDocuments)
    .values({
      documentId: inserted.id,
      orgId,
      warehouseId: doc.warehouseId,
      shipToAddress: doc.shipToAddress,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning({ documentId: fulfillmentDocuments.documentId });
  if (!side) throw new Error("fulfilment stage was not recorded");
  return inserted.id;
}

async function insertFulfillmentLine(
  tx: Tx,
  orgId: string,
  actorId: string,
  documentId: string,
  lineNumber: number,
  source: Pick<OrderLineRow, "id" | "item_id" | "description" | "unit" | "department_id" | "project_id" | "location_id" | "class_id" | "extra_dims">,
  detail: {
    binId: string;
    quantity: string;
    lotId: string | null;
    serialId: string | null;
    pickLineId: string | null;
    carton: string | null;
  },
): Promise<string> {
  const line = (await tx.execute<{ id: string }>(sql`
    insert into document_lines
      (org_id, document_id, line_number, item_id, description, quantity, unit, unit_price, amount,
       tax_amount, department_id, project_id, location_id, class_id, extra_dims, stock_location_id,
       is_billable, created_by, updated_by)
    values
      (${orgId}, ${documentId}, ${lineNumber}, ${source.item_id}, ${source.description}, ${detail.quantity},
       ${source.unit}, '0', '0', '0', ${source.department_id}, ${source.project_id}, ${source.location_id},
       ${source.class_id}, ${JSON.stringify(source.extra_dims ?? {})}::jsonb, ${detail.binId}, false,
       ${actorId}, ${actorId})
    returning id`)).rows[0];
  if (!line) throw new Error("fulfilment line was not recorded");
  const [row] = await tx
    .insert(fulfillmentLines)
    .values({
      lineId: line.id,
      orgId,
      documentId,
      salesOrderLineId: source.id,
      pickLineId: detail.pickLineId,
      lotId: detail.lotId,
      serialId: detail.serialId,
      carton: detail.carton,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning({ lineId: fulfillmentLines.lineId });
  if (!row) throw new Error("fulfilment line detail was not recorded");
  return line.id;
}

async function insertLink(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  fromId: string,
  toId: string,
  linkType: "reserves" | "ships" | "created_from",
): Promise<void> {
  const linked = await tx.execute<{ id: string }>(sql`
    insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
    values (${orgId}, ${fromId}, ${toId}, ${linkType}, ${actorId}, ${actorId})
    returning id`);
  if (linked.rows.length === 0) throw new Error("document link was not recorded");
}

interface BinDemandRow extends Record<string, unknown> {
  item_id: string;
  item_label: string;
  bin_id: string;
  bin_code: string;
  requested: string;
  reserved: string;
  held_by: string | null;
}

/** Stock positions (item, bin) a document's lines draw from, sorted into the
 *  canonical fence order. Read without locks. */
async function documentPositions(runner: SqlExecutor, orgId: string, documentId: string): Promise<[string, string][]> {
  const rows = (await runner.execute<{ item_id: string; bin_id: string }>(sql`
    select distinct item_id, stock_location_id as bin_id
      from document_lines
     where org_id = ${orgId} and document_id = ${documentId}
       and item_id is not null and stock_location_id is not null`)).rows;
  return rows
    .map((row): [string, string] => [row.item_id, row.bin_id])
    .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
}

export interface ReleasePickListResult {
  id: string;
  documentNumber: string;
  status: "approved" | "pending_approval";
}

/**
 * Release a draft pick list through Flows. An on_submit approval gate lands
 * it in pending_approval; otherwise it is released to approved and starts
 * holding its bins. Under the position locks every bin must still cover its
 * lines: pickable is on-hand for the order's legal entity less what other
 * released, open pick lists hold on that bin.
 */
export async function releasePickList(
  orgId: string,
  actorId: string,
  input: { pickListId: string; allowedSubsidiaryIds: Scope },
): Promise<ReleasePickListResult> {
  return withOrgTransaction(orgId, async () => {
    // Fence the positions before any row lock (the canonical inventory lock
    // order), so a release and a shipment completion on the same bins
    // serialize instead of deadlocking.
    const positions = await documentPositions(db, orgId, input.pickListId);
    for (const [itemId, binId] of positions) await lockInventoryPosition(db, itemId, binId);
    await assertFulfillmentFeature(db, orgId);
    const { order, pickList } = await lockChain(db, orgId, input.pickListId, PICK_LIST_KIND, input.allowedSubsidiaryIds);
    if (pickList.status !== "draft") {
      throw new FulfillmentRefusal(
        `${pickList.document_number} is ${pickList.status}; only a draft pick list can be released`,
        "wrong_stage",
        409,
      );
    }
    assertOrderOpen(order);

    const lines = (await db.execute<{ sales_order_line_id: string; item_id: string; quantity: string }>(sql`
      select fl.sales_order_line_id, line.item_id, line.quantity::text as quantity
        from fulfillment_lines fl
        join document_lines line on line.id = fl.line_id and line.org_id = fl.org_id
       where fl.org_id = ${orgId} and fl.document_id = ${pickList.id}`)).rows;
    await assertWithinOpenQuantity(
      db,
      orgId,
      order.document_number,
      lines.map((line) => ({ salesOrderLineId: line.sales_order_line_id, quantity: line.quantity, itemId: line.item_id })),
      "released",
      pickList.id,
    );
    await assertBinsCover(db, orgId, pickList, order);

    const submission = await submitAndReleaseIfUngated(PICK_LIST_KIND, pickList.id, actorId);
    if (submission.flowError) {
      throw new FulfillmentRefusal(submission.flowError, "approval_routing_failed", 422, "Correct the approval flow for pick lists, then release again");
    }
    const status = submission.gated ? "pending_approval" : "approved";
    await writeAudit(db, orgId, actorId, pickList.id, "update", {
      mode: "pick_list_released",
      before: { status: pickList.status },
      after: { status },
    });
    return { id: pickList.id, documentNumber: pickList.document_number, status };
  });
}

async function assertBinsCover(tx: SqlExecutor, orgId: string, pickList: FulfillmentDocRow, order: OrderRow): Promise<void> {
  const demand = (await tx.execute<BinDemandRow>(sql`
    with ${pickReservationsCte(orgId)},
    wanted as (
      select line.item_id, line.stock_location_id as bin_id, sum(line.quantity) as requested
        from document_lines line
       where line.org_id = ${orgId} and line.document_id = ${pickList.id}
       group by line.item_id, line.stock_location_id
    ),
    held as (
      select item_id, bin_id, sum(reserved) as reserved,
             string_agg(distinct pick_list_number, ', ' order by pick_list_number) as held_by
        from pick_reservations
       where pick_list_status = 'approved' and pick_list_id <> ${pickList.id} and reserved > 0
       group by item_id, bin_id
    )
    select w.item_id, coalesce(i.code, i.name) as item_label, w.bin_id, bin.code as bin_code,
           w.requested::text as requested, coalesce(h.reserved, 0)::text as reserved, h.held_by
      from wanted w
      join items i on i.id = w.item_id and i.org_id = ${orgId}
      join stock_locations bin on bin.id = w.bin_id and bin.org_id = ${orgId}
      left join held h on h.item_id = w.item_id and h.bin_id = w.bin_id
     order by bin.code, item_label`)).rows;
  const ownerId = order.subsidiary_id ?? (await loadSubsidiaryContext(tx, orgId)).rootId;
  for (const row of demand) {
    const onHand = await getOnHandWith(tx, orgId, row.item_id, row.bin_id, { subsidiaryId: ownerId });
    const check = (await tx.execute<{ fits: boolean; pickable: string }>(sql`
      select ${row.requested}::numeric <= ${onHand.quantity}::numeric - ${row.reserved}::numeric as fits,
             greatest(0, ${onHand.quantity}::numeric - ${row.reserved}::numeric)::text as pickable`)).rows[0]!;
    if (check.fits) continue;
    const heldText = row.held_by ? `, ${shown(row.reserved)} reserved by ${row.held_by}` : "";
    throw new FulfillmentRefusal(
      `Bin ${row.bin_code} holds ${shown(onHand.quantity)} of ${row.item_label}${heldText}; ${pickList.document_number} requests ${shown(row.requested)}`,
      "bin_short",
      409,
      "Pick from another bin, receive or transfer stock into this bin, or ship what is available and leave the rest on backorder",
    );
  }
}

export interface ShipmentLineInput {
  pickLineId: string;
  quantity: unknown;
  carton?: string | null;
}

export interface CreateShipmentInput {
  pickListId: string;
  documentDate?: string;
  memo?: string | null;
  /** Omit to ship every pick line in full. */
  lines?: ShipmentLineInput[];
  allowedSubsidiaryIds: Scope;
}

interface PickLineRow extends OrderLineRow {
  pick_line_id: string;
  pick_line_number: number;
  bin_id: string;
  quantity: string;
  lot_id: string | null;
  serial_id: string | null;
  sales_order_line_id: string;
  reserved: string;
}

function cleanCarton(raw: string | null | undefined): string | null {
  const carton = raw?.trim() ?? "";
  if (carton.length > 60) {
    throw new FulfillmentRefusal("A carton label must be at most 60 characters", "invalid_input", 422, "Shorten the carton label");
  }
  return carton === "" ? null : carton;
}

/**
 * Create a draft shipment from a released pick list: its lines are the
 * picked quantities, each at most what the pick line still reserves, issued
 * later from the pick line's bin. The ship-to address is a snapshot of the
 * customer's default shipping address. A pick list has one live shipment.
 */
export async function createShipment(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: CreateShipmentInput,
): Promise<CreatedFulfillmentDocument> {
  await assertFulfillmentFeature(tx, orgId);
  const documentDate = await parseDocumentDate(input.documentDate, orgId);
  const { order, pickList } = await lockChain(tx, orgId, input.pickListId, PICK_LIST_KIND, input.allowedSubsidiaryIds);
  assertOrderOpen(order);
  if (pickList.status !== "approved" || pickList.stage !== "open") {
    throw new FulfillmentRefusal(
      `${pickList.document_number} is ${pickList.stage === "done" ? "complete" : pickList.status}; only a released, open pick list can be shipped`,
      "wrong_stage",
      409,
      pickList.status === "draft" ? `Release ${pickList.document_number} first` : undefined,
    );
  }
  const existing = (await tx.execute<{ document_number: string }>(sql`
    select s.document_number
      from document_links l
      join documents s on s.id = l.to_document_id and s.org_id = l.org_id
     where l.org_id = ${orgId} and l.from_document_id = ${pickList.id} and l.link_type = 'created_from'
       and s.kind = 'shipment' and s.status <> 'voided'
     limit 1`)).rows[0];
  if (existing) {
    throw new FulfillmentRefusal(
      `${pickList.document_number} already ships on ${existing.document_number}`,
      "shipment_exists",
      409,
      `Open ${existing.document_number}, or void it before creating another shipment`,
    );
  }

  const pickLines = (await tx.execute<PickLineRow & { pick_item_id: string; pick_unit: string | null }>(sql`
    with ${pickReservationsCte(orgId)}
    select line.id as pick_line_id, line.line_number as pick_line_number, line.stock_location_id as bin_id,
           line.quantity::text as quantity, fl.lot_id, fl.serial_id, fl.sales_order_line_id,
           coalesce(r.reserved, 0)::text as reserved,
           line.item_id as pick_item_id, line.unit as pick_unit,
           so.id, so.line_number, so.item_id, so.description, so.unit, so.stock_location_id,
           so.department_id, so.project_id, so.location_id, so.class_id, so.extra_dims,
           true as is_stock_line, null::uuid as warehouse_id, null::text as warehouse_code
      from fulfillment_lines fl
      join document_lines line on line.id = fl.line_id and line.org_id = fl.org_id
      join document_lines so on so.id = fl.sales_order_line_id and so.org_id = fl.org_id
      left join pick_reservations r on r.pick_line_id = line.id
     where fl.org_id = ${orgId} and fl.document_id = ${pickList.id}
     order by line.line_number`)).rows;
  const byId = new Map(pickLines.map((line) => [line.pick_line_id, line]));
  const chosen = input.lines
    ? input.lines.map((line, index) => {
        const pick = byId.get(line.pickLineId);
        if (!pick) throw notFound("Pick line");
        return { pick, quantity: parseQuantity(line.quantity, `Quantity on shipment line ${index + 1}`), carton: cleanCarton(line.carton) };
      })
    : pickLines.filter((pick) => isPositiveDecimal(pick.reserved)).map((pick) => ({ pick, quantity: pick.reserved, carton: null }));
  if (chosen.length === 0) {
    throw new FulfillmentRefusal(
      `${pickList.document_number} holds nothing left to ship`,
      "exceeds_open_quantity",
      409,
      `Void ${pickList.document_number}; its order lines were fulfilled or cancelled another way`,
    );
  }
  const once = new Set<string>();
  for (const { pick, quantity } of chosen) {
    if (once.has(pick.pick_line_id)) {
      throw new FulfillmentRefusal(`Pick line ${pick.pick_line_number} is selected twice`, "invalid_input", 422, "Ship each pick line once");
    }
    once.add(pick.pick_line_id);
    const fits = (await tx.execute<{ fits: boolean }>(sql`select ${quantity}::numeric <= ${pick.reserved}::numeric as fits`)).rows[0]!;
    if (!fits.fits) {
      throw new FulfillmentRefusal(
        `Pick line ${pick.pick_line_number} reserves ${shown(pick.reserved)}; cannot ship ${quantity}`,
        "exceeds_open_quantity",
        422,
        `Ship at most ${shown(pick.reserved)} from pick line ${pick.pick_line_number}`,
      );
    }
  }

  const shipTo = (await tx.execute<ShipToAddress & Record<string, unknown>>(sql`
    select a.label, a.line1, a.line2, a.city, a.region, a.postal_code as "postalCode", a.country
      from addresses a
     where a.org_id = ${orgId} and a.party_id = ${order.party_id} and a.is_default_shipping
     order by a.created_at, a.id
     limit 1`)).rows[0] ?? null;

  const documentNumber = await allocateDocumentNumber(tx, orgId, SHIPMENT_KIND, "SHP-");
  const shipmentId = await insertFulfillmentDocument(tx, orgId, actorId, {
    kind: SHIPMENT_KIND,
    documentNumber,
    documentDate,
    memo: input.memo ?? null,
    order,
    warehouseId: pickList.warehouse_id,
    shipToAddress: shipTo
      ? { label: shipTo.label, line1: shipTo.line1, line2: shipTo.line2, city: shipTo.city, region: shipTo.region, postalCode: shipTo.postalCode, country: shipTo.country }
      : null,
  });
  let lineNumber = 1;
  for (const { pick, quantity, carton } of chosen) {
    // A kit component row ships the component the pick holds: the shipment
    // line carries the component's item and unit with the component quantity,
    // while still pointing at the kit's order line for open-quantity math.
    const shaped = pick.pick_item_id && pick.pick_item_id !== pick.item_id
      ? { ...pick, item_id: pick.pick_item_id, unit: pick.pick_unit }
      : pick;
    await insertFulfillmentLine(tx, orgId, actorId, shipmentId, lineNumber++, shaped, {
      binId: pick.bin_id,
      quantity,
      lotId: pick.lot_id,
      serialId: pick.serial_id,
      pickLineId: pick.pick_line_id,
      carton,
    });
  }
  await insertLink(tx, orgId, actorId, pickList.id, shipmentId, "created_from");
  await insertLink(tx, orgId, actorId, order.id, shipmentId, "ships");
  await writeAudit(tx, orgId, actorId, shipmentId, "insert", {
    kind: SHIPMENT_KIND,
    documentNumber,
    pickListId: pickList.id,
    salesOrderId: order.id,
    stage: "open",
    lines: chosen.map(({ pick, quantity, carton }) => ({ pickLineId: pick.pick_line_id, quantity, carton })),
  });
  return { id: shipmentId, documentNumber };
}

async function lockDraftShipment(tx: SqlExecutor, orgId: string, shipmentId: string, scope: Scope): Promise<FulfillmentDocRow> {
  const { shipment } = await lockChain(tx, orgId, shipmentId, SHIPMENT_KIND, scope);
  if (!shipment || shipment.status !== "draft" || shipment.stage !== "open") {
    const state = shipment?.stage === "done" ? "complete" : shipment?.status;
    throw new FulfillmentRefusal(
      `${shipment?.document_number ?? "The shipment"} is ${state}; only a draft shipment can be changed`,
      "wrong_stage",
      409,
    );
  }
  return shipment;
}

export interface SetShipmentCarrierInput {
  shipmentId: string;
  carrierId: string;
  service: string;
  trackingNumber?: string | null;
  allowedSubsidiaryIds: Scope;
}

/** Choose the carrier, one of its services, and the tracking number of a
 *  draft shipment. */
export async function setShipmentCarrier(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: SetShipmentCarrierInput,
): Promise<void> {
  await assertFulfillmentFeature(tx, orgId);
  const shipment = await lockDraftShipment(tx, orgId, input.shipmentId, input.allowedSubsidiaryIds);
  const carrier = (await tx.execute<{ id: string; code: string; services: string[]; is_active: boolean }>(sql`
    select id, code, services, is_active from carriers
     where org_id = ${orgId} and id = ${input.carrierId}
     for share`)).rows[0];
  if (!carrier || !carrier.is_active) {
    throw new FulfillmentRefusal(
      carrier ? `Carrier ${carrier.code} is inactive` : "Carrier not found",
      "carrier_invalid",
      422,
      `Choose an active carrier, or add one in ${CARRIERS_REMEDY}`,
    );
  }
  const service = input.service.trim();
  if (!carrier.services.includes(service)) {
    throw new FulfillmentRefusal(
      `Carrier ${carrier.code} offers ${carrier.services.join(", ")}, not ${service || "an empty service"}`,
      "carrier_invalid",
      422,
      `Choose one of ${carrier.code}'s services, or add the service in ${CARRIERS_REMEDY}`,
    );
  }
  const tracking = input.trackingNumber?.trim() || null;
  if (tracking && tracking.length > 100) {
    throw new FulfillmentRefusal("A tracking number must be at most 100 characters", "invalid_input", 422);
  }
  const updated = await tx.execute<{ document_id: string }>(sql`
    update fulfillment_documents
       set carrier_id = ${carrier.id}, carrier_service = ${service}, tracking_number = ${tracking},
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${shipment.id} and stage = 'open'
    returning document_id`);
  if (updated.rows.length === 0) {
    throw new FulfillmentRefusal(`${shipment.document_number} changed while its carrier was being set`, "changed_concurrently", 409, "Reload the shipment and try again");
  }
  await writeAudit(tx, orgId, actorId, shipment.id, "update", {
    mode: "shipment_carrier_set",
    before: { carrierId: shipment.carrier_id, carrierService: shipment.carrier_service, trackingNumber: shipment.tracking_number },
    after: { carrierId: carrier.id, carrierService: service, trackingNumber: tracking },
  });
}

/** Record the carton of each line of a draft shipment (null clears it). */
export async function setShipmentCartons(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: { shipmentId: string; cartons: { lineId: string; carton: string | null }[]; allowedSubsidiaryIds: Scope },
): Promise<void> {
  await assertFulfillmentFeature(tx, orgId);
  const shipment = await lockDraftShipment(tx, orgId, input.shipmentId, input.allowedSubsidiaryIds);
  const changes: { lineId: string; before: string | null; after: string | null }[] = [];
  for (const entry of input.cartons) {
    const carton = cleanCarton(entry.carton);
    const updated = (await tx.execute<{ before: string | null }>(sql`
      update fulfillment_lines fl
         set carton = ${carton}, updated_at = now(), updated_by = ${actorId}
        from fulfillment_lines prior
       where fl.org_id = ${orgId} and fl.document_id = ${shipment.id} and fl.line_id = ${entry.lineId}
         and prior.line_id = fl.line_id and prior.org_id = fl.org_id
      returning prior.carton as before`)).rows[0];
    if (!updated) throw notFound("Shipment line");
    changes.push({ lineId: entry.lineId, before: updated.before, after: carton });
  }
  await writeAudit(tx, orgId, actorId, shipment.id, "update", { mode: "shipment_cartons_set", changes });
}

/**
 * Void a pick list before completion. A draft or released pick list stops
 * holding its bins; one awaiting approval is decided in Approvals first, and
 * one already shipping is freed by voiding its draft shipment.
 */
export async function voidPickList(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: { pickListId: string; reason: string; allowedSubsidiaryIds: Scope },
): Promise<void> {
  await assertFulfillmentFeature(tx, orgId);
  const reason = requireReason(input.reason);
  const { pickList } = await lockChain(tx, orgId, input.pickListId, PICK_LIST_KIND, input.allowedSubsidiaryIds);
  assertVoidable(pickList, "Pick list");
  const shipment = (await tx.execute<{ document_number: string }>(sql`
    select s.document_number
      from document_links l
      join documents s on s.id = l.to_document_id and s.org_id = l.org_id
     where l.org_id = ${orgId} and l.from_document_id = ${pickList.id} and l.link_type = 'created_from'
       and s.status <> 'voided'
     limit 1`)).rows[0];
  if (shipment) {
    throw new FulfillmentRefusal(
      `${pickList.document_number} ships on ${shipment.document_number}`,
      "shipment_exists",
      409,
      `Void ${shipment.document_number} first`,
    );
  }
  await markVoided(tx, orgId, actorId, pickList, reason);
}

/** Void a draft shipment; its pick list keeps holding the bins. */
export async function voidShipment(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: { shipmentId: string; reason: string; allowedSubsidiaryIds: Scope },
): Promise<void> {
  await assertFulfillmentFeature(tx, orgId);
  const reason = requireReason(input.reason);
  const { shipment } = await lockChain(tx, orgId, input.shipmentId, SHIPMENT_KIND, input.allowedSubsidiaryIds);
  assertVoidable(shipment!, "Shipment");
  await markVoided(tx, orgId, actorId, shipment!, reason);
}

function requireReason(raw: string): string {
  const reason = raw.trim();
  if (!reason) {
    throw new FulfillmentRefusal("A reason is required to void", "invalid_input", 422, "Enter why the document is being voided");
  }
  return reason;
}

function assertVoidable(doc: FulfillmentDocRow, label: string): void {
  if (doc.stage === "done") {
    throw new FulfillmentRefusal(
      `${doc.document_number} is complete and cannot be voided`,
      "wrong_stage",
      409,
      "Void the sales fulfilment it recorded from the sales order to reverse the shipment",
    );
  }
  if (doc.status === "voided") {
    throw new FulfillmentRefusal(`${doc.document_number} is already voided`, "wrong_stage", 409);
  }
  if (doc.status === "pending_approval") {
    throw new FulfillmentRefusal(
      `${label} ${doc.document_number} is awaiting approval`,
      "wrong_stage",
      409,
      "Reject it in Approvals, then void it",
    );
  }
}

async function markVoided(tx: SqlExecutor, orgId: string, actorId: string, doc: FulfillmentDocRow, reason: string): Promise<void> {
  const voided = await tx.execute<{ id: string }>(sql`
    update documents
       set status = 'voided', voided_at = now(), voided_by = ${actorId}, void_reason = ${reason},
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${doc.id} and status = ${doc.status}
    returning id`);
  if (voided.rows.length === 0) {
    throw new FulfillmentRefusal(`${doc.document_number} changed while it was being voided`, "changed_concurrently", 409, "Reload and try again");
  }
  await writeAudit(tx, orgId, actorId, doc.id, "void", {
    mode: `${doc.kind}_voided`,
    reason,
    before: { status: doc.status },
    after: { status: "voided" },
  });
}

/** A carrier's tracking link for one tracking number, or null when either
 *  is missing. The number is URL-encoded into the `{tracking}` slot. */
export function trackingUrl(template: string | null, trackingNumber: string | null): string | null {
  if (!template || !trackingNumber) return null;
  return template.split("{tracking}").join(encodeURIComponent(trackingNumber));
}

export interface FulfillmentLineView {
  lineId: string;
  lineNumber: number;
  itemId: string;
  itemLabel: string;
  description: string | null;
  binId: string;
  binCode: string;
  quantity: string;
  unit: string | null;
  salesOrderLineId: string;
  salesOrderLineNumber: number;
  lotNumber: string | null;
  serialNumber: string | null;
  pickLineId: string | null;
  carton: string | null;
  /**
   * Set when the row covers a kit's component rather than its order line's
   * own item: the kit it belongs to, so the form nests the row under it.
   */
  kitGroup?: { kitItemId: string; kitLabel: string } | null;
}

export interface FulfillmentDocumentView {
  id: string;
  kind: FulfillmentKind;
  documentNumber: string;
  status: string;
  stage: "open" | "done";
  documentDate: string;
  memo: string | null;
  subsidiaryId: string | null;
  customer: { id: string; name: string } | null;
  salesOrder: { id: string; number: string } | null;
  pickList: { id: string; number: string } | null;
  shipment: { id: string; number: string } | null;
  warehouse: { id: string; code: string; name: string };
  carrier: { id: string; code: string; name: string } | null;
  carrierService: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shipToAddress: ShipToAddress | null;
  salesFulfillment: { id: string; number: string } | null;
  completedAt: string | null;
  lines: FulfillmentLineView[];
}

interface ViewRow extends Record<string, unknown> {
  id: string;
  kind: FulfillmentKind;
  document_number: string;
  status: string;
  stage: "open" | "done";
  document_date: string;
  memo: string | null;
  subsidiary_id: string | null;
  party_id: string | null;
  party_name: string | null;
  sales_order_id: string | null;
  sales_order_number: string | null;
  pick_list_id: string | null;
  pick_list_number: string | null;
  shipment_id: string | null;
  shipment_number: string | null;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  carrier_id: string | null;
  carrier_code: string | null;
  carrier_name: string | null;
  tracking_url_template: string | null;
  carrier_service: string | null;
  tracking_number: string | null;
  ship_to_address: ShipToAddress | null;
  sales_fulfillment_id: string | null;
  sales_fulfillment_number: string | null;
  completed_at: string | null;
}

/**
 * A pick list or shipment with its lines, or null when it does not exist or
 * lies outside the caller's subsidiaries. A read, so it asserts the feature
 * without a lock.
 */
export async function getFulfillmentDocument(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  scope: Scope,
): Promise<FulfillmentDocumentView | null> {
  await assertFulfillmentFeature(runner, orgId);
  const row = (await runner.execute<ViewRow>(sql`
    select d.id, d.kind, d.document_number, d.status, fd.stage, d.document_date::text as document_date, d.memo,
           d.subsidiary_id, d.party_id, p.display_name as party_name,
           so.id as sales_order_id, so.document_number as sales_order_number,
           pick.id as pick_list_id, pick.document_number as pick_list_number,
           ship.id as shipment_id, ship.document_number as shipment_number,
           fd.warehouse_id, wl.code as warehouse_code, w.name as warehouse_name,
           c.id as carrier_id, c.code as carrier_code, c.name as carrier_name, c.tracking_url_template,
           fd.carrier_service, fd.tracking_number, fd.ship_to_address,
           sf.id as sales_fulfillment_id, sf.document_number as sales_fulfillment_number,
           fd.completed_at::text as completed_at
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
      join warehouses w on w.stock_location_id = fd.warehouse_id and w.org_id = fd.org_id
      join stock_locations wl on wl.id = fd.warehouse_id and wl.org_id = fd.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join carriers c on c.id = fd.carrier_id and c.org_id = fd.org_id
      left join documents sf on sf.id = fd.sales_fulfillment_id and sf.org_id = fd.org_id
      left join lateral (
        select up.id, up.document_number from document_links l
          join documents up on up.id = l.from_document_id and up.org_id = l.org_id
         where l.org_id = d.org_id and l.to_document_id = d.id and l.link_type in ('reserves', 'ships')
         limit 1) so on true
      left join lateral (
        select up.id, up.document_number from document_links l
          join documents up on up.id = l.from_document_id and up.org_id = l.org_id
         where l.org_id = d.org_id and l.to_document_id = d.id and l.link_type = 'created_from'
         limit 1) pick on d.kind = 'shipment'
      left join lateral (
        select down.id, down.document_number from document_links l
          join documents down on down.id = l.to_document_id and down.org_id = l.org_id
         where l.org_id = d.org_id and l.from_document_id = d.id and l.link_type = 'created_from'
           and down.kind = 'shipment'
         order by (down.status = 'voided'), down.created_at desc
         limit 1) ship on d.kind = 'pick_list'
     where d.org_id = ${orgId} and d.id = ${documentId} and d.kind in ('pick_list', 'shipment')`)).rows[0];
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiary_id)) return null;
  const lines = (await runner.execute<{
    line_id: string; line_number: number; item_id: string; item_label: string; description: string | null;
    bin_id: string; bin_code: string; quantity: string; unit: string | null; sales_order_line_id: string;
    sales_order_line_number: number; lot_number: string | null; serial_number: string | null;
    pick_line_id: string | null; carton: string | null;
    kit_item_id: string | null; kit_label: string | null;
  }>(sql`
    select line.id as line_id, line.line_number, line.item_id, coalesce(i.code || ' · ' || i.name, i.name) as item_label,
           line.description, line.stock_location_id as bin_id, bin.code as bin_code, line.quantity::text as quantity,
           line.unit, fl.sales_order_line_id, so.line_number as sales_order_line_number,
           lot.lot_number, serial.serial_number, fl.pick_line_id, fl.carton,
           case when line.item_id <> so.item_id then so.item_id end as kit_item_id,
           case when line.item_id <> so.item_id
             then coalesce(kit.code || ' · ' || kit.name, kit.name) end as kit_label
      from document_lines line
      join fulfillment_lines fl on fl.line_id = line.id and fl.org_id = line.org_id
      join document_lines so on so.id = fl.sales_order_line_id and so.org_id = fl.org_id
      join items i on i.id = line.item_id and i.org_id = line.org_id
      join stock_locations bin on bin.id = line.stock_location_id and bin.org_id = line.org_id
      left join items kit on kit.id = so.item_id and kit.org_id = so.org_id
      left join lots lot on lot.id = fl.lot_id
      left join serials serial on serial.id = fl.serial_id
     where line.org_id = ${orgId} and line.document_id = ${row.id}
     order by line.line_number`)).rows;
  const ref = (id: string | null, number: string | null) => (id && number ? { id, number } : null);
  return {
    id: row.id,
    kind: row.kind,
    documentNumber: row.document_number,
    status: row.status,
    stage: row.stage,
    documentDate: row.document_date,
    memo: row.memo,
    subsidiaryId: row.subsidiary_id,
    customer: row.party_id ? { id: row.party_id, name: row.party_name ?? "" } : null,
    salesOrder: ref(row.sales_order_id, row.sales_order_number),
    pickList: ref(row.pick_list_id, row.pick_list_number),
    shipment: ref(row.shipment_id, row.shipment_number),
    warehouse: { id: row.warehouse_id, code: row.warehouse_code, name: row.warehouse_name },
    carrier: row.carrier_id ? { id: row.carrier_id, code: row.carrier_code ?? "", name: row.carrier_name ?? "" } : null,
    carrierService: row.carrier_service,
    trackingNumber: row.tracking_number,
    trackingUrl: trackingUrl(row.tracking_url_template, row.tracking_number),
    shipToAddress: row.ship_to_address,
    salesFulfillment: ref(row.sales_fulfillment_id, row.sales_fulfillment_number),
    completedAt: row.completed_at,
    lines: lines.map((line) => ({
      lineId: line.line_id,
      lineNumber: Number(line.line_number),
      itemId: line.item_id,
      itemLabel: line.item_label,
      description: line.description,
      binId: line.bin_id,
      binCode: line.bin_code,
      quantity: line.quantity,
      unit: line.unit,
      salesOrderLineId: line.sales_order_line_id,
      salesOrderLineNumber: Number(line.sales_order_line_number),
      lotNumber: line.lot_number,
      serialNumber: line.serial_number,
      pickLineId: line.pick_line_id,
      carton: line.carton,
      kitGroup: line.kit_item_id && line.kit_label
        ? { kitItemId: line.kit_item_id, kitLabel: line.kit_label }
        : null,
    })),
  };
}

export interface FulfillmentListRow {
  id: string;
  kind: FulfillmentKind;
  documentNumber: string;
  status: string;
  stage: "open" | "done";
  documentDate: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  warehouseCode: string;
  carrierName: string | null;
  carrierService: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

/** Pick lists or shipments, newest first, narrowed to the caller's
 *  subsidiaries; `open` keeps only those not yet complete or voided. */
export async function listFulfillmentDocuments(
  runner: SqlExecutor,
  orgId: string,
  filter: { kind: FulfillmentKind; openOnly?: boolean; limit?: number; allowedSubsidiaryIds: Scope },
): Promise<FulfillmentListRow[]> {
  await assertFulfillmentFeature(runner, orgId);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = (await runner.execute<{
    id: string; kind: FulfillmentKind; document_number: string; status: string; stage: "open" | "done";
    document_date: string; subsidiary_id: string | null; party_name: string | null; sales_order_number: string | null;
    warehouse_code: string; carrier_name: string | null; carrier_service: string | null; tracking_number: string | null;
    tracking_url_template: string | null;
  }>(sql`
    select d.id, d.kind, d.document_number, d.status, fd.stage, d.document_date::text as document_date,
           d.subsidiary_id, p.display_name as party_name,
           (select so.document_number from document_links l
              join documents so on so.id = l.from_document_id and so.org_id = l.org_id
             where l.org_id = d.org_id and l.to_document_id = d.id and l.link_type in ('reserves', 'ships')
             limit 1) as sales_order_number,
           wl.code as warehouse_code, c.name as carrier_name, fd.carrier_service, fd.tracking_number,
           c.tracking_url_template
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
      join stock_locations wl on wl.id = fd.warehouse_id and wl.org_id = fd.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join carriers c on c.id = fd.carrier_id and c.org_id = fd.org_id
     where d.org_id = ${orgId} and d.kind = ${filter.kind}
       ${filter.openOnly ? sql`and fd.stage = 'open' and d.status <> 'voided'` : sql``}
     order by d.created_at desc, d.id desc
     limit ${limit}`)).rows;
  return rows
    .filter((row) => subsidiaryScopeAllows(filter.allowedSubsidiaryIds, row.subsidiary_id))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      documentNumber: row.document_number,
      status: row.status,
      stage: row.stage,
      documentDate: row.document_date,
      customerName: row.party_name,
      salesOrderNumber: row.sales_order_number,
      warehouseCode: row.warehouse_code,
      carrierName: row.carrier_name,
      carrierService: row.carrier_service,
      trackingNumber: row.tracking_number,
      trackingUrl: trackingUrl(row.tracking_url_template, row.tracking_number),
    }));
}

/**
 * Mark a shipment and its pick list done once the shipment's sales
 * fulfilment is recorded — the pick list's reservation ends in the same
 * transaction the stock leaves. Called by shipment completion, which owns
 * the transaction and has already locked the chain.
 */
export async function markShipmentComplete(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: { shipment: { id: string; documentNumber: string }; pickListId: string; salesFulfillmentId: string },
): Promise<void> {
  const shipment = await tx.execute<{ document_id: string }>(sql`
    update fulfillment_documents
       set stage = 'done', sales_fulfillment_id = ${input.salesFulfillmentId},
           completed_at = now(), completed_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${input.shipment.id} and stage = 'open'
    returning document_id`);
  const released = await tx.execute<{ id: string }>(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${input.shipment.id} and status = 'draft'
    returning id`);
  const pickList = await tx.execute<{ document_id: string }>(sql`
    update fulfillment_documents
       set stage = 'done', completed_at = now(), completed_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${input.pickListId} and stage = 'open'
    returning document_id`);
  if (shipment.rows.length === 0 || released.rows.length === 0 || pickList.rows.length === 0) {
    throw new FulfillmentRefusal(
      `${input.shipment.documentNumber} changed while it was being completed`,
      "changed_concurrently",
      409,
      "Reload the shipment and try again",
    );
  }
  await writeAudit(tx, orgId, actorId, input.shipment.id, "update", {
    mode: "shipment_completed",
    salesFulfillmentId: input.salesFulfillmentId,
    before: { status: "draft", stage: "open" },
    after: { status: "approved", stage: "done" },
  });
  await writeAudit(tx, orgId, actorId, input.pickListId, "update", {
    mode: "pick_list_completed",
    shipmentId: input.shipment.id,
    before: { stage: "open" },
    after: { stage: "done" },
  });
}

export interface ShipmentForCompletion {
  shipment: FulfillmentDocRow;
  pickListId: string;
  salesOrderId: string;
  positions: [string, string][];
  lines: {
    salesOrderLineId: string;
    /** The order line's own item — a kit for kit component rows. */
    orderItemId: string | null;
    /** The shipped item: the order line's item, or a kit's component. */
    itemId: string | null;
    quantity: string;
    binId: string;
    lotId: string | null;
    serialId: string | null;
  }[];
}

/**
 * The completion half the engine owns: fence the shipment's positions, then
 * lock the order, pick list and shipment in the canonical order, and refuse
 * anything that cannot complete. The caller (web completion, which owns the
 * fulfilment path) runs this first inside its transaction.
 */
export async function lockShipmentForCompletion(
  tx: SqlExecutor,
  orgId: string,
  shipmentId: string,
  scope: Scope,
): Promise<ShipmentForCompletion> {
  const positions = await documentPositions(tx, orgId, shipmentId);
  for (const [itemId, binId] of positions) await lockInventoryPosition(tx, itemId, binId);
  await assertFulfillmentFeature(tx, orgId);
  const { order, pickList, shipment } = await lockChain(tx, orgId, shipmentId, SHIPMENT_KIND, scope);
  const locked = shipment!;
  if (locked.stage !== "done") {
    if (locked.status !== "draft") {
      throw new FulfillmentRefusal(`${locked.document_number} is ${locked.status}; it cannot be completed`, "wrong_stage", 409);
    }
    if (!locked.carrier_id || !locked.carrier_service) {
      throw new FulfillmentRefusal(
        `Add a carrier and service to ${locked.document_number} before completing it`,
        "carrier_required",
        422,
        `Set the carrier and service on ${locked.document_number}; carriers are added in ${CARRIERS_REMEDY}`,
      );
    }
    if (pickList.status !== "approved" || pickList.stage !== "open") {
      throw new FulfillmentRefusal(
        `${pickList.document_number} is ${pickList.stage === "done" ? "complete" : pickList.status}; ${locked.document_number} cannot complete`,
        "wrong_stage",
        409,
        `Void ${locked.document_number}`,
      );
    }
    assertOrderOpen(order);
  }
  const lines = (await tx.execute<{
    sales_order_line_id: string; order_item_id: string | null; item_id: string | null;
    quantity: string; bin_id: string; lot_id: string | null; serial_id: string | null;
  }>(sql`
    select fl.sales_order_line_id, so.item_id as order_item_id, line.item_id,
           line.quantity::text as quantity, line.stock_location_id as bin_id,
           fl.lot_id, fl.serial_id
      from fulfillment_lines fl
      join document_lines line on line.id = fl.line_id and line.org_id = fl.org_id
      join document_lines so on so.id = fl.sales_order_line_id and so.org_id = fl.org_id
     where fl.org_id = ${orgId} and fl.document_id = ${locked.id}
     order by line.line_number`)).rows;
  return {
    shipment: locked,
    pickListId: pickList.id,
    salesOrderId: order.id,
    positions,
    lines: lines.map((line) => ({
      salesOrderLineId: line.sales_order_line_id,
      orderItemId: line.order_item_id,
      itemId: line.item_id,
      quantity: line.quantity,
      binId: line.bin_id,
      lotId: line.lot_id,
      serialId: line.serial_id,
    })),
  };
}

/** A pick list's or shipment's scope facts, for a route to check before it
 *  reads or writes the document. Null when no such document exists. */
export async function fulfillmentDocumentScope(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  kind: FulfillmentKind,
): Promise<{ id: string; subsidiaryId: string | null } | null> {
  const row = (await runner.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from documents
     where org_id = ${orgId} and id = ${documentId} and kind = ${kind}`)).rows[0];
  return row ? { id: row.id, subsidiaryId: row.subsidiary_id } : null;
}

export interface PickCandidateLine {
  salesOrderLineId: string;
  lineNumber: number;
  itemId: string;
  itemLabel: string;
  description: string | null;
  unit: string | null;
  warehouseId: string | null;
  warehouseCode: string | null;
  /** Exact numeric(28,8) strings. */
  open: string;
  heldByPickLists: string;
  pickable: string;
  /** Active bins inside the line's warehouse with stock of the item for the
   *  order's legal entity, most stock first. A suggestion: release re-checks
   *  every bin under the position locks. */
  bins: { binId: string; binCode: string; onHand: string }[];
  /**
   * A kit line carries no stock itself: its components, each with the open
   * requirement in component units, what pick lists already hold, and the
   * bins that carry the component. The pick form renders these nested under
   * the kit line; every component ships for the line to ship.
   */
  kitComponents?: KitComponentCandidate[];
}

export interface KitComponentCandidate {
  componentItemId: string;
  componentLabel: string;
  /** Base units of the component per kit. */
  quantityPer: string;
  /** The kit line's open quantity times the recipe, in component units. */
  open: string;
  heldByPickLists: string;
  pickable: string;
  bins: { binId: string; binCode: string; onHand: string }[];
}

/**
 * What an issued sales order still has to pick: each open stock line with
 * its open quantity, what active pick lists already hold, the remainder, and
 * the bins that carry the item. The create-pick-list form starts from this.
 */
export async function pickCandidates(
  runner: SqlExecutor,
  orgId: string,
  salesOrderId: string,
  scope: Scope,
): Promise<{ salesOrderId: string; documentNumber: string; lines: PickCandidateLine[] } | null> {
  await assertFulfillmentFeature(runner, orgId);
  const order = (await runner.execute<{ id: string; document_number: string; status: string; kind: string; subsidiary_id: string | null }>(sql`
    select id, document_number, status, kind, subsidiary_id from documents
     where org_id = ${orgId} and id = ${salesOrderId}`)).rows[0];
  if (!order || order.kind !== "sales_order" || !subsidiaryScopeAllows(scope, order.subsidiary_id)) return null;
  const ownerId = order.subsidiary_id ?? (await loadSubsidiaryContext(runner, orgId)).rootId;
  const orderDate = (await runner.execute<{ document_date: string }>(sql`
    select document_date::text as document_date from documents
     where org_id = ${orgId} and id = ${order.id}`)).rows[0]?.document_date;
  const rows = (await runner.execute<{
    sales_order_line_id: string; line_number: number; item_id: string; item_kind: string; item_label: string; description: string | null;
    unit: string | null; warehouse_id: string | null; warehouse_code: string | null; open: string; held: string; pickable: string;
    bins: { binId: string; binCode: string; onHand: string }[] | null;
  }>(sql`
    with ${pickReservationsCte(orgId)},
    held as (
      select r.sales_order_line_id, sum(r.reserved) as reserved
        from pick_reservations r
        join document_lines so on so.id = r.sales_order_line_id and so.org_id = ${orgId}
       where r.item_id = so.item_id
       group by r.sales_order_line_id
    ),
    lines as (
      select dl.id, dl.line_number, dl.item_id, i.kind as item_kind,
             coalesce(i.code || ' · ' || i.name, i.name) as item_label,
             dl.description, dl.unit, ${openQuantitySql("dl")} as open,
             stock_location_warehouse(dl.org_id, dl.stock_location_id) as warehouse_id
        from document_lines dl
        join items i on i.id = dl.item_id and i.org_id = dl.org_id
        join item_inventory_profiles profile on profile.item_id = dl.item_id and profile.org_id = dl.org_id
       where dl.org_id = ${orgId} and dl.document_id = ${order.id} and ${openQuantitySql("dl")} > 0
    )
    select l.id as sales_order_line_id, l.line_number, l.item_id, l.item_kind, l.item_label, l.description, l.unit,
           l.warehouse_id, wl.code as warehouse_code, l.open::text as open,
           coalesce(h.reserved, 0)::text as held, greatest(0, l.open - coalesce(h.reserved, 0))::text as pickable,
           (select jsonb_agg(jsonb_build_object('binId', b.id, 'binCode', b.code, 'onHand', b.on_hand::text)
                             order by b.on_hand desc, b.code)
              from (select sl.id, sl.code, sum(cl.remaining_quantity) as on_hand
                      from stock_locations sl
                      join cost_layers cl on cl.stock_location_id = sl.id and cl.org_id = sl.org_id
                                         and cl.item_id = l.item_id and cl.subsidiary_id = ${ownerId}
                     where sl.org_id = ${orgId} and sl.is_active
                       and stock_location_warehouse(sl.org_id, sl.id) = l.warehouse_id
                     group by sl.id, sl.code
                    having sum(cl.remaining_quantity) > 0) b) as bins
      from lines l
      left join stock_locations wl on wl.id = l.warehouse_id and wl.org_id = ${orgId}
      left join held h on h.sales_order_line_id = l.id
     order by l.line_number`)).rows;
  const kitComponents = await kitPickComponents(runner, orgId, {
    orderId: order.id,
    orderDate,
    ownerId,
    lines: rows
      .filter((row) => row.item_kind === "kit")
      .map((row) => ({
        salesOrderLineId: row.sales_order_line_id,
        kitItemId: row.item_id,
        open: row.open,
        warehouseId: row.warehouse_id,
      })),
  });
  return {
    salesOrderId: order.id,
    documentNumber: order.document_number,
    lines: rows.map((row) => ({
      salesOrderLineId: row.sales_order_line_id,
      lineNumber: Number(row.line_number),
      itemId: row.item_id,
      itemLabel: row.item_label,
      description: row.description,
      unit: row.unit,
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      open: row.open,
      heldByPickLists: row.held,
      pickable: row.pickable,
      bins: row.bins ?? [],
      ...(row.item_kind === "kit" ? { kitComponents: kitComponents.get(row.sales_order_line_id) ?? [] } : {}),
    })),
  };
}

/**
 * What each open kit line still has to pick, per component: the recipe
 * effective on the order date with the component requirement, what active
 * pick lists already hold for that (line, component), and the bins that
 * carry the component for the order's legal entity.
 */
async function kitPickComponents(
  runner: SqlExecutor,
  orgId: string,
  scope: {
    orderId: string;
    orderDate: string | undefined;
    ownerId: string;
    lines: { salesOrderLineId: string; kitItemId: string; open: string; warehouseId: string | null }[];
  },
): Promise<Map<string, KitComponentCandidate[]>> {
  const out = new Map<string, KitComponentCandidate[]>();
  if (scope.lines.length === 0 || !scope.orderDate) return out;
  const rows = (await runner.execute<{
    sales_order_line_id: string;
    component_item_id: string;
    component_label: string;
    quantity_per: string;
    line_open: string;
    held: string;
    pickable: string;
    bins: { binId: string; binCode: string; onHand: string }[] | null;
  }>(sql`
    with ${pickReservationsCte(orgId)},
    kit_open as (
      select dl.id as sales_order_line_id, dl.item_id as kit_item_id,
             ${openQuantitySql("dl")} as open,
             stock_location_warehouse(dl.org_id, dl.stock_location_id) as warehouse_id
        from document_lines dl
       where dl.org_id = ${orgId} and dl.document_id = ${scope.orderId}
         and dl.id = any(${`{${scope.lines.map((line) => line.salesOrderLineId).join(",")}}`}::uuid[])
         and ${openQuantitySql("dl")} > 0
    ),
    held as (
      select sales_order_line_id, item_id, sum(reserved) as reserved
        from pick_reservations
       group by sales_order_line_id, item_id
    )
    select k.sales_order_line_id, b.component_item_id,
           coalesce(component.code || ' · ' || component.name, component.name) as component_label,
           b.quantity_per::text as quantity_per,
           (k.open * b.quantity_per)::text as line_open,
           coalesce(h.reserved, 0)::text as held,
           greatest(0, (k.open * b.quantity_per) - coalesce(h.reserved, 0))::text as pickable,
           (select jsonb_agg(jsonb_build_object('binId', bins.id, 'binCode', bins.code, 'onHand', bins.on_hand::text)
                             order by bins.on_hand desc, bins.code)
              from (select sl.id, sl.code, sum(cl.remaining_quantity) as on_hand
                      from stock_locations sl
                      join cost_layers cl on cl.stock_location_id = sl.id and cl.org_id = sl.org_id
                                         and cl.item_id = b.component_item_id and cl.subsidiary_id = ${scope.ownerId}
                     where sl.org_id = ${orgId} and sl.is_active
                       and stock_location_warehouse(sl.org_id, sl.id) = k.warehouse_id
                     group by sl.id, sl.code
                    having sum(cl.remaining_quantity) > 0) bins) as bins
      from kit_open k
      join bom_components b
        on b.org_id = ${orgId}
       and b.assembly_item_id = k.kit_item_id
       and b.operation_seq is null
       and b.is_byproduct = false
       and (b.effective_from is null or b.effective_from <= ${scope.orderDate}::date)
       and (b.effective_to is null or ${scope.orderDate}::date < b.effective_to)
      join items component on component.id = b.component_item_id and component.org_id = ${orgId}
      left join held h on h.sales_order_line_id = k.sales_order_line_id and h.item_id = b.component_item_id
     order by k.sales_order_line_id, b.sort_order, b.component_item_id`)).rows;
  for (const row of rows) {
    const list = out.get(row.sales_order_line_id) ?? [];
    list.push({
      componentItemId: row.component_item_id,
      componentLabel: row.component_label,
      quantityPer: row.quantity_per,
      open: row.line_open,
      heldByPickLists: row.held,
      pickable: row.pickable,
      bins: row.bins ?? [],
    });
    out.set(row.sales_order_line_id, list);
  }
  return out;
}
