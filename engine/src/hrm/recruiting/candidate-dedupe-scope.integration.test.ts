import { test } from "node:test";
import assert from "node:assert/strict";
import { RecruitingError } from "./errors.ts";
import { DuplicateProspectError, createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import {
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-DEDUPE on F3-62's single-transaction attach: the duplicate
 * path answers identity questions, so ownership comes first — a survivor
 * owned outside the actor's scope refuses exactly like an unknown
 * candidate (no existence leak, no identity), while an in-scope duplicate
 * keeps the structural retry (the id the island merges with) with no name
 * in the message. (The existing funnel test covers the unrestricted merge
 * path; this file covers the scoped denials.)
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

test("H-RECRUIT-DEDUPE: an out-of-scope duplicate refuses like an unknown candidate", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting"]);
  try {
    const orgId = h.org.orgId;
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
    const { candidate: survivor } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Bea B", email: "bea@example.test" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: survivor.id });

    // A scoped actor guessing the survivor's email learns nothing: uniform denial.
    const refusal = await createCandidate({ orgId, actorId: h.scopedId, displayName: "Bea Clone", email: "bea@example.test" }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the out-of-scope duplicate refuses");
    assert.equal(refusal.code, "NOT_FOUND", "duplicate denials are uniform with not-found across scope");
    assert.ok(!refusal.message.includes("Bea B"), "the denial names no identity");
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUIT-DEDUPE: an in-scope duplicate keeps the structural retry without the name", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting"]);
  try {
    const orgId = h.org.orgId;
    const { candidate: first } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ada Original", email: "ada@example.test" });
    const refusal = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ada Clone", email: "ADA@example.test" }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the duplicate refuses");
    assert.equal(refusal.code, "REFUSED");
    assert.ok(refusal instanceof DuplicateProspectError, "the refusal is structural, never a parsed message");
    assert.equal(refusal.candidateId, first.id, "the retry reference rides structurally");
    assert.ok(!refusal.message.includes("Ada Original"), "the survivor's name never rides the refusal");
    assert.match(refusal.message, /mergeInto/, "the remedy names the merge parameter");
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUIT-DEDUPE: merging needs ownership of the survivor", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting"]);
  try {
    const orgId = h.org.orgId;
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
    const { candidate: survivor } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Bea B", email: "bea@example.test" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: survivor.id });

    // A scoped merger guessing the survivor id learns nothing: uniform denial.
    const refusal = await createCandidate({
      orgId, actorId: h.scopedId, displayName: "Bea Clone", email: "bea@example.test", mergeInto: survivor.id,
    }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the out-of-scope merge refuses");
    assert.equal(refusal.code, "NOT_FOUND", "merge denials are uniform with not-found");
    assert.ok(!refusal.message.includes("Bea B"), "the denial names no identity");

    // The unrestricted admin merges the same survivor (ownership is total).
    const merged = await createCandidate({
      orgId, actorId: h.adminId, displayName: "Bea Clone", email: "bea@example.test", mergeInto: survivor.id,
    });
    assert.equal(merged.mergedInto!.id, survivor.id, "no new record: the survivor attaches");
  } finally {
    await teardownScopeHarness(h);
  }
});
