import assert from "node:assert/strict";
import test from "node:test";
import { isUuid } from "./uuid.ts";

test("only the 8-4-4-4-12 hex shape counts as a UUID", () => {
  assert.equal(isUuid("00000000-0000-4000-8000-000000000001"), true);
  assert.equal(isUuid("A8098C1A-F86E-11DA-BD1A-00112444BE52"), true);
  // 36 characters of hex and dashes with no 8-4-4-4-12 grouping: the old
  // /^[0-9a-f-]{36}$/ shape accepted every one of these as a UUID.
  assert.equal(isUuid("-".repeat(36)), false);
  assert.equal(isUuid("0".repeat(36)), false);
  assert.equal(isUuid("000000000000400080000000000000010000"), false);
  // Never UUIDs under either shape: non-hex content, wrong length, empty,
  // and non-strings.
  assert.equal(isUuid("not-a-uuid-at-all----------------"), false);
  assert.equal(isUuid("00000000-0000-4000-8000-00000000001"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(42), false);
  assert.equal(isUuid({}), false);
});
