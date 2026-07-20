import test from "node:test";
import assert from "node:assert/strict";
import { effectiveNavMode } from "./nav-mode";

test("effectiveNavMode prioritizes the user's valid preference", () => {
  assert.equal(effectiveNavMode("topbar", "sidebar"), "topbar");
  assert.equal(effectiveNavMode("sidebar", "topbar"), "sidebar");
});

test("effectiveNavMode falls back through the tenant default to topbar", () => {
  assert.equal(effectiveNavMode(null, "topbar"), "topbar");
  assert.equal(effectiveNavMode("unsupported", "topbar"), "topbar");
  assert.equal(effectiveNavMode(null, null), "topbar");
  assert.equal(effectiveNavMode(undefined, "unsupported"), "topbar");
});
