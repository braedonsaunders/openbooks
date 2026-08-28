import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  ACCEPTANCE_ADAPTERS,
  CLAIMABLE_FROM,
  computeSurcharge,
  normalizeAcceptanceProviderSettings,
  PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT,
  providerPaymentMethod,
  resolveAcceptanceProviderApiBase,
  testAcceptanceConnection,
  toMinorUnits,
  type WebhookEvent,
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

test("providerPaymentMethod: hosted checkout takes cards on Stripe/Adyen, debits on GoCardless", () => {
  assert.equal(providerPaymentMethod("stripe"), "card");
  assert.equal(providerPaymentMethod("adyen"), "card");
  assert.equal(providerPaymentMethod("gocardless"), "bank_debit");
});

function stripeSignature(secret: string, body: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

function stripeEvent(secret: string, type: string, obj: Record<string, unknown>, ageSeconds = 0): WebhookEvent | null {
  const body = JSON.stringify({ id: "evt_1", type, data: { object: obj } });
  return ACCEPTANCE_ADAPTERS.stripe.verifyWebhook(
    { "stripe-signature": stripeSignature(secret, body, Math.floor(Date.now() / 1000) - ageSeconds) },
    body,
    { webhookSecret: secret },
  );
}

test("stripe webhook: signature verified, tamper rejected", () => {
  const secret = "whsec_test_123";
  const ok = stripeEvent(secret, "checkout.session.completed", {
    id: "cs_test_1", client_reference_id: "tok_abc", amount_total: 10300,
  });
  assert.ok(ok);
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.externalRef, "cs_test_1");
  assert.equal(ok.linkToken, "tok_abc");
  assert.equal(ok.paidAmount, "103.0000");

  const zeroDecimal = stripeEvent(secret, "checkout.session.completed", {
    id: "cs_jpy_1", client_reference_id: "tok_jpy", amount_total: 1000, currency: "jpy",
  });
  assert.ok(zeroDecimal);
  assert.equal(zeroDecimal.paidCurrency, "JPY");
  assert.equal(zeroDecimal.paidAmount, "1000.0000", "Stripe zero-decimal amounts are already major units");

  const tamperedBody = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", client_reference_id: "tok_abc", amount_total: 10300 } },
  }) + "x";
  assert.equal(
    ACCEPTANCE_ADAPTERS.stripe.verifyWebhook({ "stripe-signature": stripeSignature(secret, tamperedBody) }, tamperedBody, {
      webhookSecret: secret,
    }),
    null,
    "tampered body rejected",
  );
  assert.equal(
    ACCEPTANCE_ADAPTERS.stripe.verifyWebhook({ "stripe-signature": stripeSignature("whsec_other", JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", client_reference_id: "tok_abc", amount_total: 10300 } },
    })) }, JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", client_reference_id: "tok_abc", amount_total: 10300 } },
    }), {
      webhookSecret: secret,
    }),
    null,
    "wrong secret rejected",
  );
});

test("stripe webhook: replay window accepts provider retries within 24h, rejects older and future", () => {
  const secret = "whsec_replay";
  const obj = { id: "cs_replay_1", client_reference_id: "tok_r", amount_total: 10300, payment_status: "paid" };
  // An outage backlog redelivery from an hour ago must still settle.
  assert.ok(stripeEvent(secret, "checkout.session.completed", obj, 3_600));
  // Just inside the window.
  assert.ok(stripeEvent(secret, "checkout.session.completed", obj, 23 * 3_600));
  // Outside the window.
  assert.equal(stripeEvent(secret, "checkout.session.completed", obj, 25 * 3_600), null);
  // Future-dated beyond the clock-skew allowance is always rejected.
  const futureBody = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: obj } });
  assert.equal(
    ACCEPTANCE_ADAPTERS.stripe.verifyWebhook(
      { "stripe-signature": stripeSignature(secret, futureBody, Math.floor(Date.now() / 1000) + 600) },
      futureBody,
      { webhookSecret: secret },
    ),
    null,
    "future-dated signature rejected",
  );
});

