import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { CommerceError } from "@openbooks/engine/src/commerce/errors.ts";
import { receiveInboundEvent } from "@openbooks/engine/src/commerce/inbound.ts";
import { readBoundedBodyBytes } from "../../../../../lib/bounded-body";

export const runtime = "nodejs";

/**
 * Largest storefront delivery accepted: 5 MiB. The cap is enforced on the
 * actual streamed bytes before verification touches them, so an unbounded
 * body can never be buffered on this sessionless surface.
 */
const WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Refusal codes that mean "unverifiable delivery": the adapter computed
 * the refusal and named its remedy, so the route answers 401 with both.
 * Anything else is a real fault and throws. Adapter codes live beside
 * the generic channel codes because the route, not the adapter, owns
 * the HTTP mapping.
 */
const VERIFICATION_REFUSALS = new Set([
  "channel_webhook_signature_invalid",
  "channel_webhook_unverified",
  "shopify_webhook_id_missing",
  "shopify_topic_missing",
  "shopify_signature_missing",
  "shopify_signature_invalid",
]);

function isVerificationRefusal(code: string): boolean {
  return VERIFICATION_REFUSALS.has(code);
}

/**
 * Storefront webhook deliveries. Sessionless BY DESIGN: the provider holds
 * no session cookie and never sends an org header — the channel id in the
 * path resolves the organization, and the adapter verifies the HMAC over
 * the RAW bytes with the channel's sealed secret BEFORE anything is stored.
 * An unverifiable delivery is a 401 and is stored nowhere; an unknown
 * channel is a 404. 200 answers only after the event is durably stored
 * (processing follows on the scheduler scan).
 */
export const POST = defineRoute({
  // Sessionless by design (provider HMAC, no session cookie): the factory
  // performs no session check and leaves the raw body untouched — no body
  // schema, so verification still reads the exact delivered bytes. The path
  // stays public through the channel webhook pattern in proxy-policy.
  public: "token",
  handler: async ({ request: req, params }) => {
    const { id } = params as { id: string };
    const bounded = await readBoundedBodyBytes(req, WEBHOOK_MAX_BODY_BYTES);
    if (!bounded.ok) {
      return NextResponse.json(
        {
          error:
            bounded.reason === "too_large"
              ? "webhook delivery exceeds the 5 MiB size limit"
              : "malformed webhook delivery",
        },
        { status: bounded.reason === "too_large" ? 413 : 400 },
      );
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    try {
      const event = await receiveInboundEvent({ channelId: id, rawBody: bounded.bytes, headers });
      return NextResponse.json({ received: true, event: { id: event.id, status: event.status } });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      // Every verification refusal — a failed HMAC, a missing signature,
      // id or topic — answers 401 and stores nothing; only real faults
      // throw. The remedy travels with the refusal so the operator sees
      // what to fix instead of a bare status.
      if (error instanceof CommerceError && isVerificationRefusal(error.code)) {
        return NextResponse.json({ error: error.message, code: error.code, remedy: error.remedy }, { status: 401 });
      }
      throw error;
    }
  },
});
