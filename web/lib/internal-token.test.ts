import assert from "node:assert/strict";
import test from "node:test";
import { internalTokenMatches, parseInternalOrgId, requestHasInternalToken } from "./internal-token";

test("internalTokenMatches accepts only an exact, non-empty match", () => {
  assert.equal(internalTokenMatches("secret-token", "secret-token"), true);
  assert.equal(internalTokenMatches("secret-token", "secret-tokeN"), false);
  assert.equal(internalTokenMatches("secret", "secret-token"), false, "length mismatch never matches");
  assert.equal(internalTokenMatches("secret-token", "secret"), false);
});

test("internalTokenMatches fails closed when either side is missing", () => {
  // An unconfigured server must never accept an empty header as a match.
  assert.equal(internalTokenMatches("", ""), false);
  assert.equal(internalTokenMatches(null, ""), false);
  assert.equal(internalTokenMatches(undefined, undefined), false);
  assert.equal(internalTokenMatches("", "configured"), false);
  assert.equal(internalTokenMatches("configured", ""), false);
  assert.equal(internalTokenMatches("configured", null), false);
});

test("internalTokenMatches never throws on attacker-shaped input", () => {
  assert.equal(internalTokenMatches("é", "e"), false);
  assert.equal(internalTokenMatches("a".repeat(10_000), "b".repeat(10_000)), false);
  assert.equal(internalTokenMatches({} as unknown as string, "x"), false);
});

test("requestHasInternalToken reads x-internal-token and the environment token", () => {
  const previous = process.env.OPENBOOKS_INTERNAL_TOKEN;
  try {
    process.env.OPENBOOKS_INTERNAL_TOKEN = "worker-token";
    const ok = new Request("http://openbooks.test/api/internal/x", {
      headers: { "x-internal-token": "worker-token" },
    });
    const wrong = new Request("http://openbooks.test/api/internal/x", {
      headers: { "x-internal-token": "worker-tokex" },
    });
    const missing = new Request("http://openbooks.test/api/internal/x");
    assert.equal(requestHasInternalToken(ok), true);
    assert.equal(requestHasInternalToken(wrong), false);
    assert.equal(requestHasInternalToken(missing), false);
    delete process.env.OPENBOOKS_INTERNAL_TOKEN;
    assert.equal(requestHasInternalToken(ok), false, "no configured token: nothing matches");
  } finally {
    if (previous === undefined) delete process.env.OPENBOOKS_INTERNAL_TOKEN;
    else process.env.OPENBOOKS_INTERNAL_TOKEN = previous;
  }
});

test("parseInternalOrgId returns a canonical uuid or null", () => {
  assert.equal(
    parseInternalOrgId("0190B7E4-1C2D-7A3B-8F4E-0123456789AB"),
    "0190b7e4-1c2d-7a3b-8f4e-0123456789ab",
  );
  assert.equal(parseInternalOrgId(" 0190b7e4-1c2d-7a3b-8f4e-0123456789ab "), "0190b7e4-1c2d-7a3b-8f4e-0123456789ab");
  assert.equal(parseInternalOrgId("not-a-uuid"), null);
  assert.equal(parseInternalOrgId(""), null);
  assert.equal(parseInternalOrgId(undefined), null);
  assert.equal(parseInternalOrgId(null), null);
  assert.equal(parseInternalOrgId(42), null);
  assert.equal(parseInternalOrgId({ orgId: "0190b7e4-1c2d-7a3b-8f4e-0123456789ab" }), null);
  assert.equal(parseInternalOrgId("0190b7e4-1c2d-7a3b-8f4e-0123456789ab' or 1=1"), null);
});
