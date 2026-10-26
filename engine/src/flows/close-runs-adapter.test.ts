import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_RUN_SUBJECT_KIND,
  closeRunSubjectProfile,
  closeRunsFlowAdapter,
} from "./close-runs-adapter.ts";
import { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";

test("period close is a first-class configurable flow subject", () => {
  assert.equal(CLOSE_RUN_SUBJECT_KIND, "close_run");
  assert.equal(getFlowAdapter("close_run"), closeRunsFlowAdapter);
  assert.ok(listFlowSubjectProfiles().some((profile) => profile.subjectKind === "close_run"));
  assert.deepEqual(closeRunSubjectProfile.triggers, ["on_submit"]);
  assert.ok(closeRunSubjectProfile.actions.includes("notify"));
  assert.ok(closeRunSubjectProfile.fields.some((field) => field.key === "periodType"));
});

test("period close freezes its configurable approval policy", () => {
  assert.equal(closeRunSubjectProfile.pinsSubmissionPolicy, true);
  assert.equal(
    closeRunsFlowAdapter.deepLink("00000000-0000-0000-0000-000000000001"),
    "/close?run=00000000-0000-0000-0000-000000000001&stage=lock",
  );
});

test("a close run is titled by its fiscal period label, not its stored name", () => {
  assert.equal(
    closeRunsFlowAdapter.label("run-1", {
      periodName: "2026-12",
      periodLabel: "P12 FY2026",
      bookName: "Primary",
    }),
    "P12 FY2026 close · Primary",
  );
});
