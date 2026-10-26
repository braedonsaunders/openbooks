import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { convertServiceQuote } from "@openbooks/engine/service/quotes";
import { convertQuoteBody, idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Convert an accepted quote to a service job with the scope the customer accepted. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: convertQuoteBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await convertServiceQuote({ ...serviceActor(authz), quoteDocumentId: params.id, ...body }),
      { status: 201 },
    ),
});
