import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { receiveInboundApEmail } from "./receive";

export const runtime = "nodejs";

const tokenParams = z.object({ token: z.string().max(64) });

/**
 * Inbound AP email webhook (Postmark, Mailgun, SendGrid or the generic JSON
 * format). Sessionless by design — the email provider holds no session — so
 * the address token in the path is the credential, verified first inside
 * receiveInboundApEmail: an unknown token answers 404 with no detail, an
 * inactive address 403, and a bad provider signature 401, all before any
 * state changes.
 */
export const POST = defineRoute({
  public: "token",
  params: tokenParams,
  handler: async ({ request, params: { token } }) => receiveInboundApEmail(request, token),
});
