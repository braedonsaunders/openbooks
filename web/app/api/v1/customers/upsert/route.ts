import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { readV1JsonObject, withV1Request } from "../../../../../lib/api/v1-request";
import {
  upsertApplicationCustomer,
  type CustomerUpsertAddress,
} from "../../../../../lib/application/customer-upsert";

export const runtime = "nodejs";

/**
 * POST /api/v1/customers/upsert — match a customer by id, external
 * reference, email, or unambiguous name, creating one when nothing matches.
 * Idempotent by construction: repeating the same match keys returns the
 * same party instead of minting a duplicate, so no Idempotency-Key header
 * is required.
 */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/customers/upsert", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const address = body.address;
    const outcome = await upsertApplicationCustomer(context, {
      id: body.id as string | undefined,
      externalRef: body.externalRef as string | undefined,
      externalSource: body.externalSource as string | undefined,
      email: body.email as string | undefined,
      name: body.name as string | undefined,
      kind: body.kind as string | undefined,
      phone: (body.phone ?? undefined) as string | null | undefined,
      address: (address ?? undefined) as CustomerUpsertAddress | undefined,
    });
    return { status: outcome.created ? 201 : 200, body: { id: outcome.id, created: outcome.created } };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
