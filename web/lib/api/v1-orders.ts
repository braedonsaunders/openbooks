import "server-only";
import { NextResponse } from "next/server";
import {
  convertApplicationOrder,
  createApplicationOrder,
  ORDER_TYPE_KIND,
  type OrderTypeKey,
} from "../application/orders";
import { invalidInput, notFound } from "../application/errors";
import { v1GetRecord, v1ListRecords } from "./v1-records";
import { readV1JsonObject, requireV1IdempotencyKey, withV1Request } from "./v1-request";

function orderTypeKey(typeKey: string): OrderTypeKey {
  if (typeKey !== "quotes" && typeKey !== "sales-orders" && typeKey !== "purchase-orders") {
    throw notFound("record type");
  }
  return typeKey;
}

export function v1ListOrders(request: Request, typeKey: string): Promise<NextResponse> {
  return v1ListRecords(request, orderTypeKey(typeKey), `api/v1/${typeKey}`);
}

export function v1GetOrder(request: Request, typeKey: string, id: string): Promise<NextResponse> {
  return v1GetRecord(request, orderTypeKey(typeKey), id, `api/v1/${typeKey}/:id`);
}

/** Empty commercial-order draft — same writer as the New Order drawer. */
export function v1CreateOrder(request: Request, typeKey: string): Promise<NextResponse> {
  const key = orderTypeKey(typeKey);
  return withV1Request(request, `api/v1/${key}`, async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const subsidiaryId = body.subsidiaryId ?? body.subsidiary_id ?? null;
    if (subsidiaryId !== null && typeof subsidiaryId !== "string") {
      throw invalidInput("subsidiaryId must be a UUID");
    }
    const outcome = await createApplicationOrder(context, {
      kind: ORDER_TYPE_KIND[key],
      idempotencyKey: requireV1IdempotencyKey(request),
      subsidiaryId,
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}

/** Convert an issued order — same writer as the order-cycle convert action. */
export function v1ConvertOrder(request: Request, typeKey: string, id: string): Promise<NextResponse> {
  const key = orderTypeKey(typeKey);
  return withV1Request(request, `api/v1/${key}/:id/convert`, async (_auth, context) => {
    const body = await readV1JsonObject(request);
    if (typeof body.targetKind !== "string" || body.targetKind.trim() === "") {
      throw invalidInput(
        "targetKind is required; convert a quote to sales_order or customer_invoice, a sales order to sales_fulfillment or customer_invoice, or a purchase order to purchase_receipt or vendor_bill",
      );
    }
    const outcome = await convertApplicationOrder(context, {
      documentId: id,
      targetKind: body.targetKind,
      expectedUpdatedAt: typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined,
      creditOverrideReason: typeof body.creditOverrideReason === "string" ? body.creditOverrideReason : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
      expectedKind: ORDER_TYPE_KIND[key],
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}
