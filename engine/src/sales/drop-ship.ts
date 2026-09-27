import { sql } from "drizzle-orm";
import { cmp, neg } from "../money/money.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { db, type SqlExecutor } from "../platform/db.ts";
import { openQuantitySql } from "../records/order-line-remainders.ts";
import { assertMovementOwner } from "../inventory/profile-policy.ts";
import { InventoryError, type Runner } from "../inventory/contracts.ts";
import { postInventoryEntry, stockLocationDim } from "../inventory/journal.ts";
import { periodForDate, primaryBookId, subsidiaryCurrency } from "../inventory/position.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";

type Scope = ReadonlySet<string> | null;

export type DropShipRefusalCode =
  | "feature_disabled"
  | "not_found"
  | "order_not_open"
  | "not_a_stock_line"
  | "already_routed"
  | "already_fulfilled"
  | "purchase_order_exists"
  | "invalid_pairing"
  | "no_routed_lines"
  | "line_not_open"
  | "ship_to_required"
  | "exceeds_open_quantity"
  | "item_profile_required"
  | "received_not_billed_account_required"
  | "cogs_account_required"
  | "item_cost_required"
  | "accounting_period_required"
  | "confirmation_not_ready"
  | "idempotency_key_conflict"
  | "changed_concurrently";

/** A drop-ship rule refusal with a stable code, status, and operator remedy. */
export class DropShipRefusal extends Error {
  readonly name = "DropShipRefusal";

  constructor(
    message: string,
    readonly code: DropShipRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy = "Reload the order and retry the action",
  ) {
    super(message);
  }
}

const FEATURE = "dropShipping";
const FEATURE_REMEDY = "Turn on Drop Shipping on Company Settings → Features";

function disabled(): DropShipRefusal {
  return new DropShipRefusal("Drop Shipping is turned off for this organization", "feature_disabled", 409, FEATURE_REMEDY);
}

/** Every drop-ship entry point checks the feature before reading its records. */
export async function assertDropShippingFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, FEATURE, runner))) throw disabled();
}

type DropShipPostingLine = Record<string, unknown> & {
  line_id: string;
  line_number: number;
  item_id: string;
  amount: string;
  cogs_account_id: string | null;
  clearing_account_id: string | null;
  has_profile: boolean;
  is_routed: boolean;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  stock_location_id: string | null;
  item_name: string;
};

/**
 * Post the vendor-shipped value directly from received-not-billed to COGS.
 * The receipt line amount matches a stocked receipt, but no movement or cost
 * layer is created. A stable entry number makes each receipt line idempotent.
 */
