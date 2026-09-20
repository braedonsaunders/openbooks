import assert from "node:assert/strict";
import test from "node:test";
import { FEATURE_BY_KEY, featureEnabled } from "./feature-registry.ts";

test("allocations is an opt-in accounting feature with no nav modules", () => {
  const def = FEATURE_BY_KEY.get("allocations");
  assert.ok(def, "allocations must be registered before sibling shards gate on it");
  assert.equal(def.defaultEnabled, false);
  assert.equal(def.category, "accounting");
  assert.deepEqual(def.navModules ?? [], []);
  assert.equal(featureEnabled({}, "allocations"), false);
  assert.equal(featureEnabled({ allocations: true }, "allocations"), true);
});

test("allocation binding-moment gates are subordinate to the parent", () => {
  for (const key of ["allocationsAtEntry", "allocationsAtPosting"]) {
    const def = FEATURE_BY_KEY.get(key);
    assert.ok(def, `${key} must be registered before sibling shards gate on it`);
    assert.equal(def.category, "accounting");
    assert.equal(def.parentKey, "allocations");
    // A stale stored override can never resurrect a child while the parent is off.
    assert.equal(featureEnabled({ allocations: false, [key]: true }, key), false);
    assert.equal(featureEnabled({}, key), false);
    // Enabling the parent lights both moments; either moment can still be switched off.
    assert.equal(featureEnabled({ allocations: true }, key), true);
    assert.equal(featureEnabled({ allocations: true, [key]: false }, key), false);
  }
});

// HR-15 begin: optional persona-home complexity gates.
test("hrm celebrations and manager nudges are subordinate to hrm", () => {
  for (const key of ["hrmCelebrations", "hrmManagerNudges"]) {
    const def = FEATURE_BY_KEY.get(key);
    assert.ok(def, `${key} must be registered`);
    assert.equal(def.category, "operations");
    assert.equal(def.parentKey, "hrm");
    assert.equal(featureEnabled({ hrm: false, [key]: true }, key), false);
    assert.equal(featureEnabled({}, key), false);
    // Opt-in sub-features: the parent alone does not light them.
    assert.equal(featureEnabled({ hrm: true }, key), false);
    assert.equal(featureEnabled({ hrm: true, [key]: true }, key), true);
    assert.equal(featureEnabled({ hrm: true, [key]: false }, key), false);
  }
});

test("home announcements is a default-on platform feature with no parent", () => {
  const def = FEATURE_BY_KEY.get("homeAnnouncements");
  assert.ok(def, "homeAnnouncements must be registered");
  assert.equal(def.defaultEnabled, true);
  assert.equal(def.category, "platform");
  assert.equal(def.parentKey, undefined);
  assert.equal(featureEnabled({}, "homeAnnouncements"), true);
  assert.equal(featureEnabled({ homeAnnouncements: false }, "homeAnnouncements"), false);
});
// HR-15 end
