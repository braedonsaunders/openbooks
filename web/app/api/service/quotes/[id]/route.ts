import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { saveServiceQuoteTerms } from "@openbooks/engine/service/quotes";
import { idParams, quoteTermsBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Save an estimate's service terms: the optional add-on lines and the deposit. */
export const PUT = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: quoteTermsBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await saveServiceQuoteTerms({ ...serviceActor(authz), quoteDocumentId: params.id, ...body }),
    ),
});