test("stripe webhook: signature-valid un-normalizable amounts are quarantined like unparseable bodies", () => {
  const secret = "whsec_stripe_malformed";
  const body = JSON.stringify({
    id: "evt_malformed",
    type: "checkout.session.completed",
    data: { object: { id: "cs_bad", client_reference_id: "tok_bad", amount_total: "103.5", currency: "cad" } },
  });
  const captured = captureConsoleError();
  let delivery;
  try {
    delivery = ACCEPTANCE_ADAPTERS.stripe.verifyWebhookDelivery(
      { "stripe-signature": stripeSignature(secret, body) },
      body,
      { webhookSecret: secret },
    );
  } finally {
    captured.restore();
  }
  assert.equal(delivery.signatureValid, true, "malformed content must not downgrade authentication");
  assert.deepEqual(delivery.events, [], "an un-normalizable authenticated event must not settle or crash");

  const emitted = captured.logs
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.event === PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT);
  assert.equal(emitted.length, 1, `expected one quarantine emission, got ${JSON.stringify(captured.logs)}`);
  assert.deepEqual(
    {
      provider: emitted[0]!.provider,
      externalRef: emitted[0]!.externalRef,
      itemTypeOrCode: emitted[0]!.itemTypeOrCode,
    },
    { provider: "stripe", externalRef: "cs_bad", itemTypeOrCode: "checkout.session.completed" },
  );
  assert.match(String(emitted[0]!.error), /103\.5/);
});

test("stripe webhook: unpaid async completion stays in flight until the async terminal events", () => {
  const secret = "whsec_async";
  const session = { id: "cs_async_1", client_reference_id: "tok_async", amount_total: 10300, payment_intent: "pi_async_1" };

  const unpaid = stripeEvent(secret, "checkout.session.completed", { ...session, payment_status: "unpaid" });
  assert.ok(unpaid);
  assert.equal(unpaid.status, "processing");
  assert.equal(unpaid.paidAmount, null);
  assert.equal(unpaid.intentRef, "pi_async_1");

  const noPaymentRequired = stripeEvent(secret, "checkout.session.completed", { ...session, payment_status: "no_payment_required" });
  assert.ok(noPaymentRequired);
  assert.equal(noPaymentRequired.status, "succeeded");

  const asyncOk = stripeEvent(secret, "checkout.session.async_payment_succeeded", session);
  assert.ok(asyncOk);
  assert.equal(asyncOk.status, "succeeded");
  assert.equal(asyncOk.externalRef, "cs_async_1");
  assert.equal(asyncOk.paidAmount, "103.0000");

  const asyncFailed = stripeEvent(secret, "checkout.session.async_payment_failed", session);
  assert.ok(asyncFailed);
  assert.equal(asyncFailed.status, "failed");
  assert.equal(asyncFailed.externalRef, "cs_async_1");
});

test("stripe webhook: refunds and disputes key off the persisted payment intent", () => {
  const secret = "whsec_refund";
  const refund = stripeEvent(secret, "charge.refunded", { id: "ch_1", payment_intent: "pi_async_1" });
  assert.ok(refund);
  assert.equal(refund.status, "refunded");
  assert.equal(refund.externalRef, "pi_async_1");
  assert.equal(refund.intentRef, "pi_async_1", "refunds must set intentRef so resolution matches the session-keyed attempt");

  const dispute = stripeEvent(secret, "charge.dispute.created", { id: "dp_1", payment_intent: "pi_async_1" });
  assert.ok(dispute);
  assert.equal(dispute.status, "refunded");
  assert.equal(dispute.externalRef, "pi_async_1");
  assert.equal(dispute.intentRef, "pi_async_1");
});

test("webhook claims: only pre-terminal states are claimable so redeliveries dedupe", () => {
  assert.deepEqual(CLAIMABLE_FROM.succeeded, ["initiated"]);
  assert.deepEqual(CLAIMABLE_FROM.processing, ["initiated"]);
  assert.deepEqual(CLAIMABLE_FROM.failed, ["initiated"]);
  assert.deepEqual(CLAIMABLE_FROM.cancelled, ["initiated"]);
  // Refunds arrive after settlement succeeded — or before it ever settled.
  assert.deepEqual(CLAIMABLE_FROM.refunded, ["succeeded", "initiated"]);
  // No event may re-claim a settled or refunded attempt back into motion.
  for (const status of Object.keys(CLAIMABLE_FROM) as (keyof typeof CLAIMABLE_FROM)[]) {
    assert.ok(!CLAIMABLE_FROM[status].includes("refunded"), `${status} must not claim a refunded attempt`);
    if (status !== "refunded") {
      assert.ok(!CLAIMABLE_FROM[status].includes("succeeded"), `${status} must not claim a settled attempt`);
    }
  }
});