export async function applyDropShipConfirmationInventory(
  runner: Runner,
  orgId: string,
  actorId: string,
  receiptId: string,
): Promise<number> {
  await assertDropShippingFeature(runner, orgId);
  const receipt = (await runner.execute<{
    document_date: string;
    subsidiary_id: string | null;
    kind: string;
    status: string;
    has_confirmation: boolean;
    has_drop_ship_order: boolean;
  }>(sql`
    select receipt.document_date::text as document_date, receipt.subsidiary_id,
           receipt.kind, receipt.status,
           receipt.custom ? 'dropShipConfirmation' as has_confirmation,
           exists (
             select 1
               from document_links link
               join drop_ship_orders drop_ship
                 on drop_ship.org_id = link.org_id and drop_ship.purchase_order_id = link.from_document_id
              where link.org_id = receipt.org_id and link.to_document_id = receipt.id
                and link.link_type = 'fulfills'
           ) as has_drop_ship_order
      from documents receipt where receipt.org_id = ${orgId} and receipt.id = ${receiptId}
  `)).rows[0];
  if (!receipt || receipt.kind !== "purchase_receipt") {
    throw new DropShipRefusal("Drop-ship receipt not found", "not_found", 404);
  }
  if (!receipt.has_confirmation || !receipt.has_drop_ship_order) {
    throw new DropShipRefusal(
      "This purchase receipt is not a confirmed drop-ship receipt",
      "invalid_pairing",
      422,
      "Use Confirm vendor shipment from the linked drop-ship purchase order",
    );
  }
  if (receipt.status !== "approved") {
    throw new DropShipRefusal("Drop-ship receipt must be approved before its cost is posted", "confirmation_not_ready", 409, "Complete the receipt and fulfilment confirmation together");
  }
  const lines = (await runner.execute<DropShipPostingLine>(sql`
    select rl.id as line_id, rl.line_number, rl.item_id, rl.amount::text as amount,
           profile.cogs_account_id, profile.received_not_billed_account_id as clearing_account_id,
           profile.item_id is not null as has_profile,
           exists (
             select 1 from drop_ship_lines routed
             join document_lines po_line on po_line.org_id = routed.org_id
               and po_line.id = routed.purchase_order_line_id
             join drop_ship_orders drop_ship on drop_ship.org_id = po_line.org_id
               and drop_ship.purchase_order_id = po_line.document_id
             join document_links receipt_link on receipt_link.org_id = po_line.org_id
               and receipt_link.from_document_id = po_line.document_id
               and receipt_link.to_document_id = rd.id and receipt_link.link_type = 'fulfills'
              where routed.org_id = rl.org_id
                and routed.purchase_order_line_id::text = rl.custom->'receipt'->>'sourceLineId'
           ) as is_routed,
           coalesce(rl.department_id, rd.department_id) as department_id,
           coalesce(rl.project_id, rd.project_id) as project_id,
           coalesce(rl.location_id, rd.location_id) as location_id,
           rl.stock_location_id, item.name as item_name
      from document_lines rl
      join documents rd on rd.id = rl.document_id and rd.org_id = rl.org_id
      join items item on item.id = rl.item_id and item.org_id = rl.org_id
      left join item_inventory_profiles profile on profile.item_id = rl.item_id and profile.org_id = rl.org_id
     where rl.org_id = ${orgId} and rl.document_id = ${receiptId}
     order by rl.line_number
  `)).rows;
  if (lines.length === 0) {
    throw new DropShipRefusal("Drop-ship confirmation receipt has no stock lines", "invalid_pairing", 422, "Create the receipt from the routed purchase-order lines");
  }
  const unpaired = lines.find((line) => !line.is_routed);
  if (unpaired) {
    throw new DropShipRefusal(
      `Receipt line ${unpaired.line_number} is not paired to a routed purchase-order line`,
      "invalid_pairing",
      422,
      "Create the receipt from the routed purchase-order lines",
    );
  }
  const context = await loadSubsidiaryContext(runner, orgId);
  const subsidiaryId = receipt.subsidiary_id ?? context.rootId;
  assertMovementOwner(context, subsidiaryId);
  const periodId = await periodForDate(orgId, receipt.document_date, runner);
  if (!periodId) {
    throw new DropShipRefusal(`No accounting period covers ${receipt.document_date}`, "accounting_period_required", 422, "Generate the accounting period covering the confirmation date, then retry");
  }
  const bookId = await primaryBookId(orgId, runner);
  try {
    await assertPeriodModulesOpen(runner, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: [subsidiaryId],
      modules: [],
    });
  } catch (error) {
    if (error instanceof CloseError) {
      throw new DropShipRefusal(`The accounting period for ${receipt.document_date} is closed: ${error.message}`, "accounting_period_required", 409, "Open a covering accounting period, then retry the vendor confirmation");
    }
    throw error;
  }
  const currency = await subsidiaryCurrency(orgId, subsidiaryId, runner);
  let count = 0;
  for (const line of lines) {
    if (!line.has_profile) {
      throw new DropShipRefusal(`Item ${line.item_name} has no inventory costing profile`, "item_profile_required", 422, `Open Items, select ${line.item_name}, and configure its Costing profile before confirming the shipment`);
    }
    if (!line.cogs_account_id) {
      throw new DropShipRefusal(`Item ${line.item_name} is missing its COGS account`, "cogs_account_required", 422, `Open Items, select ${line.item_name}, set the COGS account in its Costing profile, and retry`);
    }
    if (!line.clearing_account_id) {
      throw new DropShipRefusal(`Item ${line.item_name} is missing its received-not-billed account`, "received_not_billed_account_required", 422, `Open Items, select ${line.item_name}, set the received-not-billed account in its Costing profile, and retry`);
    }
    const cogsAccount = (await runner.execute<{ name: string; is_active: boolean; is_summary: boolean }>(sql`
      select name, is_active, is_summary from accounts
       where org_id = ${orgId} and id = ${line.cogs_account_id}
       for share
    `)).rows[0];
    if (!cogsAccount || !cogsAccount.is_active || cogsAccount.is_summary) {
      throw new DropShipRefusal(`Item ${line.item_name} has no active posting COGS account`, "cogs_account_required", 422, `Open Items, select ${line.item_name}, and choose an active posting COGS account in its Costing profile`);
    }
    const clearingAccount = (await runner.execute<{ name: string; is_active: boolean; is_summary: boolean }>(sql`
      select name, is_active, is_summary from accounts
       where org_id = ${orgId} and id = ${line.clearing_account_id}
       for share
    `)).rows[0];
    if (!clearingAccount || !clearingAccount.is_active || clearingAccount.is_summary) {
      throw new DropShipRefusal(`Item ${line.item_name} has no active posting received-not-billed account`, "received_not_billed_account_required", 422, `Open Items, select ${line.item_name}, and choose an active posting received-not-billed account in its Costing profile`);
    }
    const entryNumber = `INV-DS-${line.line_id}`;
    const existing = (await runner.execute(sql`
      select 1 from journal_entries where org_id = ${orgId} and entry_number = ${entryNumber} limit 1`)).rows[0];
    if (existing) continue;
    const locationId = line.stock_location_id
      ? await stockLocationDim(runner, orgId, line.stock_location_id, line.location_id)
      : line.location_id;
    try {
      await postInventoryEntry(runner, {
        orgId,
        bookId,
        subsidiaryId,
        actorId,
        currency,
        periodId,
        date: receipt.document_date,
        entryNumber,
        memo: "Drop-ship confirmation",
        custom: { dropShipConfirmation: { receiptId, receiptLineId: line.line_id } },
        lines: [
          { accountId: line.cogs_account_id, amount: line.amount, departmentId: line.department_id, projectId: line.project_id, locationId, memo: "Cost of goods sold" },
          { accountId: line.clearing_account_id, amount: neg(line.amount), departmentId: line.department_id, projectId: line.project_id, locationId, memo: "Received not billed" },
        ],
      });
    } catch (error) {
      if (error instanceof InventoryError && /closed/i.test(error.message)) {
        throw new DropShipRefusal(`The accounting period for ${receipt.document_date} closed while the confirmation was posting`, "accounting_period_required", 409, "Open a covering accounting period, then retry the vendor confirmation");
      }
      throw error;
    }
    count++;
  }
  return count;
}

