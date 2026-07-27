import assert from "node:assert/strict";
import test from "node:test";
import {
  FIELD_TICKET_SUBJECT_KIND,
  fieldTicketSubjectProfile,
} from "./field-tickets-adapter.ts";
import {
  registerFlowApprovalReleaseHandler,
  releaseFlowApproval,
} from "./approval-release-hook.ts";
import { listFlowSubjectProfiles } from "./registry.ts";

test("field tickets are an authorable Flows subject with no hardcoded approver", () => {
  const profile = listFlowSubjectProfiles().find(
    (candidate) => candidate.subjectKind === FIELD_TICKET_SUBJECT_KIND,
  );
  assert.equal(profile, fieldTicketSubjectProfile);
  assert.deepEqual(profile?.triggers, ["on_submit"]);
  assert.equal(
    profile?.fields.some((field) => field.key === "totalHours"),
    true,
  );
  assert.equal(
    profile?.fields.some((field) => field.key === "projectId"),
    true,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(profile ?? {}, "approver"),
    false,
  );
});

test("field-ticket release delegates to the registered atomic product handler", async () => {
  const calls: unknown[] = [];
  registerFlowApprovalReleaseHandler(
    FIELD_TICKET_SUBJECT_KIND,
    async (args) => {
      calls.push(args);
    },
  );
  await releaseFlowApproval({
    subjectKind: FIELD_TICKET_SUBJECT_KIND,
    subjectId: "00000000-0000-4000-8000-000000000001",
    outcome: "approved",
    comment: "verified",
    ctx: {
      orgId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000003",
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    subjectKind: FIELD_TICKET_SUBJECT_KIND,
    subjectId: "00000000-0000-4000-8000-000000000001",
    outcome: "approved",
    comment: "verified",
    ctx: {
      orgId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000003",
    },
  });
});
