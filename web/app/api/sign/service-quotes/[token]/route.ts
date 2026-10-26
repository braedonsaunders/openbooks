import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  acceptServiceQuote,
  declineServiceQuote,
  publicServiceQuoteView,
} from "@openbooks/engine/service/quotes";
import { publicQuoteAnswerBody, tokenParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/**
 * Hosted service-quote acceptance, authenticated by possession of the link
 * token. The quote is re-validated on every request: a changed, withdrawn,
 * expired or answered quote refuses by name.
 */
export const GET = defineRoute({
  public: "token",
  params: tokenParams,
  invalidParamsNotFound: "record",
  handler: async ({ params }) => NextResponse.json(await publicServiceQuoteView(params.token)),
});

/** Accept with the chosen add-ons, or decline. */
export const POST = defineRoute({
  public: "token",
  params: tokenParams,
  invalidParamsNotFound: "record",
  body: publicQuoteAnswerBody,
  handler: async ({ params, body, request }) => {
    if (body.answer === "decline") {
      await declineServiceQuote({
        token: params.token,
        name: body.name,
        reason: body.reason ?? null,
      });
      return NextResponse.json({ answer: "declined" });
    }
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    const accepted = await acceptServiceQuote({
      token: params.token,
      name: body.name,
      selectedOptionalLineIds: body.selectedOptionalLineIds,
      signatureSvg: body.signatureSvg ?? null,
      ip: forwarded,
      userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
    });
    return NextResponse.json({ answer: "accepted", ...accepted });
  },
});
