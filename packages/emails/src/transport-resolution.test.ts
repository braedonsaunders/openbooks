import assert from "node:assert/strict";
import test from "node:test";
import { sealSecret } from "./crypto";
import { resolveEmailTransport, resolveEmailTransportDetailed } from "./transport";

test("an absent or disabled config resolves unconfigured, never unusable", () => {
  assert.deepEqual(resolveEmailTransportDetailed(null), { state: "unconfigured" });
  assert.deepEqual(resolveEmailTransportDetailed(undefined), { state: "unconfigured" });
  assert.deepEqual(resolveEmailTransportDetailed({}), { state: "unconfigured" });
  assert.deepEqual(
    resolveEmailTransportDetailed({ provider: "resend", enabled: false }),
    { state: "unconfigured" },
  );
  assert.deepEqual(resolveEmailTransport(null), null);
});

test("a configured resend provider with a sealed credential resolves ready", () => {
  const sealed = sealSecret("re_live_key");
  const resolved = resolveEmailTransportDetailed({
    provider: "resend",
    enabled: true,
    fromEmail: "billing@example.com",
    keyCiphertext: sealed.ciphertext,
    keyNonce: sealed.nonce,
  });
  assert.equal(resolved.state, "ready");
  if (resolved.state === "ready") {
    assert.equal(resolved.transport.provider, "resend");
  }
  assert.ok(resolveEmailTransport({
    provider: "resend",
    enabled: true,
    fromEmail: "billing@example.com",
    keyCiphertext: sealed.ciphertext,
    keyNonce: sealed.nonce,
  }));
});

test("a configured provider with a corrupt credential resolves unusable, not null-silenced", () => {
  // SESSION_SECRET rotation or storage corruption: the row still claims a
  // credential, but nothing unseals. The worker must fail and retry on this
  // named reason — acking it as "not configured" would drop every mail
  // forever with no alarm.
  const resolved = resolveEmailTransportDetailed({
    provider: "resend",
    enabled: true,
    fromEmail: "billing@example.com",
    keyCiphertext: "not-a-real-ciphertext",
    keyNonce: "not-a-real-nonce",
  });
  assert.equal(resolved.state, "unusable");
  if (resolved.state === "unusable") {
    assert.match(resolved.reason, /unseal/i);
  }
  assert.equal(
    resolveEmailTransport({
      provider: "resend",
      enabled: true,
      fromEmail: "billing@example.com",
      keyCiphertext: "not-a-real-ciphertext",
      keyNonce: "not-a-real-nonce",
    }),
    null,
  );
});

test("an enabled provider missing its credential resolves unusable with a remedy", () => {
  const resolved = resolveEmailTransportDetailed({
    provider: "resend",
    enabled: true,
    fromEmail: "billing@example.com",
  });
  assert.equal(resolved.state, "unusable");
  if (resolved.state === "unusable") {
    assert.match(resolved.reason, /credential/i);
  }
});
