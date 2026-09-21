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
  }
  // Exception-only approval is a per-flow setting, never a feature key.
  assert.equal(FEATURE_BY_KEY.has("automationExceptionApproval"), false);
});

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
});
// HR-14 begin: certifications ride hrm; dispatch gating needs projects +
// projectScheduling, equipment qualifications need equipment, alerts ride
// the parent alone. Off hides the surface, never the data.
test("hrmCertifications is an opt-in hrm feature with gated sub-features", () => {
  const def = FEATURE_BY_KEY.get("hrmCertifications");
  assert.ok(def, "hrmCertifications must be registered before routes gate on it");
  assert.equal(def.defaultEnabled, false);
  assert.equal(def.parentKey, "hrm");
  assert.equal(featureEnabled({}, "hrmCertifications"), false);
  assert.equal(featureEnabled({ hrm: false, hrmCertifications: true }, "hrmCertifications"), false);
  assert.equal(featureEnabled({ hrm: true }, "hrmCertifications"), false);
  assert.equal(featureEnabled({ hrm: true, hrmCertifications: true }, "hrmCertifications"), true);
  const dispatch = FEATURE_BY_KEY.get("hrmDispatchGating");
  assert.ok(dispatch, "hrmDispatchGating must be registered");
  assert.equal(dispatch.parentKey, "hrmCertifications");
  assert.deepEqual([...(dispatch.requiresAll ?? [])].sort(), ["projectScheduling", "projects"]);
  // A stale stored override can never resurrect dispatch while scheduling is off.
  assert.equal(
    featureEnabled({ hrm: true, hrmCertifications: true, projects: true, hrmDispatchGating: true }, "hrmDispatchGating"),
    false,
  );
  assert.equal(
    featureEnabled(
      { hrm: true, hrmCertifications: true, projects: true, projectScheduling: true, hrmDispatchGating: true },
      "hrmDispatchGating",
    ),
    true,
  );
  const equipment = FEATURE_BY_KEY.get("hrmEquipmentQualifications");
  assert.ok(equipment, "hrmEquipmentQualifications must be registered");
  assert.equal(equipment.parentKey, "hrmCertifications");
  assert.deepEqual([...(equipment.requiresAll ?? [])], ["equipment"]);
  // equipment defaults on, so absence resolves true; an explicit off still kills the child.
  assert.equal(
    featureEnabled({ hrm: true, hrmCertifications: true, hrmEquipmentQualifications: true }, "hrmEquipmentQualifications"),
    true,
  );
  assert.equal(
    featureEnabled({ hrm: true, hrmCertifications: true, equipment: false, hrmEquipmentQualifications: true }, "hrmEquipmentQualifications"),
    false,
  );
  const alerts = FEATURE_BY_KEY.get("hrmCertificationAlerts");
  assert.ok(alerts, "hrmCertificationAlerts must be registered");
  assert.equal(alerts.parentKey, "hrmCertifications");
  assert.equal(
    featureEnabled({ hrm: true, hrmCertifications: true, hrmCertificationAlerts: true }, "hrmCertificationAlerts"),
    true,
  );
});
// HR-14 end
// HR-19 begin: documents ride hrm with retention and export sub-features;
// surveys ride hrm with pulse as the sub-feature; the org chart is
// default-on under hrm. A stale override never resurrects a child while
// its parent is off, and toggling never deletes (no data assertions here
// — the services own those).
test("hrm documents, surveys, and org chart gate under hrm", () => {
  for (const key of ["hrmDocuments", "hrmSurveys", "hrmOrgChart"]) {
    const def = FEATURE_BY_KEY.get(key);
    assert.ok(def, `${key} must be registered`);
    assert.equal(def.parentKey, "hrm");
    assert.equal(featureEnabled({ hrm: false, [key]: true }, key), false);
  }
  const docs = FEATURE_BY_KEY.get("hrmDocuments");
  assert.ok(docs, "hrmDocuments must be registered");
  assert.equal(docs.defaultEnabled, false);
  for (const key of ["hrmDocumentRetention", "hrmDataSubjectExport"]) {
    const sub = FEATURE_BY_KEY.get(key);
    assert.ok(sub, `${key} must be registered`);
    assert.equal(sub.parentKey, "hrmDocuments");
    assert.equal(featureEnabled({ hrm: true, hrmDocuments: false, [key]: true }, key), false);
    assert.equal(featureEnabled({ hrm: true, hrmDocuments: true, [key]: true }, key), true);
  }
  const pulse = FEATURE_BY_KEY.get("hrmPulseSurveys");
  assert.ok(pulse, "hrmPulseSurveys must be registered");
  assert.equal(pulse.parentKey, "hrmSurveys");
  assert.equal(pulse.defaultEnabled, false);
  const chart = FEATURE_BY_KEY.get("hrmOrgChart");
  assert.ok(chart, "hrmOrgChart must be registered");
  assert.equal(chart.defaultEnabled, true);
  assert.equal(featureEnabled({ hrm: true }, "hrmOrgChart"), true);
  assert.equal(featureEnabled({ hrm: false, hrmOrgChart: true }, "hrmOrgChart"), false);
});
// HR-19 end

