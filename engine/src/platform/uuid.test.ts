import assert from "node:assert/strict";
import test from "node:test";
import { UUID_MESSAGE, isUuid, uuidString } from "./uuid.ts";

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

// Sandbox and sample organizations derive ids as md5(seed || ':' || source)
// cast to uuid, so the version (index 14) and variant (index 19) nibbles are
// arbitrary hex. These are real stored ids and must validate everywhere.
const DERIVED_IDS = [
  "435d3903-de4c-da3a-0183-ee5f8be57bfd",
  "9f1c2e7a-55b0-0c3d-f2a4-6b8e01d3c9aa",
  "00a1b2c3-d4e5-f6a7-7890-abcdefabcdef",
];

test("sandbox-derived ids outside RFC 9562 version/variant are UUIDs", () => {
  for (const id of DERIVED_IDS) {
    const rfcVersioned = "12345678".includes(id[14]!) && "89abAB".includes(id[19]!);
    assert.equal(rfcVersioned, false, `${id} must exercise a non-RFC version or variant`);
    assert.equal(isUuid(id), true);
    assert.deepEqual(uuidString().safeParse(id), { success: true, data: id });
    assert.equal(uuidString().safeParse(id.toUpperCase()).success, true);
  }
});

test("uuidString refuses non-ids with the default or the caller's message", () => {
  for (const value of [
    "",
    "not-an-id",
    "-".repeat(36),
    "435d3903de4cda3a0183ee5f8be57bfd",
    `${DERIVED_IDS[0]} `,
    `${DERIVED_IDS[0]}0`,
  ]) {
    const parsed = uuidString().safeParse(value);
    assert.equal(parsed.success, false, value);
    assert.equal(parsed.error?.issues[0]?.message, UUID_MESSAGE);
  }
  const custom = uuidString("periodId must be a valid id");
  assert.equal(custom.safeParse("x").error?.issues[0]?.message, "periodId must be a valid id");
  assert.equal(
    custom.safeParse(undefined).error?.issues[0]?.message,
    "periodId must be a valid id",
  );
  assert.equal(
    uuidString({ error: "pick a saved record" }).safeParse(42).error?.issues[0]?.message,
    "pick a saved record",
  );
  assert.equal(uuidString().nullable().optional().safeParse(null).success, true);
  assert.equal(uuidString().safeParse(undefined).success, false);
});
