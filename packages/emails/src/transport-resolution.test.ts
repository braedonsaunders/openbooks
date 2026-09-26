import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import test from "node:test";
import { resolvePublicHost, sealSecret, unsealLegacyEmailSecret } from "./crypto";
import { resolveEmailTransport, resolveEmailTransportDetailed } from "./transport";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
// The legacy-rotation case below pins the pre-move dev fallback key; a
// caller-supplied SESSION_SECRET would derive a different legacy key.
delete process.env.SESSION_SECRET;

const ORG = "org-1";

/** A pre-move SESSION_SECRET-derived blob, built the way the old writer did. */
function legacySeal(plain: string): { ciphertext: string; nonce: string } {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from("openbooks-dev-insecure-secret"), Buffer.alloc(0), Buffer.from("openbooks.secret.v1"), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString("base64"), nonce: iv.toString("base64") };
}

test("an absent config resolves unconfigured and SMTP refuses DNS resolving to loopback", async () => {
  assert.deepEqual(resolveEmailTransportDetailed(null, ORG), { state: "unconfigured" });
  assert.deepEqual(resolveEmailTransportDetailed(undefined, ORG), { state: "unconfigured" });
  assert.deepEqual(resolveEmailTransportDetailed({}, ORG), { state: "unconfigured" });
  await assert.rejects(resolvePublicHost("smtp.example", async () => ["127.0.0.1"]), /public unicast/);
  assert.deepEqual(resolveEmailTransport(null, ORG), null);
});

test("a configured resend provider with a data-key credential resolves ready", () => {
  const sealed = sealSecret("re_live_key", ORG);
  assert.ok(sealed.startsWith("enc:v2:"));
  const config = { provider: "resend", enabled: true, fromEmail: "billing@example.com", keySealed: sealed } as const;
  const resolved = resolveEmailTransportDetailed(config, ORG);
  assert.equal(resolved.state, "ready");
  if (resolved.state === "ready") {
    assert.equal(resolved.transport.provider, "resend");
  }
  assert.ok(resolveEmailTransport(config, ORG));
});

test("a data-key credential bound to another org resolves unusable, not null-silenced", () => {
  const resolved = resolveEmailTransportDetailed(
    { provider: "resend", enabled: true, fromEmail: "billing@example.com", keySealed: sealSecret("re_live_key", "org-2") },
    ORG,
  );
  assert.equal(resolved.state, "unusable");
  if (resolved.state === "unusable") {
    assert.match(resolved.reason, /unseal/i);
  }
});

test("a legacy session-secret credential still resolves through the rotation window", () => {
  const legacy = legacySeal("re_legacy_key");
  assert.equal(unsealLegacyEmailSecret(legacy), "re_legacy_key");
  const resolved = resolveEmailTransportDetailed(
    { provider: "resend", enabled: true, fromEmail: "billing@example.com", keyCiphertext: legacy.ciphertext, keyNonce: legacy.nonce },
    ORG,
  );
  assert.equal(resolved.state, "ready");
});

test("a configured provider with a corrupt credential resolves unusable, not null-silenced", () => {
  // Data-key rotation or storage corruption: the row still claims a
  // credential, but nothing unseals. The worker must fail and retry on this
  // named reason — acking it as "not configured" would drop every mail
  // forever with no alarm.
  const resolved = resolveEmailTransportDetailed(
    { provider: "resend", enabled: true, fromEmail: "billing@example.com", keySealed: "enc:v2:k1:broken" },
    ORG,
  );
  assert.equal(resolved.state, "unusable");
  if (resolved.state === "unusable") {
    assert.match(resolved.reason, /unseal/i);
  }
  assert.equal(
    resolveEmailTransport(
      { provider: "resend", enabled: true, fromEmail: "billing@example.com", keySealed: "enc:v2:k1:broken" },
      ORG,
    ),
    null,
  );
});

test("an enabled provider missing its credential resolves unusable with a remedy", () => {
  const resolved = resolveEmailTransportDetailed(
    { provider: "resend", enabled: true, fromEmail: "billing@example.com" },
    ORG,
  );
  assert.equal(resolved.state, "unusable");
  if (resolved.state === "unusable") {
    assert.match(resolved.reason, /credential/i);
  }
});