async function audit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  rowId: string,
  action: "insert" | "delete",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'drop_ship_lines', ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`);
  if (written.rows.length === 0) throw new Error("drop-ship routing change was not audited");
}

type OrderLine = Record<string, unknown> & {
  id: string;
  kind: string;
  status: string;
  subsidiary_id: string | null;
  line_number: number;
  item_id: string | null;
  quantity_fulfilled: string;
  has_inventory_profile: boolean;
}

async function lockEligibleLine(
  tx: SqlExecutor,
  orgId: string,
  salesOrderId: string,
  salesOrderLineId: string,
  scope: Scope,
): Promise<OrderLine> {
  const header = (await tx.execute<{ id: string; kind: string; status: string; subsidiary_id: string | null }>(sql`
    select id, kind, status, subsidiary_id
      from documents
     where org_id = ${orgId} and id = ${salesOrderId}
     for update`)).rows[0];
  if (!header || header.kind !== "sales_order" || !subsidiaryScopeAllows(scope, header.subsidiary_id)) {
    throw new DropShipRefusal("Sales order not found", "not_found", 404);
  }
  if (header.status !== "approved") {
    throw new DropShipRefusal(
      `Sales order is ${header.status}; issue the order before routing a line`,
      "order_not_open",
      409,
      "Issue the sales order, then route its stock line",
    );
  }
  const line = (await tx.execute<OrderLine>(sql`
    select dl.id, d.kind, d.status, d.subsidiary_id, dl.line_number, dl.item_id,
           dl.quantity_fulfilled::text as quantity_fulfilled,
           profile.item_id is not null as has_inventory_profile
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      left join item_inventory_profiles profile
        on profile.org_id = dl.org_id and profile.item_id = dl.item_id
     where dl.org_id = ${orgId} and dl.document_id = ${salesOrderId} and dl.id = ${salesOrderLineId}
     for update of dl`)).rows[0];
  if (!line) throw new DropShipRefusal("Sales-order line not found", "not_found", 404);
  if (!line.item_id || !line.has_inventory_profile) {
    throw new DropShipRefusal(
      `Sales-order line ${line.line_number} is not a stock line`,
      "not_a_stock_line",
      422,
      "Route a line whose item has an inventory costing profile",
    );
  }
  if (cmp(line.quantity_fulfilled, "0") > 0) {
    throw new DropShipRefusal(
      `Sales-order line ${line.line_number} already has fulfilled quantity and cannot be routed`,
      "already_fulfilled",
      409,
      "Use the existing shipment for the fulfilled quantity and route a new order line for vendor shipment",
    );
  }
  return line;
}

export interface RouteDropShipLineInput {
  orgId: string;
  actorId: string;
  salesOrderId: string;
  salesOrderLineId: string;
  allowedSubsidiaryIds: Scope;
}

/** Route an unfulfilled stock line from the customer's warehouse to a vendor. */
export async function routeDropShipLine(input: RouteDropShipLineInput): Promise<void> {
  await db.transaction(async (tx) => {
    await assertDropShippingFeature(tx, input.orgId);
    const line = await lockEligibleLine(tx, input.orgId, input.salesOrderId, input.salesOrderLineId, input.allowedSubsidiaryIds);
    const existing = (await tx.execute(sql`
      select 1 from drop_ship_lines
       where org_id = ${input.orgId} and sales_order_line_id = ${line.id}`)).rows[0];
    if (existing) {
      throw new DropShipRefusal(
        `Sales-order line ${line.line_number} is already routed for vendor shipment`,
        "already_routed",
        409,
        "Open the existing drop-ship purchase order or unroute the line before creating another",
      );
    }
    const inserted = await tx.execute<{ sales_order_line_id: string }>(sql`
      insert into drop_ship_lines (org_id, sales_order_line_id, routed_by)
      values (${input.orgId}, ${line.id}, ${input.actorId})
      returning sales_order_line_id`);
    if (inserted.rows.length === 0) {
      throw new DropShipRefusal(
        `Sales-order line ${line.line_number} is already routed for vendor shipment`,
        "already_routed",
        409,
        "Open the existing drop-ship purchase order or unroute the line before creating another",
      );
    }
    await audit(tx, input.orgId, input.actorId, line.id, "insert", {
      before: null,
      after: { salesOrderId: input.salesOrderId, salesOrderLineId: line.id },
    });
  });
}

/** Remove a route only while it has no PO line and no fulfilled quantity. */
export async function unrouteDropShipLine(input: RouteDropShipLineInput): Promise<void> {
  await db.transaction(async (tx) => {
    await assertDropShippingFeature(tx, input.orgId);
    const line = await lockEligibleLine(tx, input.orgId, input.salesOrderId, input.salesOrderLineId, input.allowedSubsidiaryIds);
    const route = (await tx.execute<{ purchase_order_line_id: string | null }>(sql`
      select purchase_order_line_id
        from drop_ship_lines
       where org_id = ${input.orgId} and sales_order_line_id = ${line.id}
       for update`)).rows[0];
    if (!route) throw new DropShipRefusal("Drop-ship route not found", "not_found", 404);
    if (route.purchase_order_line_id) {
      throw new DropShipRefusal(
        `Sales-order line ${line.line_number} already belongs to a drop-ship purchase order`,
        "purchase_order_exists",
        409,
        "Void the drop-ship purchase order through its controlled void action before changing the route",
      );
    }
    const deleted = await tx.execute<{ sales_order_line_id: string }>(sql`
      delete from drop_ship_lines
       where org_id = ${input.orgId} and sales_order_line_id = ${line.id}
         and purchase_order_line_id is null
       returning sales_order_line_id`);
    if (deleted.rows.length === 0) {
      throw new DropShipRefusal("Drop-ship route changed while it was being removed", "changed_concurrently", 409, "Reload the sales order and retry removing the route");
    }
    await audit(tx, input.orgId, input.actorId, line.id, "delete", {
      before: { salesOrderId: input.salesOrderId, salesOrderLineId: line.id },
      after: null,
    });
  });
}

export interface DropShipLinePair {
  salesOrderLineId: string;
  purchaseOrderLineId: string;
}

/** Bind the routed sales lines to the draft PO lines created by the shared order editor. */
export async function attachDropShipPurchaseOrder(input: {
  orgId: string;
  actorId: string;
  salesOrderId: string;
  purchaseOrderId: string;
  shipToAddress: Record<string, unknown>;
  lines: DropShipLinePair[];
  allowedSubsidiaryIds: Scope;
}): Promise<void> {
  await db.transaction((tx) => attachDropShipPurchaseOrderInTx(tx, input));
}

export async function attachDropShipPurchaseOrderInTx(
  tx: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    salesOrderId: string;
    purchaseOrderId: string;
    shipToAddress: Record<string, unknown>;
    lines: DropShipLinePair[];
    allowedSubsidiaryIds: Scope;
  },
): Promise<void> {
    await assertDropShippingFeature(tx, input.orgId);
    const po = (await tx.execute<{ id: string; kind: string; status: string; subsidiary_id: string | null }>(sql`
      select id, kind, status, subsidiary_id from documents
       where id = ${input.purchaseOrderId} and org_id = ${input.orgId} for update`)).rows[0];
    const so = (await tx.execute<{ id: string; kind: string; status: string; subsidiary_id: string | null }>(sql`
      select id, kind, status, subsidiary_id from documents
       where id = ${input.salesOrderId} and org_id = ${input.orgId} for update`)).rows[0];
    if (!po || po.kind !== "purchase_order" || !so || so.kind !== "sales_order"
      || !subsidiaryScopeAllows(input.allowedSubsidiaryIds, po.subsidiary_id)
      || !subsidiaryScopeAllows(input.allowedSubsidiaryIds, so.subsidiary_id)) {
      throw new DropShipRefusal("Order not found", "not_found", 404);
    }
    if (po.subsidiary_id !== so.subsidiary_id) {
      throw new DropShipRefusal(
        "The drop-ship purchase order and sales order must belong to the same subsidiary",
        "invalid_pairing",
        422,
        "Create the purchase order from the sales order so both documents use the same subsidiary",
      );
    }
    if (po.status !== "draft" || so.status !== "approved" || input.lines.length === 0) {
      throw new DropShipRefusal("Drop-ship purchase order or sales order changed before routing was saved", "invalid_pairing", 409, "Reload both orders and create a new drop-ship purchase order");
    }
    const existing = (await tx.execute<{ sales_order_id: string }>(sql`
      select sales_order_id from drop_ship_orders
       where org_id = ${input.orgId} and purchase_order_id = ${input.purchaseOrderId}`)).rows[0];
    if (existing) {
      if (existing.sales_order_id === input.salesOrderId) return;
      throw new DropShipRefusal("Purchase order is already linked to another sales order", "invalid_pairing", 409, "Create a separate purchase order for this sales order");
    }
    const snapshot = JSON.stringify(input.shipToAddress);
    const mapped: Array<{ salesOrderLineId: string; purchaseOrderLineId: string }> = [];
    for (const pair of input.lines) {
      const updated = await tx.execute<{ sales_order_line_id: string }>(sql`
        update drop_ship_lines routed
           set purchase_order_line_id = ${pair.purchaseOrderLineId}, routed_at = now(), routed_by = ${input.actorId}
          from document_lines sol
         where routed.org_id = ${input.orgId} and routed.sales_order_line_id = ${pair.salesOrderLineId}
           and routed.purchase_order_line_id is null
           and sol.org_id = routed.org_id and sol.id = routed.sales_order_line_id
           and sol.document_id = ${input.salesOrderId}
        returning routed.sales_order_line_id`);
      if (updated.rows.length !== 1) {
        throw new DropShipRefusal("A routed sales-order line changed before the purchase order was saved", "changed_concurrently", 409, "Reload the sales order and create a new drop-ship purchase order");
      }
      const pairLines = (await tx.execute<{
        po_item_id: string | null;
        so_item_id: string | null;
        po_quantity: string;
        so_open_quantity: string;
      }>(sql`
        select pol.item_id as po_item_id, sol.item_id as so_item_id,
               pol.quantity::text as po_quantity,
               ${openQuantitySql("sol")}::text as so_open_quantity
         from document_lines pol
         join document_lines sol on sol.id = ${pair.salesOrderLineId} and sol.org_id = pol.org_id
         where pol.org_id = ${input.orgId} and pol.document_id = ${input.purchaseOrderId}
           and pol.id = ${pair.purchaseOrderLineId} and sol.document_id = ${input.salesOrderId}`)).rows[0];
      if (!pairLines || pairLines.po_item_id !== pairLines.so_item_id
        || cmp(pairLines.po_quantity, pairLines.so_open_quantity) !== 0) {
        throw new DropShipRefusal(
          "The purchase-order line must match the routed sales line's item and open quantity",
          "invalid_pairing",
          422,
          "Create the purchase order from the routed sales order",
        );
      }
      mapped.push(pair);
    }
    const inserted = await tx.execute<{ purchase_order_id: string }>(sql`
      insert into drop_ship_orders (org_id, purchase_order_id, sales_order_id, ship_to_address)
      values (${input.orgId}, ${input.purchaseOrderId}, ${input.salesOrderId}, ${snapshot}::jsonb)
      returning purchase_order_id`);
    if (inserted.rows.length !== 1) throw new Error("drop-ship purchase-order link was not stored");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'drop_ship_orders', ${input.purchaseOrderId}, 'insert',
        ${JSON.stringify({ before: null, after: { salesOrderId: input.salesOrderId, shipToAddress: input.shipToAddress, lines: mapped } })}::jsonb,
        ${input.actorId})`);
}

