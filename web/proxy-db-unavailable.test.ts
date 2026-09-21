import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { sessionSigningInput } from "./lib/auth-token-format";
import { proxy } from "./proxy";

const previousSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = "fleet6-test-secret-value-0123456789abcdef";
test.after(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});

/** Mint a well-formed, correctly signed session cookie (an unknown session id). */
async function mintSessionCookie(): Promise<string> {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const payload = `v2.${sessionId}.${userId}.${expires}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(process.env.SESSION_SECRET!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionSigningInput(payload)));
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${payload}.${signature}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("every proxy denial carries the per-request id", async () => {
  const res = await proxy(new NextRequest("http://localhost:4780/api/nope-xyz"));
  assert.equal(res.status, 401);
  const requestId = res.headers.get("x-request-id");
  assert.match(requestId ?? "", UUID_RE);
  assert.deepEqual(await res.json(), { error: "unauthorized", requestId });
});

// The unit suite runs with OPENBOOKS_DB_URL empty, so the session-record
// lookup cannot reach a database: the proxy must fail that request closed
// (503 + request id + retry) instead of throwing a bare 500 with no id.
test("an unverifiable session fails closed per request, never as a bare proxy throw", async () => {
  const cookie = await mintSessionCookie();
  const api = await proxy(
    new NextRequest("http://localhost:4780/api/nope-xyz", { headers: { cookie: `ob_session=${cookie}` } }),
  );
  assert.equal(api.status, 503);
  const apiId = api.headers.get("x-request-id");
  assert.match(apiId ?? "", UUID_RE);
  assert.equal(api.headers.get("retry-after"), "5");
  assert.deepEqual(await api.json(), { error: "unavailable", requestId: apiId });

  const page = await proxy(
    new NextRequest("http://localhost:4780/inbox", { headers: { cookie: `ob_session=${cookie}` } }),
  );
  assert.equal(page.status, 503);
  const pageId = page.headers.get("x-request-id");
  assert.match(pageId ?? "", UUID_RE);
  const body = await page.text();
  assert.ok(body.includes(pageId!), "503 page must show its request id");
  assert.ok(/retry|try again/i.test(body), "503 page must offer a retry");
});
