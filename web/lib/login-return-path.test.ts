import assert from "node:assert/strict";
import test from "node:test";
import { loginReturnPath, safeNextPath } from "./login-return-path";

test("safeNextPath preserves same-origin relative destinations with their query and fragment", () => {
  assert.equal(
    safeNextPath("/reports?view=profit-and-loss#totals"),
    "/reports?view=profit-and-loss#totals",
  );
  assert.equal(
    safeNextPath("/reports/pnl?from=2026-01-01&to=2026-03-31"),
    "/reports/pnl?from=2026-01-01&to=2026-03-31",
  );
  assert.equal(safeNextPath("/banking?drawer=4f1c2d3e"), "/banking?drawer=4f1c2d3e");
  assert.equal(safeNextPath("/"), "/");
});

test("safeNextPath fails closed for unsafe, malformed, empty, and oversized values", () => {
  for (const value of [
    "https://evil.com",
    "//evil.com",
    "//evil.com/reports?from=2026-01-01",
    "/\\evil.com",
    "/\\evil.com?from=2026-01-01",
    "/\\/evil.com",
    "/\\[malformed",
    "not a URL",
    "",
    null,
    "x".repeat(2049),
  ]) {
    assert.equal(safeNextPath(value), "/", `expected fallback for ${JSON.stringify(value)}`);
  }
});

test("loginReturnPath carries the path and its query string into next", () => {
  assert.equal(
    loginReturnPath("/reports/pnl", "?from=2026-01-01&to=2026-03-31"),
    "/reports/pnl?from=2026-01-01&to=2026-03-31",
  );
  assert.equal(loginReturnPath("/banking", "?drawer=4f1c2d3e"), "/banking?drawer=4f1c2d3e");
  assert.equal(loginReturnPath("/reports/pnl", ""), "/reports/pnl");
  assert.equal(loginReturnPath("/", ""), "/");
});

test("loginReturnPath keeps the bare path when the query is refused for size", () => {
  assert.equal(loginReturnPath("/reports/pnl", `?q=${"x".repeat(2100)}`), "/reports/pnl");
});

test("loginReturnPath never yields a cross-origin destination", () => {
  for (const pathname of ["//evil.com", "/\\evil.com"]) {
    const next = loginReturnPath(pathname, "?from=2026-01-01");
    assert.equal(next, "/", `refused path ${JSON.stringify(pathname)} falls back to /`);
  }
});
