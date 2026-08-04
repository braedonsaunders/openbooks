// Run with:  node --import tsx --test engine/src/flows/quorum.test.ts
//
// Pure quorum-resolution tests for single- and multi-assignee flow gates.
// Conventions
// follow packages/forms-core/src/automation.test.ts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveQuorumOutcome, type SiblingGate } from "./quorum.ts";

const g = (id: string, status: SiblingGate["status"]): SiblingGate => ({ id, status });

describe("quorum 'any'", () => {
  test("first approval wins the gate and cancels pending siblings", () => {
    const out = resolveQuorumOutcome("any", "approved", [
      g("a", "approved"),
      g("b", "pending"),
      g("c", "pending"),
    ]);
    assert.equal(out.resume, "approve");
    assert.deepEqual(out.cancelIds.sort(), ["b", "c"]);
  });

  test("first rejection wins the gate and cancels pending siblings", () => {
    const out = resolveQuorumOutcome("any", "rejected", [g("a", "rejected"), g("b", "pending")]);
    assert.equal(out.resume, "reject");
    assert.deepEqual(out.cancelIds, ["b"]);
  });

  test("single-assignee gate: decision equals branch", () => {
    assert.equal(resolveQuorumOutcome("any", "approved", [g("a", "approved")]).resume, "approve");
    assert.equal(resolveQuorumOutcome("any", "rejected", [g("a", "rejected")]).resume, "reject");
  });
});

describe("quorum 'all'", () => {
  test("one rejection rejects the whole gate and cancels the rest", () => {
    const out = resolveQuorumOutcome("all", "rejected", [
      g("a", "approved"),
      g("b", "rejected"),
      g("c", "pending"),
    ]);
    assert.equal(out.resume, "reject");
    assert.deepEqual(out.cancelIds, ["c"]);
  });

  test("an approval with siblings still pending keeps waiting", () => {
    const out = resolveQuorumOutcome("all", "approved", [g("a", "approved"), g("b", "pending")]);
    assert.equal(out.resume, null);
    assert.deepEqual(out.cancelIds, []);
  });

  test("the last approval resumes the approve branch", () => {
    const out = resolveQuorumOutcome("all", "approved", [g("a", "approved"), g("b", "approved")]);
    assert.equal(out.resume, "approve");
    assert.deepEqual(out.cancelIds, []);
  });

  test("escalated rows do not block the quorum but cancel on rejection", () => {
    // a escalated to c; b rejects → gate rejects, both open rows cancel.
    const rejected = resolveQuorumOutcome("all", "rejected", [
      g("a", "escalated"),
      g("b", "rejected"),
      g("c", "pending"),
    ]);
    assert.equal(rejected.resume, "reject");
    assert.deepEqual(rejected.cancelIds.sort(), ["a", "c"]);

    // the replacement row (pending) is what an 'all' approval waits on…
    const waiting = resolveQuorumOutcome("all", "approved", [
      g("a", "escalated"),
      g("b", "approved"),
      g("c", "pending"),
    ]);
    assert.equal(waiting.resume, null);

    // …and once every live row approved, the escalated leftover cancels.
    const done = resolveQuorumOutcome("all", "approved", [
      g("a", "escalated"),
      g("b", "approved"),
      g("c", "approved"),
    ]);
    assert.equal(done.resume, "approve");
    assert.deepEqual(done.cancelIds, ["a"]);
  });
});
