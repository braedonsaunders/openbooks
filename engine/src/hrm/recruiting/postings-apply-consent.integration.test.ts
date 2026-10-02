import { sql } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../../platform/db.ts";
import {
  type ScratchOrg
} from "../../testing/fixtures.ts";
import { setupHarness, withHarness } from "../../testing/hrm-harness.ts";
import { createCandidate } from "./candidates.ts";
import {
  applyViaPosting,
  publishPosting,
} from "./postings.ts";
import {
  createRequisition,
  openRequisition,
} from "./requisitions.ts";

const POSTINGS_APPLY_CONSENT_SPEC = {
  features: ["hrm", "hrmRecruiting"],
  users: [
    { key: "recruiterId", name: "Apply Recruiter", handle: "apply_recruiter", permissions: ["hrm.recruiting.read", "hrm.recruiting.manage"] },
  ],
} as const;

async function seedPublishedPosting(org: ScratchOrg, recruiterId: string, title: string): Promise<string> {
  const requisition = await createRequisition({
    orgId: org.orgId,
    actorId: recruiterId,
    title,
    employerSubsidiaryId: org.subsidiaryId,
    headcount: 1,
  });
  const opened = await openRequisition({ orgId: org.orgId, actorId: recruiterId, requisitionId: requisition.id });
  const posting = await publishPosting({
    orgId: org.orgId,
    actorId: recruiterId,
    requisitionId: opened.id,
    boardKey: "internal",
  });
  assert.equal(posting.status, "published");
  return posting.id;
}

async function consentRows(orgId: string, candidateId: string): Promise<{ purpose: string; grantedAt: string; withdrawnAt: string | null }[]> {
  return (await db.execute<{ purpose: string; grantedAt: string; withdrawnAt: string | null }>(sql`
    select purpose, granted_at as "grantedAt", withdrawn_at as "withdrawnAt"
      from hrm_candidate_consents
     where org_id = ${orgId} and candidate_id = ${candidateId}
     order by purpose
  `)).rows;
}

test("anonymous apply never reinstates a withdrawn consent", async () => {
  await withHarness(() => setupHarness(POSTINGS_APPLY_CONSENT_SPEC), async (h) => {
    const orgId = h.org.orgId;
    const email = `known-${randomUUID()}@example.test`;
    const { candidate } = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Known Candidate",
      email,
      source: "direct",
    });
    // The candidate withdrew future-roles consent a day ago, granted a month ago.
    await db.execute(sql`
      insert into hrm_candidate_consents (org_id, candidate_id, purpose, source, granted_at, withdrawn_at)
      values (${orgId}, ${candidate.id}, 'future_roles', 'form',
              now() - interval '30 days', now() - interval '1 day')
    `);
    const before = (await consentRows(orgId, candidate.id)).find((row) => row.purpose === "future_roles")!;
    const postingId = await seedPublishedPosting(h.org, h.recruiterId, "Backend engineer");
    // A stranger types the known address and ticks every consent box.
    const applied = await applyViaPosting({
      orgId,
      postingId,
      displayName: "Someone Else",
      email,
      consentFutureRoles: true,
    });
    assert.equal(applied.duplicate, false, "the candidacy still lands");
    assert.equal(applied.candidateId, candidate.id, "the existing candidate row is reused");
    const after = await consentRows(orgId, candidate.id);
    const future = after.find((row) => row.purpose === "future_roles")!;
    assert.equal(future.withdrawnAt !== null, true, "the withdrawal stands — a stranger cannot reinstate it");
    assert.equal(future.grantedAt, before.grantedAt, "the grant timestamp is untouched");
    assert.ok(!after.some((row) => row.purpose === "this_application"), "no application consent is granted either");
  });
});

test("anonymous apply writes no consent for a matched candidate without prior consent", async () => {
  await withHarness(() => setupHarness(POSTINGS_APPLY_CONSENT_SPEC), async (h) => {
    const orgId = h.org.orgId;
    const email = `known-${randomUUID()}@example.test`;
    const { candidate } = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Known Candidate",
      email,
      source: "direct",
    });
    const postingId = await seedPublishedPosting(h.org, h.recruiterId, "Backend engineer");
    const applied = await applyViaPosting({
      orgId,
      postingId,
      displayName: "Someone Else",
      email,
      consentFutureRoles: true,
    });
    assert.equal(applied.duplicate, false);
    assert.deepEqual(await consentRows(orgId, candidate.id), [], "no consent row is written for a matched candidate");
  });
});

test("concurrent public applications with the same email reuse one candidate row", async () => {
  await withHarness(() => setupHarness(POSTINGS_APPLY_CONSENT_SPEC), async (h) => {
    const email = `concurrent-${randomUUID()}@example.test`;
    const firstPosting = await seedPublishedPosting(h.org, h.recruiterId, "Backend engineer");
    const secondPosting = await seedPublishedPosting(h.org, h.recruiterId, "Platform engineer");
    const [first, second] = await Promise.all([
      applyViaPosting({ orgId: h.org.orgId, postingId: firstPosting, displayName: "Applicant One", email }),
      applyViaPosting({ orgId: h.org.orgId, postingId: secondPosting, displayName: "Applicant Two", email: email.toUpperCase() }),
    ]);
    assert.equal(first.candidateId, second.candidateId, "both openings attach to the one email survivor");
    const candidates = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from hrm_candidates
       where org_id = ${h.org.orgId} and lower(email) = lower(${email})
    `);
    assert.equal(candidates.rows[0]?.count, 1);
  });
});