test("adyen webhook: per-item HMAC verified", () => {
  const keyBytes = Buffer.alloc(32, 7);
  const hmacKey = keyBytes.toString("base64");
  const { body } = signedAdyenDelivery(keyBytes, [{
    pspReference: "PSP-1",
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference: "tok_xyz",
    amount: { value: 10300, currency: "CAD" },
    eventCode: "AUTHORISATION",
    success: "true",
  }]);

  const ok = ACCEPTANCE_ADAPTERS.adyen.verifyWebhook({}, body, { webhookSecret: hmacKey });
  assert.ok(ok);
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.externalRef, "PSP-1");
  assert.equal(ok.linkToken, "tok_xyz");

  const tampered = JSON.parse(body);
  tampered.notificationItems[0].NotificationRequestItem.amount.value = 99900;
  assert.equal(ACCEPTANCE_ADAPTERS.adyen.verifyWebhook({}, JSON.stringify(tampered), { webhookSecret: hmacKey }), null);
});

/** Build an Adyen delivery whose every item carries its own valid HMAC. */
function signedAdyenDelivery(
  keyBytes: Buffer,
  items: Record<string, any>[],
): { body: string } {
  for (const item of items) {
    const message = [
      item.pspReference ?? "",
      item.originalReference ?? "",
      item.merchantAccountCode ?? "",
      item.merchantReference ?? "",
      item.amount?.value ?? "",
      item.amount?.currency ?? "",
      item.eventCode ?? "",
      item.success ?? "",
    ].join(":");
    item.additionalData = {
      ...item.additionalData,
      "metadata.hmacSignature": createHmac("sha256", keyBytes).update(message, "utf8").digest("base64"),
    };
  }
  return { body: JSON.stringify({ notificationItems: items.map((item) => ({ NotificationRequestItem: item })) }) };
}

function captureConsoleError(): { logs: string[]; restore: () => void } {
  const originalConsoleError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return { logs, restore: () => { console.error = originalConsoleError; } };
}

test("adyen webhook: a signature-valid malformed item is isolated without starving its signed siblings", () => {
  const hmacKey = Buffer.alloc(32, 11).toString("base64");
  // The HMAC is valid — the signature covers the fractional value — so this
  // delivery authenticates, yet exact minor-unit normalization cannot parse it.
  const malformed = {
    pspReference: "PSP-BAD",
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference: "tok_bad",
    amount: { value: "103.5", currency: "CAD" },
    eventCode: "AUTHORISATION",
    success: "true",
  };
  const sibling = {
    pspReference: "PSP-GOOD",
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference: "tok_good",
    amount: { value: 10300, currency: "CAD" },
    eventCode: "AUTHORISATION",
    success: "true",
  };
  const { body } = signedAdyenDelivery(Buffer.alloc(32, 11), [malformed, sibling]);

  const captured = captureConsoleError();
  let delivery;
  try {
    delivery = ACCEPTANCE_ADAPTERS.adyen.verifyWebhookDelivery({}, body, { webhookSecret: hmacKey });
  } finally {
    captured.restore();
  }

  assert.equal(delivery.signatureValid, true, "malformed content must not downgrade authentication");
  assert.deepEqual(
    delivery.events.map((event) => [event.externalRef, event.status, event.paidAmount]),
    [["PSP-GOOD", "succeeded", "103.0000"]],
    "the malformed item is quarantined while its later signed sibling still normalizes",
  );

  const emitted = captured.logs
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.event === PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT);
  assert.equal(emitted.length, 1, `expected one quarantine emission, got ${JSON.stringify(captured.logs)}`);
  assert.deepEqual(
    {
      provider: emitted[0]!.provider,
      externalRef: emitted[0]!.externalRef,
      itemTypeOrCode: emitted[0]!.itemTypeOrCode,
    },
    { provider: "adyen", externalRef: "PSP-BAD", itemTypeOrCode: "AUTHORISATION" },
  );
  assert.match(String(emitted[0]!.error), /103\.5/);
  assert.match(String(emitted[0]!.at), /^\d{4}-\d{2}-\d{2}T/);
});

