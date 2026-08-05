import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Next.js applies the static security-header baseline to every route", async () => {
  const { default: config, securityHeaders } =
    await import("../next.config.mjs");

  const headers = config.headers;
  assert.equal(typeof headers, "function");
  assert.ok(headers);
  const routes = await headers();
  assert.deepEqual(routes, [{ source: "/(.*)", headers: securityHeaders }]);

  const values = new Map(securityHeaders.map(({ key, value }) => [key, value]));
  assert.equal(values.get("X-Content-Type-Options"), "nosniff");
  assert.equal(values.get("X-Frame-Options"), "DENY");
  assert.match(
    values.get("Strict-Transport-Security") ?? "",
    /max-age=63072000/,
  );
  assert.equal(values.has("Content-Security-Policy"), false);
});

test("production CSP uses a request nonce without insecure script fallbacks", async () => {
  const { buildContentSecurityPolicy } = await import("./content-security-policy.ts");
  const policy = buildContentSecurityPolicy("test-nonce-123456", false);

  assert.match(policy, /script-src 'self' 'nonce-test-nonce-123456' 'strict-dynamic'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});

test("development CSP permits the evaluator required by Next.js", async () => {
  const { buildContentSecurityPolicy } = await import("./content-security-policy.ts");
  const policy = buildContentSecurityPolicy("test-nonce-123456", true);
  assert.match(policy, /script-src[^;]*'unsafe-eval'/);
});

test("the request proxy sends the CSP and nonce to Next.js", () => {
  const source = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(source, /createContentSecurityPolicyNonce\(\)/);
  assert.match(source, /requestHeaders\.set\("x-nonce", nonce\)/);
  assert.match(
    source,
    /requestHeaders\.set\("Content-Security-Policy", contentSecurityPolicy\)/,
  );
  assert.match(source, /response\.headers\.set\("Content-Security-Policy"/);
});

test("the root layout passes the request nonce to its custom script", () => {
  const source = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(source, /headers\(\)/);
  assert.match(source, /requestHeaders\.get\('x-nonce'\)/);
  assert.match(source, /<Script[\s\S]*nonce=\{nonce\}/);
});
