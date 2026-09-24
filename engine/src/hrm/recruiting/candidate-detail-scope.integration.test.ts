import { test } from "node:test";
import assert from "node:assert/strict";
import { RecruitingError } from "./errors.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { getCandidateDetail } from "./recruiting-read.ts";
import { createTalentPool, addPoolMember } from "./pools.ts";
import {
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUITING: the read grant alone never opens another entity's
 * pipeline. A scoped grant holder reads PII and funnel rows only through
 * applications on in-scope requisitions; a candidate owned entirely
 * outside their scope is uniform not-found (same message as unknown);
 * pool-shared candidates render identity-only. A candidate attached to
 * both entities shows the scoped reader only their own slice (the
 * coordinator's row-level rule).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

test("H-RECRUITING: a scoped reader sees PII only through in-scope requisitions", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmTalentPool"]);
  try {
    const orgId = h.org.orgId;
    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");

    const { candidate: candA } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test", phone: "+1-555-0001" });
    const { candidate: candB } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Bob B", email: "bob@example.test", phone: "+1-555-0002" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candA.id });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: candB.id });

    const seen = await getCandidateDetail({ orgId, actorId: h.scopedId, candidateId: candA.id });
    assert.equal(seen.email, "ann@example.test", "owned candidates still show PII to grant holders");
    assert.equal(seen.applications.length, 1, "only the in-scope application renders");

    const refusal = await getCandidateDetail({ orgId, actorId: h.scopedId, candidateId: candB.id }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the out-of-scope candidate refuses");
    assert.equal(refusal.code, "NOT_FOUND", "scope denials are uniform with not-found");
    assert.equal(refusal.message, "candidate is not visible in this organization", "the message names no entity");

    // The admin still reads both in full (the fix narrows scoped readers only).
    const adminSeen = await getCandidateDetail({ orgId, actorId: h.adminId, candidateId: candB.id });
    assert.equal(adminSeen.email, "bob@example.test");
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUITING: a dual-attached candidate shows only the reader's slice", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting"]);
  try {
    const orgId = h.org.orgId;
    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");

    const { candidate } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Dual D", email: "dual@example.test" });
    const appA = await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candidate.id });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: candidate.id });

    const seen = await getCandidateDetail({ orgId, actorId: h.scopedId, candidateId: candidate.id });
    assert.equal(seen.email, "dual@example.test", "ownership through A opens PII");
    assert.deepEqual(
      seen.applications.map((entry) => entry.applicationId),
      [appA.id],
      "the B slice never rides an A-scoped read",
    );
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUITING: a pool-shared candidate renders identity-only to scoped readers", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmTalentPool"]);
  try {
    const orgId = h.org.orgId;
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
    const { candidate } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Pooled P", email: "pooled@example.test" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: candidate.id });
    const pool = await createTalentPool({ orgId, actorId: h.adminId, name: "bench" });
    await addPoolMember({ orgId, actorId: h.adminId, poolId: pool.id, candidateId: candidate.id });

    const seen = await getCandidateDetail({ orgId, actorId: h.scopedId, candidateId: candidate.id });
    assert.equal(seen.displayName, "Pooled P", "pool sharing opens identity");
    assert.equal(seen.email, null, "pool sharing never opens contact PII");
    assert.equal(seen.phone, null);
    assert.equal(seen.resumeAttachmentId, null);
    assert.deepEqual(seen.applications, [], "the B funnel never rides an A-scoped read");
  } finally {
    await teardownScopeHarness(h);
  }
});
