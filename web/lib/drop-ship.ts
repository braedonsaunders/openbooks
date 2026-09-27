import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { add, cmp } from "@openbooks/engine/src/money/money.ts";
import { canonicalDecimal } from "@openbooks/engine/src/money/exact-decimal.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  assertDropShippingFeature,
  applyDropShipConfirmationInventory,
  attachDropShipPurchaseOrderInTx,
  DropShipRefusal,
  type DropShipLinePair,
} from "@openbooks/engine/src/sales/drop-ship.ts";
import { receivePurchaseOrderInTx, fulfillSalesOrderInTx } from "./order-cycle";
import { createApplicationOrder } from "./application/orders";
import { assertApplicationPermission, assertSubsidiaryAccess, type ApplicationContext } from "./application/context";
import { invalidInput, notFound } from "./application/errors";
import { isUuid } from "./list-params";
import { isIsoCalendarDate, businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { openQuantitySql } from "@openbooks/engine/src/records/order-line-remainders.ts";
import { fromQuantityUnits, orderLineAmount, toQuantityUnits } from "./order-cycle-math";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RoutedSourceLine = {
  sales_order_line_id: string;
  line_number: number;
  item_id: string;
  item_name: string;
  description: string | null;
  quantity: string;
  suggested_unit_cost: string | null;
  unit: string | null;
  stock_location_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  extra_dims: Record<string, unknown> | null;
  open_quantity: string;
  purchase_order_line_id: string | null;
};

async function routedLines(
  tx: Tx,
  orgId: string,
  salesOrderId: string,
): Promise<RoutedSourceLine[]> {
  return (await tx.execute<RoutedSourceLine>(sql`
    select dl.id as sales_order_line_id, dl.line_number, dl.item_id, dl.description,
           dl.quantity::text as quantity, dl.unit, dl.stock_location_id,
           dl.department_id, dl.project_id, dl.location_id, dl.extra_dims,
           i.name as item_name, coalesce(i.default_cost, profile.standard_cost)::text as suggested_unit_cost,
           ${openQuantitySql("dl")}::text as open_quantity,
           routed.purchase_order_line_id
      from drop_ship_lines routed
      join document_lines dl on dl.id = routed.sales_order_line_id and dl.org_id = routed.org_id
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
      left join item_inventory_profiles profile on profile.org_id = dl.org_id and profile.item_id = dl.item_id
     where routed.org_id = ${orgId} and dl.document_id = ${salesOrderId}
     order by dl.line_number
     for update of routed, dl`)).rows;
}

function ensureDropShipLineCanBeOrdered(lines: RoutedSourceLine[]): void {
  if (lines.length === 0) {
    throw new DropShipRefusal(
      "This sales order has no routed stock lines",
      "no_routed_lines",
      409,
      "Route one or more unfulfilled stock lines before creating the drop-ship purchase order",
    );
  }
  const blocked = lines.find((line) => line.purchase_order_line_id || cmp(line.open_quantity, "0") <= 0);
  if (blocked) {
    throw new DropShipRefusal(
      `Sales-order line ${blocked.line_number} is already assigned or has no open quantity`,
      "line_not_open",
      409,
      "Unroute an unassigned line or use its existing drop-ship purchase order",
    );
  }
  const uncosted = lines.find((line) => line.suggested_unit_cost == null);
  if (uncosted) {
    throw new DropShipRefusal(
      `Item ${uncosted.item_name} has no configured purchase cost for its drop-ship line`,
      "item_cost_required",
      422,
      "Set the item's default cost or standard cost in its Costing profile, then create the purchase order again",
    );
  }
}

export async function routeSalesOrderLine(
  context: ApplicationContext,
  input: { salesOrderId: string; salesOrderLineId: string; routed: boolean },
): Promise<{ routed: boolean }> {
  assertApplicationPermission(context, "orders.fulfill");
  await assertDropShippingFeature(db, context.authz.user.orgId);
  const routeInput = {
    orgId: context.authz.user.orgId,
    actorId: context.authz.user.id,
    salesOrderId: input.salesOrderId,
    salesOrderLineId: input.salesOrderLineId,
    allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
  };
  const engine = await import("@openbooks/engine/src/sales/drop-ship.ts");
  if (input.routed) await engine.routeDropShipLine(routeInput);
  else await engine.unrouteDropShipLine(routeInput);
  return { routed: input.routed };
}

export async function dropShipRecordScope(
  orgId: string,
  documentId: string,
  kind: "sales_order" | "purchase_order",
): Promise<{ subsidiaryId: string | null } | null> {
  if (kind === "sales_order") {
    const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from documents
       where org_id = ${orgId} and id = ${documentId} and kind = 'sales_order'`)).rows[0];
    return row ? { subsidiaryId: row.subsidiary_id } : null;
  }
  const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
    select d.subsidiary_id
      from documents d join drop_ship_orders ds
        on ds.org_id = d.org_id and ds.purchase_order_id = d.id
     where d.org_id = ${orgId} and d.id = ${documentId} and d.kind = 'purchase_order'`)).rows[0];
  return row ? { subsidiaryId: row.subsidiary_id } : null;
}

