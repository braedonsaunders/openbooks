import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { lookupStoredValueBalance } from "../../../../../lib/application/stored-value";

const lookupBody = z.looseObject({
  code: z.string().min(1).max(64),
});

export const runtime = "nodejs";

/** POST /api/v1/stored-value/lookup — balance and status by gift card code, for storefront/POS use. */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/stored-value/lookup", async (_auth, context) => {
    const raw = await readV1JsonObject(request);
    const body = lookupBody.parse(raw);
    const result = await lookupStoredValueBalance(context, { code: body.code });
    return { status: 200, body: result };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
