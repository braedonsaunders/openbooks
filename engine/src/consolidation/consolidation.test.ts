import assert from "node:assert/strict";
import test from "node:test";
import { isSerializationConflict } from "./consolidation.ts";

/** A driver-style error carrying a pg code, wrapped `wrappers` deep in causes. */
function chained(code: string | null, wrappers: number): unknown {
  let current: unknown = code === null
    ? new Error("boom")
    : Object.assign(new Error("boom"), { code });
  for (let i = 0; i < wrappers; i++) {
    current = Object.assign(new Error("wrapped"), { cause: current });
  }
  return current;
}

test("a top-level 40001 is a serialization conflict", () => {
  assert.equal(isSerializationConflict(chained("40001", 0)), true);
});

test("a 40001 nested five causes deep is still found", () => {
  assert.equal(isSerializationConflict(chained("40001", 5)), true);
});

test("a 40001 nested six causes deep is out of range", () => {
  // Pins the walk bound: pg nests only a few levels, so a code buried
  // deeper than the walk is not treated as a serialization conflict.
  assert.equal(isSerializationConflict(chained("40001", 6)), false);
});

test("other codes and code-free chains are not conflicts", () => {
  assert.equal(isSerializationConflict(chained("23505", 0)), false);
  assert.equal(isSerializationConflict(chained(null, 3)), false);
  assert.equal(isSerializationConflict(null), false);
  assert.equal(isSerializationConflict("40001"), false);
});
