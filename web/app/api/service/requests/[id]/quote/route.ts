import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService } from "@/lib/service/authority";
import { startServiceQuote } from "@/lib/service/quotes";
import { idParams, startQuoteBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Start a quote for the request as a native draft estimate carrying service terms. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: startQuoteBody,
  handler: async ({ authz, params, body }) => {
    const quote = await startServiceQuote(authz, {
      requestId: params.id,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(quote, { status: quote.replayed ? 200 : 201 });
  },
});
