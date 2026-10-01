import assert from "node:assert/strict";
import test from "node:test";
import { benefitListWindow } from "./list-window.ts";

test("omitted limits retain complete lists and explicit windows retain their position", () => {
  assert.deepEqual(benefitListWindow(), { limit: null, offset: 0 });
  assert.deepEqual(benefitListWindow(500, 1000), { limit: 500, offset: 1000 });
  assert.deepEqual(benefitListWindow(undefined, 1), { limit: null, offset: 1 });
});

test("malformed page sizes and offsets refuse by name instead of reaching SQL", () => {
  for (const limit of [NaN, Infinity, 0, -1, 0.5, 2001]) assert.throws(() => benefitListWindow(limit), /limit.*1 to 2000/);
  for (const offset of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => benefitListWindow(1, offset), /offset.*non-negative whole number/);
});
