import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  hrmCompCycleFlowAdapter,
  hrmCompCycleSubjectProfile,
} from "./comp-cycles-adapter.ts";
import { HRM_COMP_CYCLE_SUBJECT_KIND } from "@openbooks/schema/src/hrm-compensation.ts";

/**
 * Comp-cycle Flows adapter (unit partition — no database): the subject
 * profile shape, the frozen self-approval policy, and the release's
 * refusal of unknown subjects. Release-onto-cycle is covered DB-side in
 * compensation.integration.test.ts through decideGate.
 */
describe("comp-cycle flow adapter", () => {
  test("subject kind and profile identify the cycle", () => {
    assert.equal(hrmCompCycleFlowAdapter.subjectKind, HRM_COMP_CYCLE_SUBJECT_KIND);
    assert.equal(hrmCompCycleSubjectProfile.subjectKind, HRM_COMP_CYCLE_SUBJECT_KIND);
    assert.deepEqual(hrmCompCycleFlowAdapter.writableFields, new Set<string>());
  });

  test("self-approval is forbidden outright", () => {
    assert.equal(hrmCompCycleFlowAdapter.selfApprovalPolicy, "forbidden");
  });

  test("status changes go through the approval engine, never a flow action", async () => {
    await assert.rejects(
      hrmCompCycleFlowAdapter.changeStatus("x", "approved", { orgId: "o" }),
      /released by the approval engine/,
    );
  });

  test("release refuses a non-uuid subject without touching storage", async () => {
    await assert.rejects(
      hrmCompCycleFlowAdapter.releaseApproval!("not-a-uuid", "approved", { orgId: "o" }),
      /unknown compensation cycle/,
    );
  });

  test("candidate search fails closed without an ambient tenant", async () => {
    await assert.rejects(hrmCompCycleFlowAdapter.findCandidateIds!(10), /ambient tenant context/);
  });
});
