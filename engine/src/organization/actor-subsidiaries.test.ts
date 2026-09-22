import assert from "node:assert/strict";
import test from "node:test";
import { subsidiaryScopeWithinCeiling } from "./actor-subsidiaries.ts";

// Pure delegation-ceiling comparison over already-resolved subsidiary sets.
// Explicit null is unrestricted; a finite list is never equivalent to all;
// empty grants nothing; unknown fails closed.
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

test("unrestricted grant fits only an unrestricted ceiling", () => {
  assert.equal(subsidiaryScopeWithinCeiling(null, null), true);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A, B]), null), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set(), null), false);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, null), false);
});

test("finite list covering every current entity is not all", () => {
  // Even when the granted list enumerates the ceiling's full contents, an
  // all-grant (null) against a finite ceiling refuses: future entities fall
  // inside `all` but outside the list.
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A, B]), null), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), new Set([A, B])), false);
});

test("unrestricted ceiling grants any known scope", () => {
  assert.equal(subsidiaryScopeWithinCeiling(null, new Set([A])), true);
  assert.equal(subsidiaryScopeWithinCeiling(null, new Set()), true);
  assert.equal(subsidiaryScopeWithinCeiling(null, undefined), false);
});

test("finite grant must sit inside a finite ceiling; empty grants nothing", () => {
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A, B]), new Set([A])), true);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), new Set([A, B])), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), new Set()), true);
  assert.equal(subsidiaryScopeWithinCeiling(new Set(), new Set()), true);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, new Set([A])), false);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, new Set()), false);
});

test("unknown granted scope never fits", () => {
  assert.equal(subsidiaryScopeWithinCeiling(null, undefined), false);
  assert.equal(subsidiaryScopeWithinCeiling(new Set([A]), undefined), false);
  assert.equal(subsidiaryScopeWithinCeiling(undefined, undefined), false);
});
