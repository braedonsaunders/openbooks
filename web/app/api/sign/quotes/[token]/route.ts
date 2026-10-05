import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  declineQuoteSignature,
  publicQuoteSignView,
  signQuoteSignature,
} from "@openbooks/engine/billing/quote-to-cash";

const signBody = z.object({
  action: z.enum(["sign", "decline"]),
  name: z.string(),
  signatureSvg: z.string().nullish(),
});

/**
 * Public quote signing endpoint — possession-authenticated by the link
 * token, no session. GET opens the page state (recording first view);
 * POST signs or declines. Every use re-validates the request row:
 * voided, expired, and consumed links refuse by name. No feature gate:
 * a link the org sent must explain itself even after the switch flips.
 */
export const GET = defineRoute({
  public: "token",
  handler: async ({ params: routeParams }) => {
    try {
      const { token } = routeParams as { token: string };
      return NextResponse.json(await publicQuoteSignView(token));
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "token",
  body: signBody,
  handler: async ({ request: req, params: routeParams, body }) => {
    try {
      const { token } = routeParams as { token: string };
      const forwarded = req.headers.get("x-forwarded-for");
      const ip = forwarded ? forwarded.split(",")[0]!.trim() : null;
      const userAgent = req.headers.get("user-agent");
      if (body.action === "decline") {
        return NextResponse.json(await declineQuoteSignature({ token, name: body.name }));
      }
      return NextResponse.json(
        await signQuoteSignature({
          token,
          name: body.name,
          ip,
          userAgent,
          signatureSvg: body.signatureSvg,
        }),
      );
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
