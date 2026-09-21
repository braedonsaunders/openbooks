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

// HR-12 begin: compensation is an opt-in HRM feature with three
// subordinate switches; merit cycles additionally require payroll.
test("hrmCompensation is an opt-in hrm feature with subordinate switches", () => {
  const def = FEATURE_BY_KEY.get("hrmCompensation");
  assert.ok(def, "hrmCompensation must be registered before routes gate on it");
  assert.equal(def.defaultEnabled, false);
  assert.equal(def.parentKey, "hrm");
  assert.equal(featureEnabled({}, "hrmCompensation"), false);
  assert.equal(featureEnabled({ hrm: false, hrmCompensation: true }, "hrmCompensation"), false);
  assert.equal(featureEnabled({ hrm: true }, "hrmCompensation"), false);
  assert.equal(featureEnabled({ hrm: true, hrmCompensation: true }, "hrmCompensation"), true);
  for (const key of ["hrmMeritCycles", "hrmHeadcountPlans", "hrmPayTransparency"]) {
    const sub = FEATURE_BY_KEY.get(key);
    assert.ok(sub, `${key} must be registered before routes gate on it`);
    assert.equal(sub.parentKey, "hrmCompensation");
    assert.equal(featureEnabled({ hrm: true, hrmCompensation: false, [key]: true }, key), false);
  }
  const merit = FEATURE_BY_KEY.get("hrmMeritCycles");
  assert.deepEqual(merit?.requiresAll, ["payroll"]);
  assert.equal(featureEnabled({ hrm: true, hrmCompensation: true, hrmMeritCycles: true }, "hrmMeritCycles"), false);
  assert.equal(
    featureEnabled({ hrm: true, hrmCompensation: true, payroll: true, hrmMeritCycles: true }, "hrmMeritCycles"),
    true,
  );
});
// HR-12 end

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
test("automations is an opt-in platform feature under flows with four sub-features", () => {
  const def = FEATURE_BY_KEY.get("automations");
  assert.ok(def, "automations must be registered before the builder gates on it");
  assert.equal(def.defaultEnabled, false);
  assert.equal(def.parentKey, "flows");
  assert.deepEqual(def.navModules, ["automations"]);
  for (const key of [
    "automationDateTriggers",
    "automationFieldTriggers",
    "automationWebhooks",
    "automationSimulator",
  ]) {
    const sub = FEATURE_BY_KEY.get(key);
    assert.ok(sub, `${key} must be registered`);
    assert.equal(sub.parentKey, "automations");
    // A stale stored override can never resurrect a child while the parent is off.
    assert.equal(featureEnabled({ automations: false, [key]: true }, key), false);
    assert.equal(featureEnabled({ flows: true, automations: true, [key]: true }, key), true);
  // Exception-only approval is a per-flow setting, never a feature key.
  assert.equal(FEATURE_BY_KEY.has("automationExceptionApproval"), false);

test("hrmActionReasons defaults on, hrmEventVerbs defaults off, both under hrm", () => {
  const reasons = FEATURE_BY_KEY.get("hrmActionReasons");
  assert.ok(reasons, "hrmActionReasons must be registered");
  assert.equal(reasons.defaultEnabled, true);
  assert.equal(reasons.parentKey, "hrm");
  const verbs = FEATURE_BY_KEY.get("hrmEventVerbs");
  assert.ok(verbs, "hrmEventVerbs must be registered");
  assert.equal(verbs.defaultEnabled, false);
  assert.equal(verbs.parentKey, "hrm");
  assert.equal(featureEnabled({ hrm: false, hrmActionReasons: true }, "hrmActionReasons"), false);
