import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../lib/application/errors";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../lib/api/v1-request";
import { v1ListRecords } from "../../../../lib/api/v1-records";
import { createPayment } from "../../../../lib/application/payments";

export const runtime = "nodejs";

/** GET /api/v1/payments — list vendor payments and customer receipts. */
export async function GET(request: Request): Promise<NextResponse> {
  return v1ListRecords(request, "payments", "api/v1/payments");
}

/** POST /api/v1/payments — create a vendor payment or customer receipt draft. */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/payments", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    if (body.kind !== "vendor_payment" && body.kind !== "customer_payment") {
      throw new ApplicationError("invalid_input", "kind must be vendor_payment or customer_payment", 422);
    }
    const outcome = await createPayment(context, {
      kind: body.kind,
      partyId: typeof body.partyId === "string" ? body.partyId : null,
      bankAccountId: typeof body.bankAccountId === "string" ? body.bankAccountId : null,
      documentDate: typeof body.documentDate === "string" ? body.documentDate : undefined,
      memo: typeof body.memo === "string" ? body.memo : null,
      subsidiaryId: typeof body.subsidiaryId === "string" ? body.subsidiaryId : null,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      fxRate: typeof body.fxRate === "string" ? body.fxRate : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 201, body: outcome.result, replayed: outcome.replayed };
  });
}
