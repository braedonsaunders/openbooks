import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { createPosition } from "../positions.ts";
import { RecruitingError } from "./errors.ts";
import {
  DuplicateProspectError,
  findCandidateByEmail,
} from "./candidates.ts";
import { attachCandidate } from "./applications.ts";
import {
  cancelRequisition,
  createRequisition,
  openRequisition,
} from "./requisitions.ts";

/**
 * F3-62 DB coverage (integration partition): attaching a prospect to a
 * requisition is ONE transaction. The old two-POST island stored the
 * candidate first and the application second, so a failed second POST
 * orphaned the prospect; attachCandidate commits both rows together and
 * a failed attach stores nothing — proven by reading storage back, never
 * from the service's own return values alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setupOrg(): Promise<{ org: ScratchOrg; recruiterId: string }> {
  const org = await createScratchOrg();
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${org.orgId}`);
  const recruiterId = await createScratchUser(org.orgId, "HRM Recruiter", "hrm_recruiter");
  for (const permission of ["hrm.recruiting.read", "hrm.recruiting.manage", "hrm.position.read", "hrm.position.manage"]) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${org.orgId}, ${recruiterId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
  return { org, recruiterId };
}

let requisitionSequence = 0;
async function openHiringRequisition(orgId: string, recruiterId: string, subsidiaryId: string): Promise<string> {
  requisitionSequence += 1;
  const position = await createPosition({
    orgId,
    actorId: recruiterId,
    positionCode: `ENG-attach-${requisitionSequence}`,
    title: "Engineer",
    employerSubsidiaryId: subsidiaryId,
    plannedFte: "1.0000",
    status: "open",
    effectiveFrom: "2026-07-01",
    reason: "open the establishment",
  });
  const requisition = await createRequisition({
    orgId,
    actorId: recruiterId,
    title: "Backend engineer",
    positionId: position.id,
    employerSubsidiaryId: subsidiaryId,
    hiringManagerPartyId: null,
    headcount: 1,
    targetStartOn: "2026-10-01",
  });
  const opened = await openRequisition({ orgId, actorId: recruiterId, requisitionId: requisition.id });
  assert.equal(opened.status, "open");
  return opened.id;
}

async function candidateCount(orgId: string, email: string): Promise<number> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from hrm_candidates where org_id = ${orgId} and lower(btrim(email)) = lower(btrim(${email}))
  `)).rows;
  return rows.length;
}

async function applicationCount(orgId: string, requisitionId: string): Promise<number> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from hrm_applications where org_id = ${orgId} and requisition_id = ${requisitionId}
  `)).rows;
  return rows.length;
}

test("attach stores the candidate and the application together", { skip: !DB }, async () => {
  const { org, recruiterId } = await setupOrg();
  try {
    const requisitionId = await openHiringRequisition(org.orgId, recruiterId, org.subsidiaryId);
    const attached = await attachCandidate({
      orgId: org.orgId,
      actorId: recruiterId,
      requisitionId,
      displayName: "Ada Candidate",
      email: "ada@example.test",
    });
    assert.equal(attached.mergedInto, null);
    assert.equal(await candidateCount(org.orgId, "ada@example.test"), 1);
    assert.equal(await applicationCount(org.orgId, requisitionId), 1);
    const stored = await findCandidateByEmail(db, org.orgId, "ada@example.test");
    assert.equal(stored?.id, attached.candidate.id);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a failed attach stores no candidate row: the prospect is never orphaned", { skip: !DB }, async () => {
  const { org, recruiterId } = await setupOrg();
  try {
    const requisitionId = await openHiringRequisition(org.orgId, recruiterId, org.subsidiaryId);
    await cancelRequisition({ orgId: org.orgId, actorId: recruiterId, requisitionId, reason: "hiring freeze" });
    const error = await attachCandidate({
      orgId: org.orgId,
      actorId: recruiterId,
      requisitionId,
      displayName: "Orphan Prospect",
      email: "orphan@example.test",
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof RecruitingError, `expected a named refusal, got ${String(error)}`);
    // The candidate leg ran before the application leg refused on the
    // cancelled requisition: the rollback must have removed it.
    assert.equal(await candidateCount(org.orgId, "orphan@example.test"), 0);
    assert.equal(await applicationCount(org.orgId, requisitionId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a duplicate email refuses without a second row; mergeInto attaches to the survivor", { skip: !DB }, async () => {
  const { org, recruiterId } = await setupOrg();
  try {
    const requisitionId = await openHiringRequisition(org.orgId, recruiterId, org.subsidiaryId);
    const secondRequisitionId = await openHiringRequisition(org.orgId, recruiterId, org.subsidiaryId);
    const first = await attachCandidate({
      orgId: org.orgId,
      actorId: recruiterId,
      requisitionId,
      displayName: "Ada Candidate",
      email: "ada@example.test",
    });
    const duplicate = await attachCandidate({
      orgId: org.orgId,
      actorId: recruiterId,
      requisitionId: secondRequisitionId,
      displayName: "Ada Clone",
      email: "ADA@example.test",
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(duplicate instanceof DuplicateProspectError, `expected a structured duplicate refusal, got ${String(duplicate)}`);
    assert.equal((duplicate as DuplicateProspectError).candidateId, first.candidate.id);
    assert.equal(await candidateCount(org.orgId, "ada@example.test"), 1);
    assert.equal(await applicationCount(org.orgId, secondRequisitionId), 0);
    const merged = await attachCandidate({
      orgId: org.orgId,
      actorId: recruiterId,
      requisitionId: secondRequisitionId,
      displayName: "Ada Clone",
      email: "ada@example.test",
      mergeInto: first.candidate.id,
    });
    assert.equal(merged.mergedInto?.id, first.candidate.id);
    assert.equal(merged.application.candidateId, first.candidate.id);
    assert.equal(await candidateCount(org.orgId, "ada@example.test"), 1);
    assert.equal(await applicationCount(org.orgId, secondRequisitionId), 1);
    const kinds = (await db.execute<{ kind: string }>(sql`
      select kind from hrm_application_events
       where org_id = ${org.orgId} and application_id = ${merged.application.id} order by recorded_at, id
    `)).rows.map((row) => row.kind);
    assert.deepEqual(kinds, ["merged"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