export async function createDropShipPurchaseOrder(
  context: ApplicationContext,
  input: { salesOrderId: string; vendorId: string; idempotencyKey: string },
): Promise<{ id: string; documentNumber: string; replayed: boolean }> {
  const orgId = context.authz.user.orgId;
  const userId = context.authz.user.id;
  assertApplicationPermission(context, "ap.create");
  await assertDropShippingFeature(db, orgId);
  if (!isUuid(input.salesOrderId) || !isUuid(input.vendorId)) throw invalidInput("salesOrderId and vendorId must be UUIDs");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 500) throw invalidInput("Idempotency key must be between 1 and 500 characters");

  const source = (await db.execute<{ id: string; status: string; subsidiary_id: string | null; party_id: string | null }>(sql`
    select id, status, subsidiary_id, party_id from documents
     where org_id = ${orgId} and id = ${input.salesOrderId} and kind = 'sales_order'`)).rows[0];
  if (!source) throw notFound("sales order");
  assertSubsidiaryAccess(context, source.subsidiary_id);
  if (source.status !== "approved") throw new DropShipRefusal("Issue the sales order before creating its drop-ship purchase order", "order_not_open", 409, "Issue the sales order, then retry");
  const vendor = (await db.execute<{ subsidiary_id: string | null }>(sql`
    select p.subsidiary_id
      from parties p
      join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
     where p.org_id = ${orgId} and p.id = ${input.vendorId} and p.is_active`)).rows[0];
  if (!vendor) throw invalidInput("Choose an active vendor");
  assertSubsidiaryAccess(context, vendor.subsidiary_id);
  const shipTo = source.party_id == null ? null : (await db.execute<Record<string, unknown>>(sql`
    select a.label, a.line1, a.line2, a.city, a.region, a.postal_code as "postalCode", a.country
      from addresses a
     where a.org_id = ${orgId} and a.party_id = ${source.party_id} and a.is_default_shipping
     order by a.created_at, a.id limit 1`)).rows[0] ?? null;
  if (!shipTo) {
    throw new DropShipRefusal(
      "The customer has no default shipping address for this drop-ship order",
      "ship_to_required",
      422,
      "Add a default shipping address to the customer, then create the purchase order again",
    );
  }

  const create = await createApplicationOrder(context, {
    kind: "purchase_order",
    idempotencyKey: input.idempotencyKey,
    subsidiaryId: source.subsidiary_id,
  });
  const purchaseOrderId = create.result.id;
  const command = {
    salesOrderId: input.salesOrderId,
    vendorId: input.vendorId,
    salesOrderLineIds: [] as string[],
  };
  const result = await db.transaction(async (tx) => {
    const po = (await tx.execute<{ id: string; document_number: string; kind: string; status: string; custom: Record<string, unknown> | null }>(sql`
      select id, document_number, kind, status, custom from documents
       where org_id = ${orgId} and id = ${purchaseOrderId} for update`)).rows[0];
    if (!po || po.kind !== "purchase_order") throw notFound("purchase order");
    const so = (await tx.execute<{ id: string; status: string; subsidiary_id: string | null; party_id: string | null }>(sql`
      select id, status, subsidiary_id, party_id from documents
       where org_id = ${orgId} and id = ${input.salesOrderId} for update`)).rows[0];
    if (!so || so.status !== "approved" || so.subsidiary_id !== source.subsidiary_id) throw notFound("sales order");
    const prior = po.custom?.dropShip as { salesOrderId?: unknown; vendorId?: unknown } | undefined;
    if (prior) {
      if (prior.salesOrderId !== input.salesOrderId || prior.vendorId !== input.vendorId) {
        throw new DropShipRefusal("This idempotency key already created a different drop-ship purchase order", "idempotency_key_conflict", 409, "Retry with the original sales order and vendor, or choose a new idempotency key");
      }
      return { id: po.id, documentNumber: po.document_number, replayed: true };
    }
    if (po.status !== "draft") throw new DropShipRefusal("The purchase order draft has already advanced", "order_not_open", 409, "Open the existing purchase order and continue its current lifecycle");
    const lines = await routedLines(tx, orgId, input.salesOrderId);
    ensureDropShipLineCanBeOrdered(lines);
    command.salesOrderLineIds = lines.map((line) => line.sales_order_line_id);
    const marker = JSON.stringify({ dropShip: { salesOrderId: input.salesOrderId, vendorId: input.vendorId, command } });
    const updated = await tx.execute<{ id: string }>(sql`
      update documents
         set party_id = ${input.vendorId}, custom = coalesce(custom, '{}'::jsonb) || ${marker}::jsonb,
             updated_by = ${userId}
       where org_id = ${orgId} and id = ${purchaseOrderId} and kind = 'purchase_order' and status = 'draft'
      returning id`);
    if (updated.rows.length !== 1) throw new DropShipRefusal("Purchase order changed while being prepared", "changed_concurrently", 409, "Reload the purchase order and retry");
    const pairs: DropShipLinePair[] = [];
    let lineNumber = 1;
    let subtotal = "0";
    for (const line of lines) {
      const unitPrice = line.suggested_unit_cost!;
      const amount = orderLineAmount(line.open_quantity, unitPrice);
      subtotal = add(subtotal, amount);
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, description, quantity, unit,
           unit_price, amount, tax_amount, department_id, project_id, location_id,
           extra_dims, stock_location_id, is_billable, custom, created_by, updated_by)
        values
          (${orgId}, ${purchaseOrderId}, ${lineNumber}, ${line.item_id}, ${line.description},
           ${line.open_quantity}, ${line.unit}, ${unitPrice}, ${amount}, '0', ${line.department_id}, ${line.project_id},
           ${line.location_id}, ${JSON.stringify(line.extra_dims ?? {})}::jsonb, ${line.stock_location_id},
           false, ${JSON.stringify({ dropShip: { salesOrderLineId: line.sales_order_line_id } })}::jsonb,
           ${userId}, ${userId})
        returning id`);
      if (inserted.rows.length !== 1) throw new Error("drop-ship purchase-order line was not created");
      pairs.push({ salesOrderLineId: line.sales_order_line_id, purchaseOrderLineId: inserted.rows[0]!.id });
      lineNumber++;
    }
    const totals = await tx.execute<{ id: string }>(sql`
      update documents set subtotal = ${subtotal}, tax_total = '0', total = ${subtotal}, updated_by = ${userId}
       where org_id = ${orgId} and id = ${purchaseOrderId} and status = 'draft'
      returning id`);
    if (totals.rows.length !== 1) throw new DropShipRefusal("Purchase order changed while totals were saved", "changed_concurrently", 409, "Reload the purchase order and retry");
    const after = (await tx.execute<Record<string, unknown>>(sql`
      select id, kind, party_id, status, custom from documents where org_id = ${orgId} and id = ${purchaseOrderId}`)).rows[0];
    const audited = await tx.execute<{ id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'documents', ${purchaseOrderId}, 'update',
        ${JSON.stringify({ before: { partyId: null, lineCount: 0 }, after: { partyId: input.vendorId, lineCount: pairs.length, dropShip: command } })}::jsonb,
        ${userId}) returning id`);
    if (audited.rows.length !== 1 || !after) throw new Error("drop-ship purchase order was not audited");
    const linked = await tx.execute<{ from_document_id: string }>(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${input.salesOrderId}, ${purchaseOrderId}, 'created_from', ${userId})
      returning from_document_id`);
    if (linked.rows.length !== 1) throw new Error("drop-ship purchase order origin was not recorded");
    await attachDropShipPurchaseOrderInTx(tx, {
      orgId,
      actorId: userId,
      salesOrderId: input.salesOrderId,
      purchaseOrderId,
      shipToAddress: shipTo,
      lines: pairs,
      allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
    });
    return { id: purchaseOrderId, documentNumber: po.document_number, replayed: false };
  });
  return { ...result, replayed: result.replayed || create.replayed };
}

export interface ConfirmDropShipInput {
  purchaseOrderId: string;
  confirmationDate?: string;
  idempotencyKey: string;
  lines: Array<{ purchaseOrderLineId: string; quantity: string }>;
}

function childKey(parent: string, side: string): string {
  return `dropship-${side}-${createHash("sha256").update(parent).digest("hex")}`;
}

export async function confirmDropShip(
  context: ApplicationContext,
  input: ConfirmDropShipInput,
): Promise<{
  purchaseReceipt: { id: string; documentNumber: string };
  salesFulfillment: { id: string; documentNumber: string };
  replayed: boolean;
}> {
  const orgId = context.authz.user.orgId;
  const userId = context.authz.user.id;
  assertApplicationPermission(context, "items.post");
  await assertDropShippingFeature(db, orgId);
  if (!isUuid(input.purchaseOrderId)) throw invalidInput("purchaseOrderId must be a UUID");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 500) throw invalidInput("Idempotency key must be between 1 and 500 characters");
  const confirmationDate = input.confirmationDate ?? await businessToday(orgId);
  if (!isIsoCalendarDate(confirmationDate)) throw invalidInput("confirmationDate must be a valid YYYY-MM-DD date");
  if (input.lines.length === 0) throw invalidInput("Select at least one purchase-order line to confirm");
  const seenLineIds = new Set<string>();
  const normalizedLines = input.lines.map((line) => {
    if (!isUuid(line.purchaseOrderLineId)) throw invalidInput("purchaseOrderLineId must be a UUID");
    if (seenLineIds.has(line.purchaseOrderLineId)) throw invalidInput("A purchase-order line may be confirmed once per shipment");
    seenLineIds.add(line.purchaseOrderLineId);
    const quantity = canonicalDecimal(line.quantity, 8);
    if (quantity === null || toQuantityUnits(quantity) <= 0n) throw invalidInput("Confirmation quantities must be positive decimals with at most 8 places");
    return { purchaseOrderLineId: line.purchaseOrderLineId, quantity: fromQuantityUnits(toQuantityUnits(quantity)) };
  }).sort((a, b) => a.purchaseOrderLineId.localeCompare(b.purchaseOrderLineId));

  return db.transaction(async (tx) => {
    await assertDropShippingFeature(tx, orgId);
    const po = (await tx.execute<{ id: string; kind: string; status: string; subsidiary_id: string | null }>(sql`
      select id, kind, status, subsidiary_id from documents
       where org_id = ${orgId} and id = ${input.purchaseOrderId} for update`)).rows[0];
    if (!po || po.kind !== "purchase_order") throw notFound("purchase order");
    assertSubsidiaryAccess(context, po.subsidiary_id);
    if (po.status !== "approved") throw new DropShipRefusal("Issue the drop-ship purchase order before confirming vendor shipment", "order_not_open", 409, "Issue the purchase order, then confirm the vendor shipment");
    const link = (await tx.execute<{ sales_order_id: string }>(sql`
      select sales_order_id from drop_ship_orders where org_id = ${orgId} and purchase_order_id = ${input.purchaseOrderId}`)).rows[0];
    if (!link) throw new DropShipRefusal("Purchase order is not a drop-ship order", "not_found", 404);
    const so = (await tx.execute<{ id: string; kind: string; status: string; subsidiary_id: string | null }>(sql`
      select id, kind, status, subsidiary_id from documents
       where org_id = ${orgId} and id = ${link.sales_order_id} for update`)).rows[0];
    if (!so || so.kind !== "sales_order" || so.status !== "approved" || so.subsidiary_id !== po.subsidiary_id) {
      throw new DropShipRefusal("Sales order not found or is no longer open", "not_found", 404);
    }
    assertSubsidiaryAccess(context, so.subsidiary_id);

    const expectedReceiptCommand = {
      receiptDate: confirmationDate,
      lines: normalizedLines.map((line) => ({
        sourceLineId: line.purchaseOrderLineId,
        quantity: line.quantity,
        lotId: null,
        serialId: null,
      })),
      dropShipConfirmation: { idempotencyKey: input.idempotencyKey },
    };
    const prior = (await tx.execute<{
      receipt_id: string;
      receipt_number: string;
      fulfillment_id: string;
      fulfillment_number: string;
      command_matches: boolean;
    }>(sql`
      select receipt.id as receipt_id, receipt.document_number as receipt_number,
             fulfillment.id as fulfillment_id, fulfillment.document_number as fulfillment_number,
             receipt.custom->'purchaseReceiptCommand' = ${JSON.stringify(expectedReceiptCommand)}::jsonb as command_matches
        from document_links receipt_link
        join documents receipt on receipt.org_id = receipt_link.org_id and receipt.id = receipt_link.to_document_id
        join documents fulfillment on fulfillment.org_id = receipt.org_id
          and fulfillment.custom->'dropShipConfirmation'->>'purchaseReceiptId' = receipt.id::text
        join document_links fulfillment_link on fulfillment_link.org_id = fulfillment.org_id
          and fulfillment_link.from_document_id = ${so.id}
          and fulfillment_link.to_document_id = fulfillment.id
          and fulfillment_link.link_type = 'fulfills'
       where receipt_link.org_id = ${orgId} and receipt_link.from_document_id = ${input.purchaseOrderId}
         and receipt_link.to_document_id = receipt.id and receipt_link.link_type = 'fulfills'
         and receipt.kind = 'purchase_receipt' and receipt.status = 'approved'
         and fulfillment.kind = 'sales_fulfillment' and fulfillment.status = 'approved'
         and receipt.custom->'dropShipConfirmation'->>'idempotencyKey' = ${input.idempotencyKey}
       limit 1
    `)).rows[0];
    if (prior) {
      if (!prior.command_matches) {
        throw new DropShipRefusal(
          "This idempotency key already confirms a different vendor shipment",
          "idempotency_key_conflict",
          409,
          "Retry with the original date and quantities, or use a new idempotency key for another shipment",
        );
      }
      return {
        purchaseReceipt: { id: prior.receipt_id, documentNumber: prior.receipt_number },
        salesFulfillment: { id: prior.fulfillment_id, documentNumber: prior.fulfillment_number },
        replayed: true,
      };
    }

    const selectedPoLines: Array<{ sourceLineId: string; quantity: string }> = [];
    const selectedSoLines: Array<{ sourceLineId: string; quantity: string }> = [];
    for (const requested of normalizedLines) {
      const quantity = requested.quantity;
      const pair = (await tx.execute<{
        po_line_id: string;
        so_line_id: string;
        po_line_number: number;
        item_id: string;
        item_name: string;
        quantity: string;
        fulfilled: string;
        cancelled: string;
      }>(sql`
        select pol.id as po_line_id, routed.sales_order_line_id as so_line_id,
               pol.line_number as po_line_number, pol.item_id, i.name as item_name,
               pol.quantity::text as quantity, pol.quantity_fulfilled::text as fulfilled,
               pol.quantity_cancelled::text as cancelled
          from drop_ship_lines routed
          join document_lines pol on pol.id = routed.purchase_order_line_id and pol.org_id = routed.org_id
          join document_lines sol on sol.id = routed.sales_order_line_id and sol.org_id = routed.org_id
          join items i on i.id = pol.item_id and i.org_id = pol.org_id
         where routed.org_id = ${orgId} and routed.purchase_order_line_id = ${requested.purchaseOrderLineId}
           and pol.document_id = ${input.purchaseOrderId} and sol.document_id = ${so.id}
         for update of routed, pol, sol`)).rows[0];
      if (!pair) throw new DropShipRefusal("Purchase-order line is not paired with a routed sales-order line", "invalid_pairing", 422, "Use a line created from this drop-ship sales order");
      const open = toQuantityUnits(pair.quantity) - toQuantityUnits(pair.fulfilled) - toQuantityUnits(pair.cancelled);
      if (open <= 0n || toQuantityUnits(quantity) > open) {
        throw new DropShipRefusal(
          `Purchase-order line ${pair.po_line_number} has only ${fromQuantityUnits(open > 0n ? open : 0n)} open to confirm`,
          "exceeds_open_quantity",
          422,
          "Enter a quantity no greater than the purchase-order line's remaining quantity",
        );
      }
      const profile = (await tx.execute<{
        item_id: string;
        received_not_billed_account_id: string | null;
        cogs_account_id: string | null;
      }>(sql`
        select item_id, received_not_billed_account_id, cogs_account_id
          from item_inventory_profiles
         where org_id = ${orgId} and item_id = ${pair.item_id}
         for update
      `)).rows[0];
      if (!profile) {
        throw new DropShipRefusal(
          `Item ${pair.item_name} has no inventory costing profile`,
          "item_profile_required",
          422,
          `Open Items, select ${pair.item_name}, and configure its Costing profile before confirming the shipment`,
        );
      }
      if (!profile.received_not_billed_account_id) {
        throw new DropShipRefusal(
          `Item ${pair.item_name} is missing its received-not-billed account`,
          "received_not_billed_account_required",
          422,
          `Open Items, select ${pair.item_name}, set the received-not-billed account in its Costing profile, and retry`,
        );
      }
      if (!profile.cogs_account_id) {
        throw new DropShipRefusal(
          `Item ${pair.item_name} is missing its COGS account`,
          "cogs_account_required",
          422,
          `Open Items, select ${pair.item_name}, set the COGS account in its Costing profile, and retry`,
        );
      }
      selectedPoLines.push({ sourceLineId: pair.po_line_id, quantity });
      selectedSoLines.push({ sourceLineId: pair.so_line_id, quantity });
    }
    const receipt = await receivePurchaseOrderInTx(tx, orgId, userId, input.purchaseOrderId, {
      receiptDate: confirmationDate,
      idempotencyKey: childKey(input.idempotencyKey, "receipt"),
      lines: selectedPoLines,
      dropShipConfirmation: { idempotencyKey: input.idempotencyKey },
    }, { inventory: "none" });
    const fulfillment = await fulfillSalesOrderInTx(tx, orgId, userId, so.id, {
      fulfillmentDate: confirmationDate,
      idempotencyKey: childKey(input.idempotencyKey, "fulfillment"),
      lines: selectedSoLines,
      dropShipConfirmation: { purchaseReceiptId: receipt.id },
    }, { inventory: "none" });
    await applyDropShipConfirmationInventory(tx, orgId, userId, receipt.id);
    return {
      purchaseReceipt: { id: receipt.id, documentNumber: receipt.documentNumber },
      salesFulfillment: { id: fulfillment.id, documentNumber: fulfillment.documentNumber },
      replayed: Boolean(receipt.replayed && fulfillment.replayed),
    };
  });
}
