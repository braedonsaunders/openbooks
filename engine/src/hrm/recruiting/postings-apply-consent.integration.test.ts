import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import {
  createRequisition,
  openRequisition,
} from "./requisitions.ts";
import { createCandidate } from "./candidates.ts";
import {
  applyViaPosting,
  publishPosting,
} from "./postings.ts";

/**
 * Anonymous apply vs existing-candidate consent over the real 0229 tables
 * — DB-owned, one file at a time. No skip guards: the integration
 * partition guarantees a database.
 *
 * An email typed into an anonymous form proves nothing about identity, so
 * a match must never write consent: the consent upsert clears
 * withdrawn_at, and anyone could otherwise reinstate another candidate's
 * withdrawn consent. Proofs are read back from storage.
 */

type Harness = {
  org: ScratchOrg;
  recruiterId: string;
};

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function enableBoards(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmRecruiting", "hrmJobBoards"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableBoards(org.orgId);
  const recruiterId = await createScratchUser(org.orgId, "Apply Recruiter", "apply_recruiter");
  await grant(org.orgId, recruiterId, ["hrm.recruiting.read", "hrm.recruiting.manage"]);
  return { org, recruiterId };
}

async function seedPublishedPosting(h: Harness, title: string): Promise<string> {
  const requisition = await createRequisition({
    orgId: h.org.orgId,
    actorId: h.recruiterId,
    title,
    employerSubsidiaryId: h.org.subsidiaryId,
    headcount: 1,
  });
  const opened = await openRequisition({ orgId: h.org.orgId, actorId: h.recruiterId, requisitionId: requisition.id });
  const posting = await publishPosting({
    orgId: h.org.orgId,
    actorId: h.recruiterId,
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
  const h = await setupHarness();
  try {
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
    const postingId = await seedPublishedPosting(h, "Backend engineer");
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
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("anonymous apply writes no consent for a matched candidate without prior consent", async () => {
  const h = await setupHarness();
  try {
    const orgId = h.org.orgId;
    const email = `known-${randomUUID()}@example.test`;
    const { candidate } = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Known Candidate",
      email,
      source: "direct",
    });
    const postingId = await seedPublishedPosting(h, "Backend engineer");
    const applied = await applyViaPosting({
      orgId,
      postingId,
      displayName: "Someone Else",
      email,
      consentFutureRoles: true,
    });
    assert.equal(applied.duplicate, false);
    assert.deepEqual(await consentRows(orgId, candidate.id), [], "no consent row is written for a matched candidate");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
