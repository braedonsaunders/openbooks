import assert from "node:assert/strict";
import test from "node:test";
import { runSubsidiaryVisible, validateLineageAnchor } from "./run-queries.ts";

// Pure read guards for the Runs tab + lineage drill (A8). SQL round trips
// are pinned by run-queries.integration.test.ts.

test("lineage needs exactly one anchor", () => {
  const r = "11111111-1111-4111-8111-111111111111";
  const j = "22222222-2222-4222-8222-222222222222";
  const d = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(validateLineageAnchor({ runId: r }), { kind: "run", id: r });
  assert.deepEqual(validateLineageAnchor({ journalEntryId: j }), { kind: "journalEntry", id: j });
  assert.deepEqual(validateLineageAnchor({ documentId: d }), { kind: "document", id: d });
  assert.throws(() => validateLineageAnchor({}), /exactly one/);
  assert.throws(() => validateLineageAnchor({ runId: r, documentId: d }), /exactly one/);
  assert.throws(() => validateLineageAnchor({ runId: "not-a-uuid" }), /uuid/);
});

test("restricted callers see only runs in their subsidiary scope", () => {
  // Unrestricted (null) sees everything, including org-wide runs.
  assert.equal(runSubsidiaryVisible(null, null), true);
  assert.equal(runSubsidiaryVisible(null, "11111111-1111-4111-8111-111111111111"), true);
  const allowed = new Set(["11111111-1111-4111-8111-111111111111"]);
  assert.equal(runSubsidiaryVisible(allowed, "11111111-1111-4111-8111-111111111111"), true);
  // Org-wide runs aggregate subsidiaries the caller may not see.
  assert.equal(runSubsidiaryVisible(allowed, null), false);
  assert.equal(runSubsidiaryVisible(allowed, "22222222-2222-4222-8222-222222222222"), false);
  assert.equal(runSubsidiaryVisible(new Set(), "11111111-1111-4111-8111-111111111111"), false);
});
