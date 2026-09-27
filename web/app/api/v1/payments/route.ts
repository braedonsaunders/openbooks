import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApplicationError } from "../../../../lib/application/errors";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../lib/api/v1-request";
import { v1ListRecords } from "../../../../lib/api/v1-records";
import { createPayment } from "../../../../lib/application/payments";

const createPaymentBody = z.looseObject({
  kind: z.enum(["vendor_payment", "customer_payment"]),
  partyId: z.string().nullable().optional(),
  bankAccountId: z.string().nullable().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memo: z.string().max(2000).nullable().optional(),
  subsidiaryId: z.string().nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  fxRate: z.string().regex(/^\d+(?:\.\d{1,10})?$/).optional(),
});

export const runtime = "nodejs";

/** GET /api/v1/payments — list vendor payments and customer receipts. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return v1ListRecords(request, "payments", "api/v1/payments");
}

/** POST /api/v1/payments — create a vendor payment or customer receipt draft. */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/payments", async (_auth, context) => {
    const raw = await readV1JsonObject(request);
    if (raw.kind !== "vendor_payment" && raw.kind !== "customer_payment") {
      throw new ApplicationError("invalid_input", "kind must be vendor_payment or customer_payment", 422);
    }
    const body = createPaymentBody.parse(raw);
    const outcome = await createPayment(context, {
      kind: body.kind,
      partyId: body.partyId ?? null,
      bankAccountId: body.bankAccountId ?? null,
      documentDate: body.documentDate,
      memo: body.memo ?? null,
      subsidiaryId: body.subsidiaryId ?? null,
      currency: body.currency,
      fxRate: body.fxRate,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
