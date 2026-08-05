import assert from "node:assert/strict";
import test from "node:test";
import {
  challengeSigningInput,
  parseChallengeTokenFormat,
  parseSessionTokenFormat,
  sessionSigningInput,
} from "./auth-token-format";

const sessionId = "018f0000-0000-7000-8000-000000000001";
const userId = "018f0000-0000-7000-8000-000000000002";

test("stateful session tokens have a versioned, bounded format", () => {
  const parsed = parseSessionTokenFormat(`v2.${sessionId}.${userId}.2000000000.signature`);
  assert.deepEqual(parsed, {
    sessionId,
    userId,
    expiresEpoch: 2_000_000_000,
    payload: `v2.${sessionId}.${userId}.2000000000`,
    signature: "signature",
  });
  assert.equal(parseSessionTokenFormat(`v1.${userId}.2000000000.signature`), null);
  assert.equal(parseSessionTokenFormat(`v2.not-a-uuid.${userId}.2000000000.signature`), null);
});

test("MFA challenges use a distinct token version and signing domain", () => {
  assert.ok(parseChallengeTokenFormat(`m1.${sessionId}.${userId}.2000000000.signature`));
  assert.notEqual(
    sessionSigningInput(`v2.${sessionId}.${userId}.2000000000`),
    challengeSigningInput(`v2.${sessionId}.${userId}.2000000000`),
  );
});
