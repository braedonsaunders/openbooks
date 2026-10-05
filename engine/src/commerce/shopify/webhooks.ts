import { createHmac, timingSafeEqual } from "node:crypto";
import { CommerceError } from "../errors.ts";

/**
 * Shopify webhook verification over the delivery's RAW bytes: base64
 * HMAC-SHA256 with the channel's webhook secret (the Shopify app secret
 * stored at connect time), compared constant-time. Pure — no database, so
 * the inbound route verifies before anything is stored. Returns the
 * provider event id and topic, or throws a CommerceError naming the
 * failure; a failed verification stores nothing.
 */
export function verifyShopifyWebhook(
  rawBody: Buffer,
  headers: Record<string, string>,
  secret: string,
): { eventId: string; topic: string } {
  const lowered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value;
  const eventId = (lowered["x-shopify-webhook-id"] ?? "").trim();
  if (!eventId) {
    throw new CommerceError(
      "shopify_webhook_id_missing",
      "The Shopify delivery carries no X-Shopify-Webhook-Id header.",
      "Accept the delivery only from Shopify webhook subscriptions, which always send a webhook id; unexpected senders are refused.",
      { field: null },
    );
  }
  const topic = (lowered["x-shopify-topic"] ?? "").trim();
  if (!topic) {
    throw new CommerceError(
      "shopify_topic_missing",
      "The Shopify delivery carries no X-Shopify-Topic header.",
      "Accept the delivery only from Shopify webhook subscriptions, which always send a topic; unexpected senders are refused.",
      { field: null },
    );
  }
  const received = (lowered["x-shopify-hmac-sha256"] ?? "").trim();
  if (!received) {
    throw new CommerceError(
      "shopify_signature_missing",
      "The Shopify delivery carries no X-Shopify-Hmac-Sha256 signature.",
      "Check the channel's webhook secret under Channels → Settings matches the Shopify app secret, then ask Shopify to resend.",
      { field: null },
    );
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new CommerceError(
      "shopify_signature_invalid",
      "The Shopify delivery signature does not match its body.",
      "Check the channel's webhook secret under Channels → Settings matches the Shopify app secret; a mismatch means the body was altered or the wrong secret is stored.",
      { field: null },
    );
  }
  return { eventId, topic };
}

/** The shop domain a delivery claims to come from, or null when absent. */
export function shopifyDeliveryShop(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-shopify-shop-domain") {
      const shop = value.trim().toLowerCase();
      return shop === "" ? null : shop;
    }
  }
  return null;
}
