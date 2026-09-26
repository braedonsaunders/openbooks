import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import {
  describeSealedBlob,
  loadDataKeyRing,
  requireDataKey,
  sealJson,
  sealSecret,
  SecretIntegrityError,
  unsealJson,
  unsealSecret,
} from "./secrets.ts";

const K1_HEX = "01".repeat(32);
const K2_HEX = "02".repeat(32);
const K1_B64 = Buffer.from(K1_HEX, "hex").toString("base64");
const K2_B64 = Buffer.from(K2_HEX, "hex").toString("base64");

const savedEnv = {
  OPENBOOKS_DATA_KEY: process.env.OPENBOOKS_DATA_KEY,
  OPENBOOKS_DATA_KEYS: process.env.OPENBOOKS_DATA_KEYS,
  OPENBOOKS_DATA_KEY_ACTIVE: process.env.OPENBOOKS_DATA_KEY_ACTIVE,
};

function useSingleKey(hex: string = K1_HEX): void {
  delete process.env.OPENBOOKS_DATA_KEYS;
  delete process.env.OPENBOOKS_DATA_KEY_ACTIVE;
  process.env.OPENBOOKS_DATA_KEY = hex;
}

function useKeyRing(active: string): void {
  delete process.env.OPENBOOKS_DATA_KEY;
  process.env.OPENBOOKS_DATA_KEYS = `k1=${K1_B64},k2=${K2_B64}`;
  process.env.OPENBOOKS_DATA_KEY_ACTIVE = active;
}

test("sealed blobs round-trip and carry their key id", () => {
  useSingleKey();
  const scope = { orgId: "org-a", purpose: "connection.secrets" };
  const sealed = sealSecret("s3cret", scope);
  assert.ok(sealed.startsWith("enc:v2:k1:"), `v2 blob with key id, got ${sealed.slice(0, 16)}`);
  assert.deepEqual(describeSealedBlob(sealed), { version: "v2", keyId: "k1" });
  assert.equal(unsealSecret(sealed, scope), "s3cret");
  assert.equal(unsealJson(sealJson({ a: 1 }, scope), scope).a, 1);
});

test("a blob swapped into another org or purpose refuses naming all three", () => {
  useSingleKey();
  const a = { orgId: "org-a", purpose: "connection.secrets" };
  const sealed = sealSecret("s3cret", a);
  for (const scope of [
    { orgId: "org-b", purpose: "connection.secrets" },
    { orgId: "org-a", purpose: "fx.provider.secrets" },
  ]) {
    assert.throws(() => unsealSecret(sealed, scope), (error: unknown) => {
      assert.ok(error instanceof SecretIntegrityError);
      assert.equal(error.orgId, scope.orgId);
      assert.equal(error.purpose, scope.purpose);
      assert.equal(error.keyId, "k1");
      assert.match(error.message, /re-enter|rotate-data-key/);
      return true;
    });
  }
  // And the reverse swap refuses too: neither row reads the other's blob.
  const b = sealSecret("other", { orgId: "org-b", purpose: "connection.secrets" });
  assert.throws(() => unsealSecret(b, a), SecretIntegrityError);
});

test("tampered and malformed blobs refuse instead of reading as unconfigured", () => {
  useSingleKey();
  const scope = { orgId: "org-a", purpose: "connection.secrets" };
  const sealed = sealSecret("s3cret", scope);
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => unsealSecret(tampered, scope), SecretIntegrityError);
  assert.throws(() => unsealSecret("enc:v2:k1:broken", scope), SecretIntegrityError);
  assert.throws(() => unsealSecret("plaintext", scope), SecretIntegrityError);
  assert.throws(() => unsealJson(sealSecret("{not json", scope), scope), SecretIntegrityError);
});

test("legacy v1 blobs still open during the rotation window", () => {
  useSingleKey();
  const key = Buffer.from(K1_HEX, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
  const v1 = `enc:v1:${iv.toString("base64")}:${ct.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
  assert.deepEqual(describeSealedBlob(v1), { version: "v1", keyId: "k1" });
  assert.equal(unsealSecret(v1, { orgId: "org-a", purpose: "connection.secrets" }), "legacy");
});

test("rotation: new seals use the active key, retired keys refuse by name", () => {
  useKeyRing("k2");
  const scope = { orgId: "org-a", purpose: "connection.secrets" };
  assert.ok(sealSecret("new", scope).startsWith("enc:v2:k2:"));
  assert.equal(unsealSecret(sealSecret("new", scope), scope), "new");

  useSingleKey(K1_HEX);
  const k1Blob = sealSecret("old", scope);
  useKeyRing("k2");
  assert.equal(unsealSecret(k1Blob, scope), "old", "retired key still configured must open");

  delete process.env.OPENBOOKS_DATA_KEYS;
  process.env.OPENBOOKS_DATA_KEY = K2_HEX;
  assert.throws(() => unsealSecret(k1Blob, scope), (error: unknown) => {
    assert.ok(error instanceof SecretIntegrityError);
    assert.equal((error as SecretIntegrityError).keyId, "k1");
    return true;
  });
});

test("boot validation refuses missing, placeholder, and wrong-length keys", () => {
  delete process.env.OPENBOOKS_DATA_KEY;
  delete process.env.OPENBOOKS_DATA_KEYS;
  delete process.env.OPENBOOKS_DATA_KEY_ACTIVE;
  assert.throws(() => requireDataKey(), /OPENBOOKS_DATA_KEY is not set/);

  process.env.OPENBOOKS_DATA_KEY = "replace-me";
  assert.throws(() => requireDataKey(), /placeholder/);

  process.env.OPENBOOKS_DATA_KEY = "short";
  assert.throws(() => requireDataKey(), /exactly 32 bytes/);

  process.env.OPENBOOKS_DATA_KEYS = `k1=${K1_B64}`;
  delete process.env.OPENBOOKS_DATA_KEY_ACTIVE;
  assert.throws(() => requireDataKey(), /OPENBOOKS_DATA_KEY_ACTIVE/);

  process.env.OPENBOOKS_DATA_KEY_ACTIVE = "nope";
  assert.throws(() => requireDataKey(), /not in OPENBOOKS_DATA_KEYS/);

  process.env.OPENBOOKS_DATA_KEY_ACTIVE = "k1";
  assert.equal(requireDataKey(), "k1");
  assert.equal(loadDataKeyRing().activeId, "k1");

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
