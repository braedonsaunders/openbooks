import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOCATION_RUN_SUBJECT_KIND,
  allocationRunSubjectProfile,
  allocationRunsFlowAdapter,
} from "./allocation-runs-adapter.ts";
import { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";

test("allocation runs are a first-class configurable flow subject", () => {
  assert.equal(ALLOCATION_RUN_SUBJECT_KIND, "allocation_run");
  assert.equal(getFlowAdapter("allocation_run"), allocationRunsFlowAdapter);
  assert.ok(
    listFlowSubjectProfiles().some((profile) => profile.subjectKind === "allocation_run"),
  );
  assert.deepEqual(allocationRunSubjectProfile.triggers, ["on_submit"]);
  assert.ok(allocationRunSubjectProfile.actions.includes("notify"));
  assert.ok(allocationRunSubjectProfile.fields.some((field) => field.key === "sourceTotal"));
});

test("allocation runs expose no writable fields and release outside authored actions", async () => {
  assert.equal(allocationRunsFlowAdapter.writableFields.size, 0);
  assert.equal(
    allocationRunsFlowAdapter.deepLink("00000000-0000-0000-0000-000000000001"),
    "/admin/setup/allocations?tab=runs",
  );
  await assert.rejects(allocationRunsFlowAdapter.changeStatus("id", "posted", { orgId: "org" }), /approval engine/);
  await assert.rejects(
    allocationRunsFlowAdapter.setField("id", "status", "posted", { orgId: "org" }),
    /not writable/,
  );
});
