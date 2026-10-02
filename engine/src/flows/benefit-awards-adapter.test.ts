import { BENEFIT_ENROLLMENT_SUBJECT_KIND } from "@openbooks/schema/src/hrm-benefits.ts";
import { benefitEnrollmentsFlowAdapter, benefitEnrollmentSubjectProfile } from "./benefit-enrollments-adapter.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { BENEFIT_AWARD_SUBJECT_KIND } from "@openbooks/schema/src/benefits-programs.ts";
import {
  benefitAwardsFlowAdapter,
  benefitAwardSubjectProfile,
} from "./benefit-awards-adapter.ts";
import {
  getFlowAdapter,
  listFlowSubjectProfiles,
  handlerReleasedSubjectKinds,
} from "./registry.ts";
import { hasFlowApprovalReleaseHandler } from "./approval-release-hook.ts";
import { installEngineSeams } from "../composition/install.ts";

installEngineSeams();
test("Benefits is authorable with explicit direct processing and conditional routing fields", () => {
  assert.equal(
    getFlowAdapter(BENEFIT_AWARD_SUBJECT_KIND),
    benefitAwardsFlowAdapter,
  );
  assert.equal(
    listFlowSubjectProfiles().filter(
      (profile) => profile.subjectKind === BENEFIT_AWARD_SUBJECT_KIND,
    ).length,
    1,
  );
  assert.equal(benefitAwardSubjectProfile.supportsUngatedSubmission, true);
  assert.deepEqual(benefitAwardSubjectProfile.triggers, ["on_submit"]);
  for (const key of [
    "programId",
    "family",
    "value",
    "currency",
    "legalEntityId",
    "departmentId",
  ])
    assert.ok(
      benefitAwardSubjectProfile.fields.some((field) => field.key === key),
    );
});
test("Benefits release is installed for every process using the composition root", () => {
  assert.ok(handlerReleasedSubjectKinds().includes(BENEFIT_AWARD_SUBJECT_KIND));
  assert.equal(hasFlowApprovalReleaseHandler(BENEFIT_AWARD_SUBJECT_KIND), true);
});
test("Benefits human independence is governed by the authored gate policy", () => {
  assert.equal(benefitAwardsFlowAdapter.selfApprovalPolicy, "configurable");
  assert.deepEqual(benefitAwardsFlowAdapter.writableFields, new Set());
});
test("Flows cannot bypass Benefits decisions by changing a status or evidence field", async () => {
  await assert.rejects(
    benefitAwardsFlowAdapter.changeStatus("reward", "approved", {
      orgId: "organization",
    }),
    /submission and approval decisions/,
  );
  await assert.rejects(
    benefitAwardsFlowAdapter.setField("reward", "value", "500", {
      orgId: "organization",
    }),
    /immutable/,
  );
});
test("Benefits scheduled candidates fail closed without organization context", async () => {
  await assert.rejects(
    benefitAwardsFlowAdapter.findCandidateIds!(10),
    /ambient organization context/,
  );
});
test("invalid record IDs return no workflow context without querying the database", async () => {
  assert.equal(await benefitAwardsFlowAdapter.loadContext("not-an-id"), null);
  assert.equal(await benefitAwardsFlowAdapter.getStatus("not-an-id"), null);
});

test("Enrollment decisions use scoped native gates with configurable human independence", async () => {
  assert.equal(getFlowAdapter(BENEFIT_ENROLLMENT_SUBJECT_KIND), benefitEnrollmentsFlowAdapter);
  assert.equal(listFlowSubjectProfiles().filter(p => p.subjectKind === BENEFIT_ENROLLMENT_SUBJECT_KIND).length, 1);
  assert.equal(benefitEnrollmentSubjectProfile.supportsUngatedSubmission, true);
  assert.equal(benefitEnrollmentsFlowAdapter.selfApprovalPolicy, "configurable");
  assert.equal(hasFlowApprovalReleaseHandler(BENEFIT_ENROLLMENT_SUBJECT_KIND), true);
  assert.equal(benefitEnrollmentsFlowAdapter.scope.via, "employment");
  await assert.rejects(benefitEnrollmentsFlowAdapter.changeStatus("election", "active", {orgId:"org"}), /submission and approval/);
  await assert.rejects(benefitEnrollmentsFlowAdapter.setField("election", "electedRate", "5", {orgId:"org"}), /immutable/);
  await assert.rejects(benefitEnrollmentsFlowAdapter.findCandidateIds!(10), /ambient organization/);
  assert.equal(await benefitEnrollmentsFlowAdapter.loadContext("not-an-id"), null);
});