/** Scope-aware status for the order drawer and assistant. */
export async function dropShipOrderStatus(
  runner: SqlExecutor,
  orgId: string,
  salesOrderId: string,
  allowedSubsidiaryIds: Scope,
): Promise<Array<{ salesOrderLineId: string; purchaseOrderLineId: string | null; purchaseOrderId: string | null }>> {
  await assertDropShippingFeature(runner, orgId);
  const order = (await runner.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from documents where org_id = ${orgId} and id = ${salesOrderId} and kind = 'sales_order'`)).rows[0];
  if (!order || !subsidiaryScopeAllows(allowedSubsidiaryIds, order.subsidiary_id)) {
    throw new DropShipRefusal("Sales order not found", "not_found", 404);
  }
  return (await runner.execute<{ sales_order_line_id: string; purchase_order_line_id: string | null; purchase_order_id: string | null }>(sql`
    select routed.sales_order_line_id, routed.purchase_order_line_id,
           ds.purchase_order_id
      from drop_ship_lines routed
      left join drop_ship_orders ds on ds.org_id = routed.org_id
        and ds.sales_order_id = ${salesOrderId}
        and ds.purchase_order_id = (select po.document_id from document_lines po
          where po.org_id = routed.org_id and po.id = routed.purchase_order_line_id)
     where routed.org_id = ${orgId}
       and routed.sales_order_line_id in (select id from document_lines where org_id = ${orgId} and document_id = ${salesOrderId})
     order by routed.sales_order_line_id`)).rows.map((row) => ({
      salesOrderLineId: row.sales_order_line_id,
      purchaseOrderLineId: row.purchase_order_line_id,
      purchaseOrderId: row.purchase_order_id,
    }));
}
