import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENTRY_PREFERENCES,
  ENTRY_PREFERENCES_PATCH_SCHEMA,
  resolveEntryPreferences,
} from "./entry-preferences";

test("stored preferences merge over the defaults key by key", () => {
  assert.deepEqual(resolveEntryPreferences({}), DEFAULT_ENTRY_PREFERENCES);
  assert.deepEqual(resolveEntryPreferences(null), DEFAULT_ENTRY_PREFERENCES);
  assert.deepEqual(resolveEntryPreferences({ autoDecimal: true }), {
    ...DEFAULT_ENTRY_PREFERENCES,
    autoDecimal: true,
  });
});

test("a malformed or unknown stored key never invalidates the others", () => {
  assert.deepEqual(
    resolveEntryPreferences({
      autoDecimal: "yes",
      recallLastDocument: "always",
      keepPartyOnNew: true,
      retired: 1,
    }),
    { ...DEFAULT_ENTRY_PREFERENCES, keepPartyOnNew: true },
  );
});

test("updates accept only known preferences with their own types", () => {
  assert.equal(
    ENTRY_PREFERENCES_PATCH_SCHEMA.safeParse({ enterMovesToNextField: true }).success,
    true,
  );
  assert.equal(
    ENTRY_PREFERENCES_PATCH_SCHEMA.safeParse({ recallLastDocument: "apply" }).success,
    true,
  );
  assert.equal(
    ENTRY_PREFERENCES_PATCH_SCHEMA.safeParse({ recallLastDocument: "always" }).success,
    false,
  );
  assert.equal(ENTRY_PREFERENCES_PATCH_SCHEMA.safeParse({ somethingElse: true }).success, false);
});