test("adyen webhook: a delivery whose only actionable item is malformed stays authenticated and unhandled", () => {
  const hmacKey = Buffer.alloc(32, 13).toString("base64");
  // Fractional JSON *number* hits BigInt's RangeError branch (the sibling
  // test above covers the string/SyntaxError branch).
  const { body } = signedAdyenDelivery(Buffer.alloc(32, 13), [{
    pspReference: "PSP-NUMBER",
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference: "tok_number",
    amount: { value: 99.95, currency: "USD" },
    eventCode: "AUTHORISATION",
    success: "true",
  }]);

  const captured = captureConsoleError();
  let delivery;
  try {
    delivery = ACCEPTANCE_ADAPTERS.adyen.verifyWebhookDelivery({}, body, { webhookSecret: hmacKey });
  } finally {
    captured.restore();
  }
  assert.equal(delivery.signatureValid, true);
  assert.deepEqual(delivery.events, [], "an un-normalizable authenticated item must not settle or crash");

  const capturedSecond = captureConsoleError();
  let firstEvent;
  try {
    firstEvent = ACCEPTANCE_ADAPTERS.adyen.verifyWebhook({}, body, { webhookSecret: hmacKey });
  } finally {
    capturedSecond.restore();
  }
  assert.equal(firstEvent, null);
});

test("adyen webhook: success flags normalize boolean and case variants", () => {
  const keyBytes = Buffer.alloc(32, 17);
  const secret = keyBytes.toString("base64");

  const { body: boolBody } = signedAdyenDelivery(Buffer.from(keyBytes), [{
    pspReference: "PSP-BOOL",
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference: "tok_bool",
    amount: { value: 10300, currency: "CAD" },
    eventCode: "AUTHORISATION",
    success: true,
  }]);
  const boolEvent = ACCEPTANCE_ADAPTERS.adyen.verifyWebhook({}, boolBody, { webhookSecret: secret });
  assert.ok(boolEvent);
  assert.equal(boolEvent.status, "succeeded");
  assert.equal(boolEvent.externalRef, "PSP-BOOL");

  const { body: capsBody } = signedAdyenDelivery(Buffer.from(keyBytes), [{
    pspReference: "PSP-CAPS",
    originalReference: "",
    merchantAccountCode: "TestMerchant",
    merchantReference: "tok_caps",
    amount: { value: 10300, currency: "CAD" },
    eventCode: "AUTHORISATION",
    success: " TRUE ",
  }]);
  const capsEvent = ACCEPTANCE_ADAPTERS.adyen.verifyWebhook({}, capsBody, { webhookSecret: secret });
  assert.ok(capsEvent);
  assert.equal(capsEvent.status, "succeeded");
  assert.equal(capsEvent.externalRef, "PSP-CAPS");
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
  // Checkout keyed the attempt on the billing request; payment events must
  // expose it so resolution can match either side.
  assert.equal(ok.alternateExternalRef, "BRQ-1");
  assert.equal(ok.linkToken, null);
  assert.equal(ACCEPTANCE_ADAPTERS.gocardless.verifyWebhook({ "webhook-signature": "deadbeef" }, body, { webhookSecret: secret }), null);
});

test("gocardless webhook: payment lifecycle events resolve against the billing request", () => {
  const secret = "gc-lifecycle";
  const event = (action: string) => JSON.stringify({
    events: [{ resource_type: "payments", action, links: { payment: "PM-9", billing_request: "BRQ-9" } }],
  });
  const verify = (action: string) => {
    const payload = event(action);
    return ACCEPTANCE_ADAPTERS.gocardless.verifyWebhook(
      { "webhook-signature": createHmac("sha256", secret).update(payload, "utf8").digest("hex") },
      payload,
      { webhookSecret: secret },
    );
  };

  const paidOut = verify("paid_out");
  assert.ok(paidOut);
  assert.equal(paidOut.status, "succeeded");
  assert.equal(paidOut.externalRef, "PM-9");
  assert.equal(paidOut.alternateExternalRef, "BRQ-9");

  const failed = verify("failed");
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.externalRef, "PM-9");
  assert.equal(failed.alternateExternalRef, "BRQ-9");

  const chargedBack = verify("charged_back");
  assert.ok(chargedBack);
  assert.equal(chargedBack.status, "refunded");
  assert.equal(chargedBack.externalRef, "PM-9");
  assert.equal(chargedBack.alternateExternalRef, "BRQ-9");
});

