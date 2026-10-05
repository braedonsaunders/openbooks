import assert from "node:assert/strict";
import { test } from "node:test";
import { isWebhookEventType, parseWebhookPayload, WEBHOOK_EVENT_TYPES } from "./catalog.ts";
import { minorUnitsOf } from "./emit.ts";
import {
  buildSignatureHeader,
  classifyDeliveryResponse,
  deliveryBackoffMs,
  deliveryUrlRefusal,
  verifyWebhookSignature,
} from "./deliver.ts";

test("the catalog names the documented domain events", () => {
  for (const type of [
    "document.posted",
    "document.voided",
    "payment.received",
    "item.updated",
    "customer.updated",
    "invoice.overdue",
    "inventory.available_changed",
    "subscription.changed",
    "channel_order.exception",
  ]) {
    assert.ok(isWebhookEventType(type), `${type} is catalogued`);
  }
  assert.equal(isWebhookEventType("order.shipped"), false);
  assert.throws(
    () =>
      parseWebhookPayload("document.posted", {
        v: 2,
        occurredAt: "2026-01-01T00:00:00.000Z",
        documentId: "00000000-0000-0000-0000-000000000000",
        kind: "customer_invoice",
        documentNumber: "INV-1",
        status: "posted",
        currency: "USD",
        totalMinor: "1000",
        documentDate: null,
        postingDate: null,
        partyId: null,
      }),
    (e: unknown) => e instanceof Error && /expected 1/.test(e.message),
    "unknown payload versions refuse",
  );
  parseWebhookPayload("document.posted", {
    v: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    documentId: "00000000-0000-0000-0000-000000000000",
    kind: "customer_invoice",
    documentNumber: "INV-1",
    status: "posted",
    currency: "USD",
    totalMinor: "1000",
    documentDate: null,
    postingDate: null,
    partyId: null,
  });
});

test("minor-unit snapshots convert exactly per currency exponent", () => {
  assert.equal(minorUnitsOf("10.00", "USD"), "1000");
  assert.equal(minorUnitsOf("10", "JPY"), "10");
  assert.equal(minorUnitsOf("10.000", "BHD"), "10000");
  assert.equal(minorUnitsOf("1.005", "USD"), "101", "half away from zero");
  assert.equal(minorUnitsOf("1.004", "USD"), "100");
  assert.equal(minorUnitsOf("-2.50", "USD"), "-250");
  assert.throws(() => minorUnitsOf("10.00", "XXX"), /no registered minor-unit exponent/);
});

test("endpoint URLs require https, except loopback in tests", () => {
  assert.equal(deliveryUrlRefusal("https://crm.example.com/hook"), null);
  assert.equal(deliveryUrlRefusal("http://127.0.0.1:3939/hook"), null);
  assert.equal(deliveryUrlRefusal("http://localhost:3939/hook"), null);
  assert.match(deliveryUrlRefusal("http://crm.example.com/hook") ?? "", /require https/);
  assert.match(deliveryUrlRefusal("ftp://crm.example.com/hook") ?? "", /refused/);
  assert.match(deliveryUrlRefusal("not a url") ?? "", /not a valid URL/);
});

test("signatures verify with the documented t.body scheme", () => {
  const secret = "s3cr3t";
  const body = '{"id":"1"}';
  const header = buildSignatureHeader(secret, 1_700_000_000, body);
  assert.equal(header, `t=1700000000,v1=${header.split("v1=")[1]}`);
  assert.equal(verifyWebhookSignature(secret, header, body, 1_700_000_000 * 1000), true);
  assert.equal(verifyWebhookSignature("other", header, body, 1_700_000_000 * 1000), false);
  assert.equal(verifyWebhookSignature(secret, header, '{"id":"2"}', 1_700_000_000 * 1000), false);
  assert.equal(verifyWebhookSignature(secret, header, body, 1_700_000_000 * 1000 + 10 * 60 * 1000), false, "stale timestamps refuse");
  assert.equal(verifyWebhookSignature(secret, "garbage", body), false);
});

test("response classification routes 2xx, 410, refusals and retries", () => {
  assert.equal(classifyDeliveryResponse(200, "").kind, "delivered");
  assert.equal(classifyDeliveryResponse(201, "").kind, "delivered");
  assert.equal(classifyDeliveryResponse(410, "").kind, "gone");
  assert.equal(classifyDeliveryResponse(400, "").kind, "refused");
  assert.equal(classifyDeliveryResponse(404, "").kind, "refused");
  assert.equal(classifyDeliveryResponse(429, "").kind, "retryable");
  assert.equal(classifyDeliveryResponse(500, "").kind, "retryable");
  assert.equal(classifyDeliveryResponse(503, "").kind, "retryable");
});

test("backoff starts within a minute and caps at six hours", () => {
  assert.ok(deliveryBackoffMs(1, () => 0.999999) <= 60_000);
  assert.ok(deliveryBackoffMs(1, () => 0) >= 0);
  assert.ok(deliveryBackoffMs(100, () => 0.999999) <= 6 * 60 * 60 * 1000);
  assert.ok(deliveryBackoffMs(2, () => 0.999999) <= 120_000);
  assert.ok(WEBHOOK_EVENT_TYPES.length >= 9, "the catalog carries every documented event");
});
