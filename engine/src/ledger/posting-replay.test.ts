import assert from "node:assert/strict";
import test from "node:test";
import { glProjectionScopeUnchanged } from "./posting.ts";

test("GL replay scope depends on period and posting date, not memo metadata", () => {
  const original = { periodId: "period-1", postingDate: "2026-07-01" };
  assert.equal(glProjectionScopeUnchanged(original, { ...original }), true);
  assert.equal(glProjectionScopeUnchanged(original, { ...original, postingDate: "2026-07-02" }), false);
  assert.equal(glProjectionScopeUnchanged(original, { ...original, periodId: "period-2" }), false);
});