// HR-20 begin: field time capture rides timeTracking (office orgs never
// see a clock) and needs projects; sub-features hide optional
// complexity. Off stops rendering and writing, never data.
test("fieldTime rides timeTracking with six sub-features", () => {
  const def = FEATURE_BY_KEY.get("fieldTime");
  assert.ok(def, "fieldTime must be registered");
  assert.equal(def.defaultEnabled, false);
  assert.equal(def.parentKey, "timeTracking");
  assert.deepEqual(def.requiresAll, ["projects"]);
  for (const key of [
    "fieldTimeGeofence",
    "fieldTimePhoto",
    "fieldTimeKiosk",
    "fieldTimeCrewEntry",
    "fieldTimeEquipment",
    "fieldTimeMultiStageApproval",
  ]) {
    const sub = FEATURE_BY_KEY.get(key);
    assert.ok(sub, `${key} must be registered`);
    assert.equal(sub.parentKey, "fieldTime");
    assert.equal(sub.defaultEnabled, false);
    // A stale stored override can never resurrect a child while the parent is off.
    assert.equal(featureEnabled({ fieldTime: false, [key]: true }, key), false);
  }
  assert.deepEqual(FEATURE_BY_KEY.get("fieldTimeEquipment")!.requiresAll, ["equipment"]);
  assert.equal(
    featureEnabled({ projects: true, timeTracking: true, fieldTime: true, fieldTimeKiosk: true }, "fieldTimeKiosk"),
    true,
  );
});
// HR-20 end
// HR-18 begin: recruiting depth — the funnel rides the parent (on wherever
// hrm is on); kits, scheduling, signing, boards, retention and pools are
// opt-in sub-features that never resurrect while the parent is off.
test("hrmRecruiting rides hrm with six opt-in sub-features", () => {
  const def = FEATURE_BY_KEY.get("hrmRecruiting");
  assert.ok(def, "hrmRecruiting must be registered before routes gate on it");
  assert.equal(def.defaultEnabled, true);
  assert.equal(featureEnabled({}, "hrmRecruiting"), false);
  assert.equal(featureEnabled({ hrm: false, hrmRecruiting: true }, "hrmRecruiting"), false);
  assert.equal(featureEnabled({ hrm: true }, "hrmRecruiting"), true);
    "hrmStructuredInterviews",
    "hrmInterviewScheduling",
    "hrmOfferSigning",
    "hrmJobBoards",
    "hrmCandidateRetention",
    "hrmTalentPool",
    assert.equal(sub.parentKey, "hrmRecruiting");
    assert.equal(featureEnabled({ hrm: true, hrmRecruiting: false, [key]: true }, key), false);
    assert.equal(featureEnabled({ hrm: false, hrmRecruiting: true, [key]: true }, key), false);
    assert.equal(featureEnabled({ hrm: true, hrmRecruiting: true, [key]: true }, key), true);
// HR-18 end
