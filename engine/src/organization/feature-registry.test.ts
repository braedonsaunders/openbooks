import assert from "node:assert/strict";
import test from "node:test";
import { FEATURE_BY_KEY, FEATURES, featureEnabled } from "./feature-registry.ts";

test("distribution features are opt-in and declare their dependencies", () => {
  const expected = [
    ["dropShipping", "inventory", undefined, ["orders", "inventory"]],
    ["returnAuthorizations", "inventory", ["returns"], ["fulfillment"]],
    ["customerPartNumbers", "sales", undefined, ["orders"]],
    ["barcodeScanning", "inventory", undefined, ["inventory"]],
  ] as const;
  for (const [key, category, navModules, requiresAll] of expected) {
    const def = FEATURE_BY_KEY.get(key);
    assert.ok(def, `${key} must be registered before distribution routes gate on it`);
    assert.equal(def.defaultEnabled, false);
    assert.equal(def.category, category);
    assert.deepEqual(def.navModules ?? [], navModules ?? []);
    assert.deepEqual(def.requiresAll, requiresAll);
    assert.equal(featureEnabled({}, key), false);
  }
});

for (const [key, title, category, enabled, navModules] of [
  ["nonprofit", "nonprofit is an opt-in industry feature owning one nav module", "industries", false, ["nonprofit"]],
  ["allocations", "allocations is an opt-in finance feature with no nav modules", "finance", false, []],
  ["homeAnnouncements", "home announcements is a default-on platform feature with no parent", "platform", true, []],
] as const) {
  test(title, () => {
    const def = FEATURE_BY_KEY.get(key);
    assert.ok(def, `${key} must be registered before its routes gate on it`);
    assert.equal(def.defaultEnabled, enabled);
    assert.equal(def.category, category);
    assert.deepEqual(def.navModules ?? [], navModules);
    assert.equal(def.parentKey, undefined);
    assert.equal(featureEnabled({}, key), enabled);
    assert.equal(featureEnabled({ [key]: !enabled }, key), !enabled);
  });
}

test("contract costs are opt-in billing subordinate to revenue recognition", () => {
  const def = FEATURE_BY_KEY.get("contractCosts");
  assert.ok(def, "contractCosts must be registered before contract cost routes gate on it");
  assert.equal(def.defaultEnabled, false);
  assert.equal(def.category, "billing");
  assert.deepEqual(def.navModules ?? [], []);
  assert.deepEqual(def.requiresAll, ["revenueRecognition"]);
  assert.equal(featureEnabled({}, "contractCosts"), false);
  // A stale stored override can never light the child while the parent is off
  // (the default-on parent resolves on when untouched, so the refusal needs
  // an explicit off).
  assert.equal(featureEnabled({ revenueRecognition: false, contractCosts: true }, "contractCosts"), false);
  assert.equal(
    featureEnabled({ revenueRecognition: true, contractCosts: true }, "contractCosts"),
    true,
  );
});

test("allocation binding-moment gates are subordinate to the parent", () => {
  for (const key of ["allocationsAtEntry", "allocationsAtPosting"]) {
    const def = FEATURE_BY_KEY.get(key);
    assert.ok(def, `${key} must be registered before sibling shards gate on it`);
    assert.equal(def.category, "finance");
    assert.equal(def.parentKey, "allocations");
    // A stale stored override can never resurrect a child while the parent is off.
    assert.equal(featureEnabled({ allocations: false, [key]: true }, key), false);
    assert.equal(featureEnabled({}, key), false);
    // Enabling the parent lights both moments; either moment can still be switched off.
    assert.equal(featureEnabled({ allocations: true }, key), true);
    assert.equal(featureEnabled({ allocations: true, [key]: false }, key), false);
  }
});


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
  }
  for (const key of ["automationDateTriggers", "automationFieldTriggers", "automationSimulator"]) {
    assert.equal(featureEnabled({ flows: true, automations: true, [key]: true }, key), true);
  }
  // The webhook action needs the delivery transport: automationWebhooks
  // additionally requires outboundWebhooks (which itself needs apiAccess).
  const webhooksOn = {
    flows: true,
    automations: true,
    automationWebhooks: true,
    outboundWebhooks: true,
    apiAccess: true,
  };
  assert.equal(featureEnabled(webhooksOn, "automationWebhooks"), true);
  assert.equal(
    featureEnabled({ ...webhooksOn, outboundWebhooks: false }, "automationWebhooks"),
    false,
    "the webhook action stays off while the delivery transport is off",
  );
  assert.equal(
    featureEnabled({ ...webhooksOn, apiAccess: false }, "automationWebhooks"),
    false,
    "the transport chain resolves through apiAccess",
  );
  // Exception-only approval is a per-flow setting, never a feature key.
  assert.equal(FEATURE_BY_KEY.has("automationExceptionApproval"), false);
});

test("optional HRM operations preserve independent capabilities and explicit closing dependencies", () => {
  const optional = ["hrmTraining", "hrmShiftPlanning", "hrmAttendance", "hrmShiftClosing"];
  for (const key of optional) {
    assert.equal(FEATURE_BY_KEY.get(key)?.defaultEnabled, false, `${key} must be opt-in`);
    assert.equal(featureEnabled({}, key), false);
    assert.equal(featureEnabled({ hrm: false, [key]: true, hrmShiftPlanning: true, hrmAttendance: true }, key), false);
  }
  const independent = { hrm: true, hrmCertifications: false, hrmTraining: true, hrmShiftPlanning: false, hrmAttendance: true };
  assert.equal(featureEnabled(independent, "hrmTraining"), true);
  assert.equal(featureEnabled(independent, "hrmAttendance"), true);
  assert.equal(featureEnabled({ hrm: true, hrmCertifications: true }, "hrmTraining"), false);
  assert.equal(featureEnabled({ hrm: true, hrmTraining: false, hrmCertifications: true }, "hrmCertifications"), true);
  assert.equal(featureEnabled({ hrm: true, hrmShiftPlanning: true, hrmAttendance: false }, "hrmShiftPlanning"), true);
  assert.equal(featureEnabled({ payroll: true, hrm: false }, "payroll"), true);
  assert.equal(featureEnabled({ projects: true, timeTracking: true, fieldTime: true, hrm: false }, "fieldTime"), true);
  assert.equal(featureEnabled({}, "compensationPackages"), false);
  assert.equal(featureEnabled({ payroll: true, hrm: false, compensationPackages: true }, "compensationPackages"), true);
  assert.equal(featureEnabled({ payroll: false, compensationPackages: true }, "compensationPackages"), false);
  const closing = { hrm: true, hrmShiftPlanning: true, hrmAttendance: true, hrmShiftClosing: true };
  assert.equal(featureEnabled(closing, "hrmShiftClosing"), true);
  for (const dependency of ["hrmShiftPlanning", "hrmAttendance"]) assert.equal(featureEnabled({ ...closing, [dependency]: false }, "hrmShiftClosing"), false);
  const singleSwitches = new Set(["fieldTime", ...FEATURES.filter(feature => feature.parentKey === "hrm").map(feature => feature.key)]);
  assert.ok(singleSwitches.has("hrmPerformance") && singleSwitches.has("hrmRecruiting"));
  assert.deepEqual(FEATURES.filter(feature => feature.parentKey && singleSwitches.has(feature.parentKey)).map(feature => feature.key), ["hrmShiftClosing"]);
});
