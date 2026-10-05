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
 * Storefront webhook deliveries. Sessionless BY DESIGN: the provider holds
 * no session cookie and never sends an org header — the channel id in the
 * path resolves the organization, and the adapter verifies the HMAC over
 * the RAW bytes with the channel's sealed secret BEFORE anything is stored.
 * An unverifiable delivery is a 401 and is stored nowhere; an unknown
 * channel is a 404. 200 answers only after the event is durably stored
 * (processing follows on the scheduler scan).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
    if (
      error instanceof CommerceError &&
      (error.code === "channel_webhook_signature_invalid" || error.code === "channel_webhook_unverified")
    ) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    }
    throw error;
  }
}
