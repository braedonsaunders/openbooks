import test from "node:test";
import assert from "node:assert/strict";
import { MODULE_BY_KEY, resolveStoredHref } from "./nav-registry.ts";

// F-t11-012 follow-up: findings persisted before the pack fix carry the
// hand-built "/ar/cockpit" href, which 404s. Stored hrefs resolve through
// the registry at render time so old findings heal without a backfill.
test("stored legacy AR cockpit href resolves to the registry ar href", () => {
  assert.equal(resolveStoredHref("/ar/cockpit"), "/ar");
  assert.equal(resolveStoredHref("/ar/cockpit"), MODULE_BY_KEY.get("ar")?.href);
});

test("live registry hrefs pass through untouched", () => {
  assert.equal(resolveStoredHref("/ar"), "/ar");
  assert.equal(resolveStoredHref("/budgets?budget=1"), "/budgets?budget=1");
  assert.equal(resolveStoredHref("/banking/abc/reconcile/def"), "/banking/abc/reconcile/def");
});

test("non-href stored values resolve to null", () => {
  assert.equal(resolveStoredHref(null), null);
  assert.equal(resolveStoredHref(undefined), null);
  assert.equal(resolveStoredHref(42), null);
  assert.equal(resolveStoredHref("ar"), null);
});
