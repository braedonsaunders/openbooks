import assert from "node:assert/strict";
import test from "node:test";
import { isUniqueViolation } from "./errors.ts";

test("uniqueness refusal sees the native code through wrapped database errors", () => {
  assert.equal(isUniqueViolation({ cause: { cause: { code: "23505" } } }), true);
  assert.equal(isUniqueViolation({ cause: { code: "23503" } }), false);
  assert.equal(isUniqueViolation(new Error("23505 appears in prose")), false);
  assert.equal(isUniqueViolation(null), false);
});

test("malformed cause cycles cannot hang a refusal", () => {
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(isUniqueViolation(cycle), false);
});
