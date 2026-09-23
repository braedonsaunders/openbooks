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
import { RecruitingError } from "./errors.ts";
import {
  createRequisition,
  openRequisition,
} from "./requisitions.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { cancelInterview, scheduleInterview } from "./interviews.ts";
import { bookSlot, proposeSlots, readBookingLink } from "./scheduling.ts";
import { hashRecruitingToken } from "./tokens.ts";

/**
 * Interview cancel vs self-booking over the real 0229 tables — DB-owned,
 * one file at a time. No skip guards: the integration partition
 * guarantees a database.
 *
 * Proofs are read back from storage, and every refusal asserts its code
 * AND its message: the message is the entire product of a failing check.
 */

const priorSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = priorSecret ?? "openbooks-test-only-scheduling-secret";
test.after(() => {
  if (priorSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = priorSecret;
});

type Harness = {
  org: ScratchOrg;
  recruiterId: string;
  interviewerPartyId: string;
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

async function enableDepth(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmRecruiting", "hrmStructuredInterviews", "hrmInterviewScheduling"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableDepth(org.orgId);
  const recruiterId = await createScratchUser(org.orgId, "Scheduling Recruiter", "scheduling_recruiter");
  const interviewerId = await createScratchUser(org.orgId, "Scheduling Interviewer", "scheduling_interviewer");
  await grant(org.orgId, recruiterId, ["hrm.recruiting.read", "hrm.recruiting.manage"]);
  const interviewerPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${interviewerPartyId}, ${org.orgId}, 'person', 'Scheduling Interviewer', true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${interviewerPartyId} where id = ${interviewerId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${org.orgId}, ${interviewerPartyId}, ${org.subsidiaryId})
  `);
  return { org, recruiterId, interviewerPartyId };
}

async function seedProposed(h: Harness): Promise<{ interviewId: string; token: string; slotId: string }> {
  const orgId = h.org.orgId;
  const requisition = await createRequisition({
    orgId,
    actorId: h.recruiterId,
    title: "Backend engineer",
    employerSubsidiaryId: h.org.subsidiaryId,
    headcount: 1,
  });
  const opened = await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
  const { candidate } = await createCandidate({
    orgId,
    actorId: h.recruiterId,
    displayName: "Slot Candidate",
    email: `slot-${randomUUID()}@example.test`,
    source: "direct",
  });
  const application = await createApplication({
    orgId,
    actorId: h.recruiterId,
    requisitionId: opened.id,
    candidateId: candidate.id,
  });
  const interview = await scheduleInterview({
    orgId,
    actorId: h.recruiterId,
    applicationId: application.id,
    kind: "video",
    scheduledAt: "2027-09-25T14:00:00Z",
    panelPartyIds: [h.interviewerPartyId],
  });
  const proposed = await proposeSlots({
    orgId,
    actorId: h.recruiterId,
    interviewId: interview.id,
    windows: [{ startsAt: "2027-10-01T09:00:00Z", endsAt: "2027-10-01T09:30:00Z", timezone: "America/Toronto" }],
  });
  return { interviewId: interview.id, token: proposed.bookingToken, slotId: proposed.slots[0]!.id };
}

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

test("cancelling an interview kills the outstanding booking link", async () => {
  const h = await setupHarness();
  try {
    const { interviewId, token, slotId } = await seedProposed(h);
    const orgId = h.org.orgId;
    await cancelInterview({ orgId, actorId: h.recruiterId, interviewId });
    // Proposed slots die with the interview, proved from storage.
    const slots = (await db.execute<{ kind: string; tokenHash: string | null }>(sql`
      select kind, candidate_token_hash as "tokenHash" from hrm_interview_slots
       where org_id = ${orgId} and interview_id = ${interviewId}
    `)).rows;
    assert.ok(slots.length > 0);
    for (const slot of slots) {
      assert.equal(slot.kind, "declined");
      assert.equal(slot.tokenHash, null);
    }
    // The candidate's link is dead: booking and reading both refuse.
    const bookError = recruitingError(await bookSlot({
      bookingToken: token,
      slotId,
      candidateName: "Slot Candidate",
      enqueueEmail: async () => {},
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(bookError.code, "REFUSED");
    assert.match(bookError.message, /no longer live/);
    const readError = recruitingError(await readBookingLink(token).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(readError.code, "REFUSED");
    assert.match(readError.message, /no open slots/);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("booking a cancelled interview is refused by name even when the link resolves", async () => {
  const h = await setupHarness();
  try {
    const { interviewId, token, slotId } = await seedProposed(h);
    const orgId = h.org.orgId;
    await cancelInterview({ orgId, actorId: h.recruiterId, interviewId });
    // Simulate the interleaving the status gate exists for: the link lookup
    // resolved, then the cancel committed. Restore the hash alone (the slot
    // stays declined) so the link resolves against a cancelled interview.
    await db.execute(sql`
      update hrm_interview_slots
         set candidate_token_hash = ${hashRecruitingToken(token)}
       where org_id = ${orgId} and interview_id = ${interviewId} and id = ${slotId}
    `);
    const error = recruitingError(await bookSlot({
      bookingToken: token,
      slotId,
      candidateName: "Slot Candidate",
      enqueueEmail: async () => {},
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /was cancelled/);
    // And nothing was booked.
    const booked = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_interview_slots
       where org_id = ${orgId} and interview_id = ${interviewId} and kind = 'booked'
    `)).rows[0]!.n;
    assert.equal(booked, "0");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
