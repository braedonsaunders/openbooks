import assert from "node:assert/strict";
import test from "node:test";

test("Next.js applies the production security-header baseline to every route", async () => {
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
  assert.match(
    values.get("Content-Security-Policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.match(
    values.get("Content-Security-Policy") ?? "",
    /object-src 'none'/,
  );
  assert.doesNotMatch(
    values.get("Content-Security-Policy") ?? "",
    /unsafe-eval/,
  );
});
