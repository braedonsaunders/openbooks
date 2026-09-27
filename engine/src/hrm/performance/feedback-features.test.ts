import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../platform/db.ts";
import { feedbackFeatureEnabled } from "./feedback.ts";

// Unit suite: the shared feedback-surface probe requires every key the
// service asserts (hrm and hrmPerformance) — never just the top-level hrm
// switch. The executor is a scripted double answering the org feature
// read; no database.

function fakeExec(features: Record<string, boolean> | null): SqlExecutor {
  return {
    execute: (_query: unknown) =>
      Promise.resolve({ rows: features === null ? [] : [{ features }] }),
  } as unknown as SqlExecutor;
}

const ORG = "00000000-0000-4000-8000-00000000d001";

test("the probe passes when hrm and performance are on, following registry defaults", async () => {
  assert.equal(await feedbackFeatureEnabled(fakeExec({ hrm: true, hrmPerformance: true }), ORG), true);
  // hrmPerformance defaults on: an org that never touched it agrees with
  // the service, which reads the same switch — no drift, no refusal.
  assert.equal(await feedbackFeatureEnabled(fakeExec({ hrm: true }), ORG), true);
});

test("the probe fails when performance is off while hrm is on", async () => {
  // The regression: an org with HR on and performance explicitly off must
  // list nothing from the feedback leg — never throw FEATURE_OFF out of it
  // into every inbox read.
  assert.equal(await feedbackFeatureEnabled(fakeExec({ hrm: true, hrmPerformance: false }), ORG), false);
});

test("the probe fails when hrm is off or the org is missing", async () => {
  assert.equal(await feedbackFeatureEnabled(fakeExec({ hrm: false, hrmPerformance: true }), ORG), false);
  assert.equal(await feedbackFeatureEnabled(fakeExec(null), ORG), false);
});
