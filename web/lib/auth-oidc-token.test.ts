import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyOidcIdToken } from "./auth-oidc-token";

function token(claimOverrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://id.example.test",
    sub: "subject-1",
    aud: "openbooks",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    nonce: "nonce-1",
    email: "user@example.test",
    email_verified: true,
    ...claimOverrides,
  })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  return {
    idToken: `${header}.${claims}.${signature}`,
    keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" }],
  };
}

test("OIDC ID-token validation verifies signature and security claims", () => {
  const fixture = token();
  assert.deepEqual(verifyOidcIdToken({
    ...fixture,
    issuer: "https://id.example.test",
    clientId: "openbooks",
    nonce: "nonce-1",
    nowEpoch: 1_900_000_100,
  }), {
    issuer: "https://id.example.test",
    subject: "subject-1",
    email: "user@example.test",
    emailVerified: true,
  });
});

test("OIDC ID-token validation rejects unverified email, nonce and audience", () => {
  for (const fixture of [
    token({ email_verified: false }),
    token({ nonce: "wrong" }),
    token({ aud: "another-client" }),
  ]) {
    assert.equal(verifyOidcIdToken({
      ...fixture,
      issuer: "https://id.example.test",
      clientId: "openbooks",
      nonce: "nonce-1",
      nowEpoch: 1_900_000_100,
    }), null);
  }
});

test("OIDC ID-token validation rejects a modified signed payload", () => {
  const fixture = token();
  const segments = fixture.idToken.split(".");
  segments[1] = Buffer.from(JSON.stringify({ sub: "attacker" })).toString("base64url");
  assert.equal(verifyOidcIdToken({
    ...fixture,
    idToken: segments.join("."),
    issuer: "https://id.example.test",
    clientId: "openbooks",
    nonce: "nonce-1",
    nowEpoch: 1_900_000_100,
  }), null);
});