test("payment provider API bases accept only published HTTPS endpoints", () => {
  assert.equal(resolveAcceptanceProviderApiBase("stripe"), "https://api.stripe.com");
  assert.equal(
    resolveAcceptanceProviderApiBase("gocardless", "https://api.gocardless.com/"),
    "https://api.gocardless.com",
  );
  for (const base of [
    "https://checkout-test.adyen.com/v72",
    "https://prefix-checkout-live.adyenpayments.com/checkout/v72",
    "https://prefix-checkout-live-au.adyenpayments.com/checkout/v72",
    "https://prefix-checkout-live-us.adyenpayments.com/checkout/v72",
    "https://prefix-checkout-live-apse.adyenpayments.com/checkout/v72",
  ]) {
    assert.equal(resolveAcceptanceProviderApiBase("adyen", base), base);
  }

  const rejected: Array<["stripe" | "adyen" | "gocardless", string]> = [
    ["stripe", "http://127.0.0.1"],
    ["stripe", "https://api.stripe.com.evil.invalid"],
    ["adyen", "https://checkout-test.adyen.com@127.0.0.1/v71"],
    ["adyen", "https://prefix-checkout-live.adyenpayments.com.evil.invalid/checkout/v72"],
    ["adyen", "https://checkout-test.adyen.com:8443/v71"],
    ["gocardless", "https://api.gocardless.com/?next=http://127.0.0.1"],
  ];
  for (const [provider, base] of rejected) {
    assert.throws(() => resolveAcceptanceProviderApiBase(provider, base), /not allowlisted/);
  }

  assert.deepEqual(
    normalizeAcceptanceProviderSettings("adyen", {
      merchantAccount: "merchant",
      apiBase: " https://checkout-test.adyen.com/v72/ ",
    }),
    { merchantAccount: "merchant", apiBase: "https://checkout-test.adyen.com/v72" },
  );
});

test("payment provider requests refuse redirects and reject unsafe bases before fetch", async () => {
  const checkout = {
    linkToken: "link-token",
    description: "Invoice INV-1",
    invoiceAmount: "10.0000",
    surchargeAmount: "0.0000",
    currency: "USD",
    returnUrl: "https://merchant.example/pay/link-token",
  };
  const redirectModes: string[] = [];

  await ACCEPTANCE_ADAPTERS.stripe.createCheckout(
    { apiKey: "stripe-key" },
    checkout,
    async (_url, init) => {
      redirectModes.push(init.redirect);
      return { status: 200, json: async () => ({ id: "cs_1", url: "https://checkout.stripe.com/cs_1" }) };
    },
  );
  await ACCEPTANCE_ADAPTERS.adyen.createCheckout(
    { apiKey: "adyen-key", merchantAccount: "merchant" },
    checkout,
    async (_url, init) => {
      redirectModes.push(init.redirect);
      return { status: 200, json: async () => ({ id: "adyen-1", url: "https://checkoutshopper-test.adyen.com/adyen-1" }) };
    },
  );
  await ACCEPTANCE_ADAPTERS.gocardless.createCheckout(
    { apiKey: "gocardless-key" },
    checkout,
    async (url, init) => {
      redirectModes.push(init.redirect);
      return url.endsWith("/billing_requests")
        ? { status: 200, json: async () => ({ billing_requests: { id: "BRQ-1" } }) }
        : { status: 200, json: async () => ({ billing_request_flows: { authorisation_url: "https://pay.gocardless.com/flow-1" } }) };
    },
  );
  assert.deepEqual(redirectModes, ["error", "error", "error", "error"]);

  let fetched = false;
  const result = await testAcceptanceConnection(
    "gocardless",
    { apiKey: "secret", apiBase: "http://127.0.0.1" },
    async () => {
      fetched = true;
      return { status: 200, json: async () => ({}) };
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /not allowlisted/);
  assert.equal(fetched, false);
});
