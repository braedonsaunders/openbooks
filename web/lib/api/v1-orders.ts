import "server-only";
import { NextResponse } from "next/server";
import {
  convertApplicationOrder,
  issueApplicationOrder,
  replaceApplicationOrderLines,
  ORDER_TYPE_KIND,
  type OrderTypeKey,
  type V1OrderLineInput,
  type V1ShippingLineInput,
} from "../application/orders";
import { createApplicationRecord } from "../application/records";
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

/**
 * Commercial-order create. A body carrying order content (customer, lines,
 * dates, currency, memo, external reference) on the sales-orders route takes
 * the full-order path through the drawer's writer; anything else mints the
 * empty draft the New Order drawer starts from, unchanged.
 */
export function v1CreateOrder(request: Request, typeKey: string): Promise<NextResponse> {
  const key = orderTypeKey(typeKey);
  return withV1Request(request, `api/v1/${key}`, async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const recordBody =
      key === "sales-orders"
        ? body
        : { subsidiaryId: body.subsidiaryId ?? body.subsidiary_id ?? null };
    const outcome = await createApplicationRecord(context, {
      typeKey: key,
      body: recordBody,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}

/** Replace every line on a draft order. The revision token is required. */
export function v1ReplaceOrderLines(
  request: Request,
  typeKey: string,
  id: string,
): Promise<NextResponse> {
  const key = orderTypeKey(typeKey);
  if (key !== "sales-orders") {
    throw invalidInput("line replacement is only accepted for sales orders");
  }
  return withV1Request(request, `api/v1/${key}/:id/lines`, async (_auth, context) => {
    const body = await readV1JsonObject(request);
    requireV1IdempotencyKey(request);
    const outcome = await replaceApplicationOrderLines(context, {
      documentId: id,
      expectedUpdatedAt: body.expectedUpdatedAt as string,
      lines: body.lines as V1OrderLineInput[] | undefined,
      shippingLines: body.shippingLines as V1ShippingLineInput[] | undefined,
    });
    return { status: 200, body: outcome.result };
  });
}

/** Issue a draft sales order — same engine call as the drawer's Issue action. */
export function v1IssueOrder(request: Request, typeKey: string, id: string): Promise<NextResponse> {
  const key = orderTypeKey(typeKey);
  if (key !== "sales-orders") {
    throw invalidInput("issuing is only accepted for sales orders");
  }
  return withV1Request(request, `api/v1/${key}/:id/issue`, async (_auth, context) => {
    const body = await readV1JsonObject(request);
    requireV1IdempotencyKey(request);
    const creditOverrideReason =
      typeof body.creditOverrideReason === "string" ? body.creditOverrideReason : undefined;
    const outcome = await issueApplicationOrder(context, {
      documentId: id,
      expectedUpdatedAt: body.expectedUpdatedAt as string,
      creditOverrideReason,
    });
    return { status: outcome.status, body: outcome.result };
  });
}

/** Convert an issued order — same writer as the order-cycle convert action. */
export function v1ConvertOrder(
  request: Request,
  typeKey: string,
  id: string,
): Promise<NextResponse> {
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
      expectedUpdatedAt:
        typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined,
      creditOverrideReason:
        typeof body.creditOverrideReason === "string" ? body.creditOverrideReason : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
      expectedKind: ORDER_TYPE_KIND[key],
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}
