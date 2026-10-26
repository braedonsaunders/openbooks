import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const previousSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = "test-secret-value-0123456789abcdef";
test.after(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});

test("a sessionless page request redirects to login with its path and query carried in next", async () => {
  const res = await proxy(
    new NextRequest("http://localhost:4780/reports/pnl?from=2026-01-01&to=2026-03-31"),
  );
  assert.equal(res.status, 307);
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(location.pathname, "/login");
  assert.deepEqual(
    [...location.searchParams.keys()],
    ["next"],
    "the destination's query keys do not leak onto /login",
  );
  assert.equal(location.searchParams.get("next"), "/reports/pnl?from=2026-01-01&to=2026-03-31");
});

test("a sessionless drawer deep link keeps its drawer state through login", async () => {
  const res = await proxy(new NextRequest("http://localhost:4780/banking?drawer=4f1c2d3e"));
  assert.equal(res.status, 307);
  const location = new URL(res.headers.get("location") ?? "");
  assert.deepEqual([...location.searchParams.keys()], ["next"]);
  assert.equal(location.searchParams.get("next"), "/banking?drawer=4f1c2d3e");
});

test("a sessionless page request without a query redirects with the bare path", async () => {
  const res = await proxy(new NextRequest("http://localhost:4780/journal"));
  assert.equal(res.status, 307);
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("next"), "/journal");
  assert.deepEqual([...location.searchParams.keys()], ["next"]);
});
