import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  ACCEPTANCE_ADAPTERS,
  computeSurcharge,
  toMinorUnits,
} from "./payment-acceptance.ts";

test("computeSurcharge: percent, fixed, combined, and cap are exact", () => {
  assert.equal(
    computeSurcharge("100.0000", { calculation: "percent", percent: "2.9", fixed_amount: null, cap_amount: null }),
    "2.9000",
  );
  assert.equal(
    computeSurcharge("100.0000", { calculation: "fixed", percent: null, fixed_amount: "0.3000", cap_amount: null }),
    "0.3000",
  );
  assert.equal(
    computeSurcharge("100.0000", { calculation: "percent_plus_fixed", percent: "2.9", fixed_amount: "0.3000", cap_amount: null }),
    "3.2000",
  );
  assert.equal(
    computeSurcharge("10000.0000", { calculation: "percent", percent: "10", fixed_amount: null, cap_amount: "50.0000" }),
    "50.0000",
  );
});

test("toMinorUnits: cents, zero-decimal currencies, sub-minor rejection", () => {
  assert.equal(toMinorUnits("103.0000", "CAD"), "10300");
  assert.equal(toMinorUnits("0.0100", "USD"), "1");
  assert.equal(toMinorUnits("1500.0000", "JPY"), "1500");
  assert.throws(() => toMinorUnits("10.0050", "USD"), /sub-cent/);
  assert.throws(() => toMinorUnits("100.5000", "JPY"), /whole units/);
});

function stripeSignature(secret: string, body: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

test("stripe webhook: signature verified, tamper + replay rejected", () => {
  const secret = "whsec_test_123";
  const body = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", client_reference_id: "tok_abc", amount_total: 10300 } },
  });
  const ok = ACCEPTANCE_ADAPTERS.stripe.verifyWebhook({ "stripe-signature": stripeSignature(secret, body) }, body, {
    webhookSecret: secret,
  });
  assert.ok(ok);
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.externalRef, "cs_test_1");
  assert.equal(ok.linkToken, "tok_abc");
  assert.equal(ok.paidAmount, "103.0000");

  assert.equal(
    ACCEPTANCE_ADAPTERS.stripe.verifyWebhook({ "stripe-signature": stripeSignature("whsec_other", body) }, body, {
      webhookSecret: secret,
    }),
    null,
    "wrong secret rejected",
  );
  assert.equal(
    ACCEPTANCE_ADAPTERS.stripe.verifyWebhook({ "stripe-signature": stripeSignature(secret, body + "x") }, body + "x", {
      webhookSecret: secret,
    }),
    null,
    "tampered body rejected",
  );
  const stale = stripeSignature(secret, body, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(
    ACCEPTANCE_ADAPTERS.stripe.verifyWebhook({ "stripe-signature": stale }, body, { webhookSecret: secret }),
    null,
    "outside replay window rejected",
  );
});

test("adyen webhook: per-item HMAC verified", () => {
  const keyBytes = Buffer.alloc(32, 7);
  const hmacKey = keyBytes.toString("base64");
  const item = {
    pspReference: "PSP-1",
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference: "tok_xyz",
    amount: { value: 10300, currency: "CAD" },
    eventCode: "AUTHORISATION",
    success: "true",
    additionalData: {} as Record<string, string>,
  };
  const message = [
    item.pspReference,
    item.originalReference,
    item.merchantAccountCode,
    item.merchantReference,
    item.amount.value,
    item.amount.currency,
    item.eventCode,
    item.success,
  ].join(":");
  item.additionalData["metadata.hmacSignature"] = createHmac("sha256", keyBytes).update(message, "utf8").digest("base64");
  const body = JSON.stringify({ notificationItems: [{ NotificationRequestItem: item }] });

  const ok = ACCEPTANCE_ADAPTERS.adyen.verifyWebhook({}, body, { webhookSecret: hmacKey });
  assert.ok(ok);
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.externalRef, "PSP-1");
  assert.equal(ok.linkToken, "tok_xyz");

  const tampered = JSON.parse(body);
  tampered.notificationItems[0].NotificationRequestItem.amount.value = 99900;
  assert.equal(ACCEPTANCE_ADAPTERS.adyen.verifyWebhook({}, JSON.stringify(tampered), { webhookSecret: hmacKey }), null);
});

test("gocardless webhook: raw-body HMAC verified", () => {
  const secret = "gc-whsec";
  const body = JSON.stringify({
    events: [{ resource_type: "payments", action: "confirmed", links: { payment: "PM-1", billing_request: "BRQ-1" } }],
  });
  const sig = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const ok = ACCEPTANCE_ADAPTERS.gocardless.verifyWebhook({ "webhook-signature": sig }, body, { webhookSecret: secret });
  assert.ok(ok);
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.externalRef, "PM-1");
  assert.equal(ACCEPTANCE_ADAPTERS.gocardless.verifyWebhook({ "webhook-signature": "deadbeef" }, body, { webhookSecret: secret }), null);
});
