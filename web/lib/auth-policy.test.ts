import assert from "node:assert/strict";
import test from "node:test";
import {
  authRequestContext,
  hasExpectedOrigin,
  nextLockoutState,
  normalizeLoginEmail,
  publicLoginFailure,
  safeReturnTo,
  slidingWindowRetryAfter,
  useSecureCookies,
} from "./auth-policy";

test("session cookies are always secure in production", () => {
  assert.equal(useSecureCookies({ NODE_ENV: "production", OPENBOOKS_COOKIE_SECURE: "0" }), true);
  assert.equal(useSecureCookies({ NODE_ENV: "development" }), false);
  assert.equal(useSecureCookies({ NODE_ENV: "development", OPENBOOKS_COOKIE_SECURE: "true" }), true);
});

test("sliding-window retry time is based on the oldest real attempt", () => {
  const now = new Date("2026-08-04T12:15:00Z");
  assert.equal(
    slidingWindowRetryAfter(new Date("2026-08-04T12:05:00Z"), 15 * 60, now),
    5 * 60,
  );
});

test("forwarded client addresses require explicit trusted-proxy configuration", () => {
  const request = new Request("https://example.test", {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2", "user-agent": "test-agent" },
  });
  assert.equal(authRequestContext(request, {}).networkAddress, null);
  assert.equal(
    authRequestContext(request, { OPENBOOKS_TRUST_PROXY: "1" }).networkAddress,
    "203.0.113.7",
  );
});

test("lockout escalates and resets after a quiet hour", () => {
  const start = new Date("2026-08-04T12:00:00Z");
  let state = nextLockoutState(null, start);
  for (let i = 1; i < 5; i += 1) state = nextLockoutState(state, new Date(start.getTime() + i * 1000));
  assert.equal(state.failureCount, 5);
  assert.equal(state.lockedUntil?.toISOString(), "2026-08-04T12:05:04.000Z");

  const reset = nextLockoutState(state, new Date(start.getTime() + 2 * 60 * 60 * 1000));
  assert.equal(reset.failureCount, 1);
  assert.equal(reset.lockedUntil, null);
});

test("login identifiers and return paths are normalized safely", () => {
  assert.equal(normalizeLoginEmail("  USER@Example.COM "), "user@example.com");
  assert.equal(normalizeLoginEmail("not-an-email"), null);
  assert.equal(safeReturnTo("/reports/pnl?period=1"), "/reports/pnl?period=1");
  assert.equal(safeReturnTo("//evil.example"), "/");
  assert.equal(safeReturnTo("https://evil.example"), "/");
});

test("browser mutations reject a cross-origin Origin header", () => {
  const sameOrigin = new Request("https://books.example.test/api/auth/mfa", {
    method: "POST",
    headers: { Origin: "https://books.example.test" },
  });
  const crossOrigin = new Request("https://books.example.test/api/auth/mfa", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(hasExpectedOrigin(sameOrigin), true);
  assert.equal(hasExpectedOrigin(crossOrigin), false);
  assert.equal(hasExpectedOrigin(sameOrigin, { OPENBOOKS_APP_URL: "https://different.example" }), false);
});

test("invalid-login responses do not reveal whether an account is locked", () => {
  assert.deepEqual(
    publicLoginFailure({ kind: "invalid", retryAfter: 0 }),
    publicLoginFailure({ kind: "invalid", retryAfter: 60 * 60 }),
  );
  assert.deepEqual(publicLoginFailure({ kind: "invalid", retryAfter: 300 }), {
    status: 401,
    body: { error: "invalid credentials" },
    retryAfterHeader: null,
  });
  assert.equal(publicLoginFailure({ kind: "rate_limited", retryAfter: 30 }).status, 429);
});
