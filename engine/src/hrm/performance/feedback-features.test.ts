import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../platform/db.ts";
import { feedbackFeatureEnabled } from "./feedback.ts";

// Unit suite: the shared feedback-surface probe requires EVERY key the
// service asserts (hrm, hrmPerformance, hrmFeedback) — never just the
// top-level hrm switch. The executor is a scripted double answering the
// org feature read; no database.

function fakeExec(features: Record<string, boolean> | null): SqlExecutor {
  return {
    execute: (_query: unknown) =>
      Promise.resolve({ rows: features === null ? [] : [{ features }] }),
  } as unknown as SqlExecutor;
}

const ORG = "00000000-0000-4000-8000-00000000d001";

test("the probe passes only when hrm, continuous performance, and feedback are all on", async () => {
  assert.equal(
    await feedbackFeatureEnabled(fakeExec({ hrm: true, hrmPerformance: true, hrmFeedback: true }), ORG),
    true,
  );
});

test("the probe fails when continuous performance is off while hrm is on", async () => {
  // The regression: an org with HR on and continuous performance
  // explicitly off must list nothing from the feedback leg — never throw
  // FEATURE_OFF out of it into every inbox read.
  assert.equal(
    await feedbackFeatureEnabled(fakeExec({ hrm: true, hrmPerformance: false, hrmFeedback: true }), ORG),
    false,
  );
});

test("the probe follows registry defaults for unset keys", async () => {
  // hrmPerformance defaults on: an org that never touched it agrees with
  // the service, which reads the same switch — no drift, no refusal.
  assert.equal(
    await feedbackFeatureEnabled(fakeExec({ hrm: true, hrmFeedback: true }), ORG),
    true,
  );
  // hrmFeedback defaults off: unset still lists nothing.
  assert.equal(
    await feedbackFeatureEnabled(fakeExec({ hrm: true, hrmPerformance: true }), ORG),
    false,
  );
});

test("the probe fails when hrm or feedback alone is off", async () => {
  assert.equal(
    await feedbackFeatureEnabled(fakeExec({ hrm: false, hrmPerformance: true, hrmFeedback: true }), ORG),
    false,
  );
  assert.equal(
    await feedbackFeatureEnabled(fakeExec({ hrm: true, hrmPerformance: true, hrmFeedback: false }), ORG),
    false,
  );
  assert.equal(await feedbackFeatureEnabled(fakeExec(null), ORG), false);
});
