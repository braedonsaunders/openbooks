import "server-only";
import {
  documentRevisionCounterSql,
  isDocumentRevisionToken,
} from "@openbooks/engine/records/revision";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { assertStockLocationAdmitsSubsidiary } from "@openbooks/engine/inventory/profile-policy";
import {
  InventoryError,
  InventoryOwnershipError,
} from "@openbooks/engine/inventory/contracts/module";
import { loadSubsidiaryContext } from "@openbooks/engine/organization/subsidiaries";
import { activeStockLocations, resolveLineStockLocation } from "./stock-locations";
import { isUuid } from "./list-params";
import { ConversionError, ORDER_LINE_WAREHOUSE_REQUIRED } from "./order-cycle-shared";

export interface AssignOrderLineWarehouseInput {
  orgId: string;
  userId: string;
  orderId: string;
  kind: "sales_order" | "purchase_order";
  lineId: string;
  stockLocationId: string;
  expectedUpdatedAt: string;
}

/**
 * Assign a warehouse to one line of an approved-but-unfulfilled order.
 * Orders approved before line warehouses existed carry NULL
 * warehouses and their lines are storage-immutable (migration 0034), so
 * fulfillment could never name a location and failed closed with no way
 * forward. Setting the warehouse changes no posted amount — it only routes
 * future shipments/receipts — so this reopens the header inside one
 * transaction (the established fulfill/convert pattern), writes the single
 * column, restores approved, and audits the assignment. Drafts stay on the
 * normal edit path; anything not approved is refused.
 */
export async function assignOrderLineWarehouse(
  input: AssignOrderLineWarehouseInput,
): Promise<{ lineId: string; lineNumber: number; stockLocationId: string }> {
  const orderLabel = input.kind === "sales_order" ? "Sales order" : "Purchase order";
  const lineLabel = input.kind === "sales_order" ? "Sales-order line" : "Purchase-order line";
  if (!isUuid(input.orderId) || !isUuid(input.lineId) || !isUuid(input.stockLocationId)) {
    throw new ConversionError("Invalid order line warehouse assignment", 422);
  }
  return db.transaction(async (tx) => {
    const doc = (
      await tx.execute<{
        id: string;
        kind: string;
        status: string;
        subsidiary_id: string | null;
        updated_at: string;
      }>(
        sql`
      select id, kind, status, subsidiary_id,
             ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at
        from documents
       where id = ${input.orderId} and org_id = ${input.orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!doc || doc.kind !== input.kind) throw new ConversionError("Order not found", 404);
    if (doc.status === "draft") {
      throw new ConversionError(
        `This ${orderLabel.toLowerCase()} is still a draft; set the warehouse by editing the draft`,
        422,
      );
    }
    if (doc.status !== "approved")
      throw new ConversionError(`This ${orderLabel.toLowerCase()} is ${doc.status}`, 422);
    if (
      !isDocumentRevisionToken(input.expectedUpdatedAt) ||
      input.expectedUpdatedAt !== doc.updated_at
    ) {
      throw new ConversionError(
        "this order changed after you opened it; reload and review the latest revision",
        409,
      );
    }
    const line = (
      await tx.execute<{
        id: string;
        line_number: number;
        item_id: string | null;
        stock_location_id: string | null;
      }>(
        sql`
      select id, line_number, item_id, stock_location_id
        from document_lines
       where id = ${input.lineId} and org_id = ${input.orgId} and document_id = ${input.orderId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!line) throw new ConversionError("Order line not found", 404);
    if (line.stock_location_id === input.stockLocationId) {
      return {
        lineId: line.id,
        lineNumber: line.line_number,
        stockLocationId: input.stockLocationId,
      };
    }
    if (!line.item_id) {
      throw new ConversionError(
        `${lineLabel} ${line.line_number} is not a stocked item; a warehouse does not apply`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        { lineNumber: line.line_number },
      );
    }
    const profiled = (
      await tx.execute<{ item_id: string }>(
        sql`
      select item_id from item_inventory_profiles
       where org_id = ${input.orgId} and item_id = ${line.item_id}
    `,
        "objects",
      )
    )[0];
    if (!profiled) {
      throw new ConversionError(
        `${lineLabel} ${line.line_number} is not a stocked item; a warehouse does not apply`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        { lineNumber: line.line_number },
      );
    }
    // The drawer's own validation reader: the choice must name an active
    // warehouse of this org. Subsidiary admission is checked next with the
    // same rule posting enforces, so the assignment cannot strand the line.
    const resolved = resolveLineStockLocation(
      line.line_number,
      line.item_id,
      input.stockLocationId,
      {
        active: await activeStockLocations(input.orgId),
        profiled: new Set([line.item_id]),
      },
    );
    if ("error" in resolved) {
      throw new ConversionError(resolved.error, 422, ORDER_LINE_WAREHOUSE_REQUIRED, {
        lineNumber: line.line_number,
      });
    }
    const locationId = resolved.locationId ?? input.stockLocationId;
    const ctx = await loadSubsidiaryContext(tx, input.orgId);
    try {
      await assertStockLocationAdmitsSubsidiary(
        tx,
        input.orgId,
        ctx,
        locationId,
        doc.subsidiary_id ?? ctx.rootId,
        input.kind === "sales_order" ? "outbound" : "inbound",
      );
    } catch (error) {
      if (error instanceof InventoryOwnershipError) {
        throw new ConversionError(error.message, 403, ORDER_LINE_WAREHOUSE_REQUIRED, {
          lineNumber: line.line_number,
        });
      }
      if (error instanceof InventoryError) {
        throw new ConversionError(error.message, 422, ORDER_LINE_WAREHOUSE_REQUIRED, {
          lineNumber: line.line_number,
        });
      }
      throw error;
    }
    const reopened = (
      await tx.execute<{ id: string }>(
        sql`
      update documents
         set status = 'draft', updated_by = ${input.userId}
       where id = ${input.orderId} and org_id = ${input.orgId} and status = 'approved'
      returning id
    `,
        "objects",
      )
    )[0];
    if (!reopened) throw new ConversionError("Order changed while assigning the warehouse", 409);
    await tx.execute(sql`
      update document_lines
         set stock_location_id = ${locationId}, updated_by = ${input.userId}
       where id = ${line.id} and org_id = ${input.orgId}
    `);
    const restored = (
      await tx.execute<{ id: string }>(
        sql`
      update documents
         set status = 'approved', updated_by = ${input.userId}
       where id = ${input.orderId} and org_id = ${input.orgId} and status = 'draft'
      returning id
    `,
        "objects",
      )
    )[0];
    if (!restored) throw new ConversionError("Order changed while assigning the warehouse", 409);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${input.orgId}, 'document_lines', ${line.id}, 'update',
        ${JSON.stringify({
          mode: "order_line_warehouse_assigned",
          orderId: input.orderId,
          kind: input.kind,
          lineNumber: line.line_number,
          from: line.stock_location_id,
          to: locationId,
        })}::jsonb,
        ${input.userId}
      )
    `);
    return { lineId: line.id, lineNumber: line.line_number, stockLocationId: locationId };
  });
}
