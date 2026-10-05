import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { verifyShopifyWebhook } from "./webhooks.ts";

const SECRET = "shpss_fixed_test_secret_0123456789";
const BODY = Buffer.from(JSON.stringify({ id: 987, sku: "WIDGET-1" }), "utf8");

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  const hmac = createHmac("sha256", SECRET).update(BODY).digest("base64");
  return {
    "X-Shopify-Hmac-Sha256": hmac,
    "X-Shopify-Topic": "products/update",
    "X-Shopify-Webhook-Id": "evt-001",
    "X-Shopify-Shop-Domain": "demo.myshopify.com",
    ...overrides,
  };
}

test("a real Shopify HMAC vector verifies to event id and topic", () => {
  const verified = verifyShopifyWebhook(BODY, headers(), SECRET);
  assert.equal(verified.eventId, "evt-001");
  assert.equal(verified.topic, "products/update");
});

test("a tampered body refuses with the signature remedy", () => {
  const tampered = Buffer.from(JSON.stringify({ id: 987, sku: "WIDGET-999" }), "utf8");
  assert.throws(() => verifyShopifyWebhook(tampered, headers(), SECRET), /signature|HMAC/i);
});

test("a wrong secret refuses instead of storing", () => {
  assert.throws(() => verifyShopifyWebhook(BODY, headers(), "wrong-secret"), /signature|HMAC/i);
});

test("a delivery without an event id refuses by name", () => {
  const withoutId = headers();
  delete withoutId["X-Shopify-Webhook-Id"];
  assert.throws(() => verifyShopifyWebhook(BODY, withoutId, SECRET), /webhook-?id/i);
});

test("a delivery without a topic refuses by name", () => {
  const withoutTopic = headers();
  delete withoutTopic["X-Shopify-Topic"];
  assert.throws(() => verifyShopifyWebhook(BODY, withoutTopic, SECRET), /topic/i);
});

test("header names verify case-insensitively", () => {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers())) lower[key.toLowerCase()] = value;
  const verified = verifyShopifyWebhook(BODY, lower, SECRET);
  assert.equal(verified.eventId, "evt-001");
});
