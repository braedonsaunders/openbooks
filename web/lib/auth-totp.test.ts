import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBase32,
  encodeBase32,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  totpCode,
  verifyRecoveryCodeHash,
  verifyTotpCode,
} from "./auth-totp";

test("base32 round-trips binary TOTP secrets", () => {
  const bytes = Buffer.from("12345678901234567890", "ascii");
  assert.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
});

test("TOTP generation matches the RFC 6238 SHA-1 vector", () => {
  const secret = encodeBase32(Buffer.from("12345678901234567890", "ascii"));
  assert.equal(totpCode(secret, 59_000, { digits: 8 })?.code, "94287082");
});

test("TOTP verification accepts clock skew and rejects replay", () => {
  const secret = encodeBase32(Buffer.from("12345678901234567890", "ascii"));
  const now = 1_700_000_000_000;
  const current = totpCode(secret, now)!;
  assert.equal(verifyTotpCode(secret, current.code, now), current.step);
  assert.equal(verifyTotpCode(secret, current.code, now, current.step), null);
  assert.equal(verifyTotpCode(secret, "000000", now), null);
});

test("recovery codes are normalized without reducing entropy", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0]!, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(normalizeRecoveryCode(codes[0]!.toLowerCase()), codes[0]!.replaceAll("-", ""));
});

test("recovery codes use salted hashes independent of the session signing key", () => {
  const userId = "018f0000-0000-7000-8000-000000000001";
  const code = "ABCDEFGH2345";
  const first = hashRecoveryCode(userId, code);
  const second = hashRecoveryCode(userId, code);
  assert.notEqual(first, second);
  assert.match(first, /^s1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(verifyRecoveryCodeHash(userId, code, first), true);
  assert.equal(verifyRecoveryCodeHash(userId, "ABCDEFGH2346", first), false);
  assert.equal(verifyRecoveryCodeHash("018f0000-0000-7000-8000-000000000002", code, first), false);
});
