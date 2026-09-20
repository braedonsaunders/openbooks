import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHrmPipelineStageInput } from "./hrm-pipeline.ts";

test("other entities pass through untouched", () => {
  const body = { name: "X" };
  assert.equal(normalizeHrmPipelineStageInput("hrm-pipeline-templates", body), body);
});

test("kind folds to its derived terminality, never an independent flag", () => {
  assert.deepEqual(normalizeHrmPipelineStageInput("hrm-pipeline-stages", { kind: "hired" }), {
    kind: "hired",
    isTerminal: true,
  });
  assert.deepEqual(normalizeHrmPipelineStageInput("hrm-pipeline-stages", { kind: "screening" }), {
    kind: "screening",
    isTerminal: false,
  });
  assert.deepEqual(normalizeHrmPipelineStageInput("hrm-pipeline-stages", { name: "No kind yet" }), {
    name: "No kind yet",
  });
});
