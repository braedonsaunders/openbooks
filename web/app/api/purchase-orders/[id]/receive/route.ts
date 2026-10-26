import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { lineRequiresReceipt } from "@openbooks/engine/records/stock-receipt";
import {
  InventoryError,
  InventoryOwnershipError,
  UnitConversionError,
} from "@openbooks/engine/inventory/contracts/module";
import { resolveDefaultWarehouse, WarehouseRefusal } from "@openbooks/engine/inventory/warehouses";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { can, guardSubsidiaryScope, type Authz } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { unexpectedServerError } from "../../../../../lib/api/unexpected";
import { ConversionError, receivePurchaseOrder } from "../../../../../lib/order-cycle";
import { fromQuantityUnits, toQuantityUnits } from "../../../../../lib/order-cycle-math";
import {
  formatMaxReceivable,
  resolveOverReceiptTolerance,
} from "../../../../../lib/purchase-over-receipt";
import { linkedBillReceivedCover } from "@openbooks/engine/inventory/bill-matchable-lines";
import {
  readDocumentScope,
  readPurchaseOrderLinesForReceipt,
} from "../../../../../lib/record-scope-reads";

export const runtime = "nodejs";

const params = z.object({ id: uuidString() });

const receiveLineBody = z
  .object({
    sourceLineId: uuidString(),
    quantity: z.string().min(1).max(50),
  })
  .strict();

const receiveBody = z
  .object({
    receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lines: z.array(receiveLineBody).min(1),
    idempotencyKey: z.string().min(1).max(500).optional(),
  })
  .strict();

/** The source must be this org's purchase order inside the caller's scope. */
async function scopedSource(authz: Authz, id: string) {
  const source = await readDocumentScope(authz.user.orgId, id, { kind: "purchase_order" });
  if (!source) return { ok: false as const, response: notFound("record") };
  const denied = guardSubsidiaryScope(authz, source.subsidiaryId);
  if (denied) return { ok: false as const, response: denied };
  return { ok: true as const, source };
}

function conversionResponse(error: ConversionError) {
  return NextResponse.json(
    {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
    { status: error.status },
  );
}

/**
 * GET prefill: the receipt draft for a purchase order — business-today
 * receipt date plus every stock line's remaining quantity, each warehouse
 * defaulted to the line's own or the entity default. Read-only: resolving a
 * default never creates a warehouse (the save stamps it through the native
 * path, or refuses naming the remedy).
 */
export const GET = defineRoute({
  permission: "goods_receipts.create",
  feature: "orders",
  params,
  handler: async ({ authz, params: { id } }) => {
    const scoped = await scopedSource(authz, id);
    if (!scoped.ok) return scoped.response;
    try {
      const receiptDate = await businessToday(authz.user.orgId);
      const rows = await readPurchaseOrderLinesForReceipt(authz.user.orgId, id);
      const defaultWarehouse = await resolveDefaultWarehouse(
        db,
        authz.user.orgId,
        scoped.source.subsidiaryId,
      );
      // The tolerated maximum rides the prefill so the form admits an
      // over-receipt within policy; the save path re-resolves the policy
      // effective on the entered receipt date and owns the final check.
      const lines = (
        await Promise.all(
          rows.map(async (line) => {
            if (line.item_id == null || !lineRequiresReceipt(line.item_kind)) return null;
            const netOrdered =
              toQuantityUnits(String(line.quantity)) -
              toQuantityUnits(String(line.quantity_cancelled));
            const billCover = await linkedBillReceivedCover(db, authz.user.orgId, {
              purchaseOrderLineId: line.id,
              itemId: line.item_id,
              unit: line.unit,
            });
            const received =
              toQuantityUnits(String(line.quantity_fulfilled)) +
              toQuantityUnits(billCover.quantity);
            const remaining = netOrdered - received;
            if (remaining <= 0n) return null;
            const tolerance = await resolveOverReceiptTolerance(
              db,
              authz.user.orgId,
              line.item_category,
              receiptDate,
            );
            const netOrderedQuantity = fromQuantityUnits(netOrdered);
            return {
              sourceLineId: line.id,
              lineNumber: line.line_number,
              description: line.description,
              unit: line.unit,
              unitPrice: String(line.unit_price),
              remaining: fromQuantityUnits(remaining),
              maxReceivable: formatMaxReceivable(
                netOrderedQuantity,
                fromQuantityUnits(received),
                tolerance,
              ),
              stockLocationId: line.stock_location_id ?? defaultWarehouse,
            };
          }),
        )
      ).filter((line): line is NonNullable<typeof line> => line !== null);
      return NextResponse.json({ receiptDate, lines });
    } catch (error) {
      if (error instanceof WarehouseRefusal) {
        return NextResponse.json(
          { error: error.message, code: error.code, details: { remedy: error.remedy } },
          { status: error.status },
        );
      }
      return unexpectedServerError("purchase-orders/receive-prefill", error);
    }
  },
});

/**
 * POST save: post the explicit receipt through the native receive path.
 * The idempotency key (header, else body) is the command's identity: a lost
 * response retried with the same key replays the stored receipt instead of
 * receiving the stock twice. A missing key refuses — the client must name
 * its command.
 */
export const POST = defineRoute({
  permission: "goods_receipts.create",
  feature: "orders",
  params,
  body: receiveBody,
  handler: async ({ request, authz, params: { id }, body }) => {
    const scoped = await scopedSource(authz, id);
    if (!scoped.ok) return scoped.response;
    // Receiving moves stock and posts value-carrying inventory journals when
    // Inventory is enabled, so it takes items.post on top of the receiving
    // grant — the same authority the convert endpoint demands.
    if ((await isFeatureEnabled(authz.user.orgId, "inventory")) && !can(authz, "items.post")) {
      return NextResponse.json({ error: "missing permission: items.post" }, { status: 403 });
    }
    const key = request.headers.get("Idempotency-Key")?.trim() || body.idempotencyKey?.trim() || "";
    if (!key) {
      return NextResponse.json(
        {
          error:
            "Idempotency-Key header or idempotencyKey is required so a retried save never receives twice",
        },
        { status: 400 },
      );
    }
    try {
      const res = await receivePurchaseOrder(authz.user.orgId, authz.user.id, id, {
        receiptDate: body.receiptDate,
        idempotencyKey: key,
        lines: body.lines,
      });
      return NextResponse.json(res);
    } catch (error) {
      if (error instanceof ConversionError) return conversionResponse(error);
      if (error instanceof InventoryOwnershipError) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error instanceof WarehouseRefusal) {
        return NextResponse.json(
          { error: error.message, code: error.code, details: { remedy: error.remedy } },
          { status: error.status },
        );
      }
      // A missing unit conversion keeps its code and item identity so the
      // drawer links the refusal to the item's costing section.
      if (error instanceof UnitConversionError) {
        return NextResponse.json(
          { error: error.message, code: error.code, details: error.details },
          { status: error.status },
        );
      }
      if (error instanceof InventoryError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      return unexpectedServerError("purchase-orders/receive", error);
    }
  },
});
