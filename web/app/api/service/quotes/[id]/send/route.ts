import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { sendServiceQuote } from "@openbooks/engine/service/quotes";
import { deliverServiceQuote } from "@/lib/service/delivery";
import { idParams, sendQuoteBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Send an issued estimate for acceptance; the link is emailed when the organization's mailbox is ready and always returned. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: sendQuoteBody,
  handler: async ({ authz, params, body, request }) => {
    const { message, ...signer } = body;
    const actor = serviceActor(authz);
    const sent = await sendServiceQuote({ ...actor, quoteDocumentId: params.id, ...signer });
    const delivery = await deliverServiceQuote({
      ...actor,
      request,
      sent,
      quoteDocumentId: params.id,
      message,
    });
    return NextResponse.json({ requestId: sent.requestId, expiresAt: sent.expiresAt, ...delivery });
  },
});
