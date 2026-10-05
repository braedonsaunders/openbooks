import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { DB, setupHarness, withHarness, seedEmployment, setFeatures } from "../../testing/hrm-harness.ts";
import { createQualificationType, updateQualificationType } from "../qualifications/types.ts";
import { verifyQualification } from "../qualifications/qualifications.ts";
import { createTrainingCourse, transitionTrainingCourse, createTrainingSession, transitionTrainingSession, inviteTrainingParticipant,
  respondTrainingInvitation, completeTrainingParticipant, voidTrainingOutcome, getTrainingParticipant, listTrainingCourses, listOwnTraining,
  recordTrainingFeedback, getTrainingCourse, getTrainingSession } from "./store.ts";

const spec = { features: ["hrm", "hrmCertifications"], country: "CA", users: [
  { key: "authorId", name: "Course author", handle: "training_author", permissions: ["hrm.certifications.read", "hrm.certifications.manage"], link: true, partyKey: "authorPartyId" },
  { key: "reviewerId", name: "Course reviewer", handle: "training_reviewer", permissions: ["hrm.certifications.read", "hrm.certifications.manage"], link: true },
  { key: "aliasId", name: "Author alternate login", handle: "training_alias", permissions: ["hrm.certifications.manage"], link: true },
  { key: "employeeId", name: "Training participant", handle: "training_employee", permissions: ["hrm.self.read", "hrm.self.request"], link: true, partyKey: "employeePartyId" },
  { key: "outsiderId", name: "Other employee", handle: "training_outsider", permissions: ["hrm.self.read", "hrm.self.request"], link: true },
] } as const;

async function setup() {
  return setupHarness(spec, async f => {
    await db.execute(sql`update users set party_id=${f.authorPartyId} where org_id=${f.org.orgId} and id=${f.aliasId}`);
    const worker = await seedEmployment(f.org.orgId, f.org.subsidiaryId, { workerPartyId: f.employeePartyId, from: "2026-01-01" });
    const type = await createQualificationType(db, { orgId: f.org.orgId, actorId: f.authorId, code: "SAFETY", name: "Workplace safety", category: "training", validityMonths: 12 });
    const actor = { orgId: f.org.orgId, actorId: f.authorId };
    const request = { ...actor, id: randomUUID(), subsidiaryId: f.org.subsidiaryId, code: "SAFETY", version: 1, name: "Workplace safety course", description: null,
      effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", qualificationTypeId: type.id, minimumAttendancePercent: 90, passingScore: 70, reason: "Declared safety requirements" };
    const course = await createTrainingCourse(request);
    return { ...worker, type, course, request, actor };
  });
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function delivery(f: Fixture, overrides: { capacity?: number; code?: string; start?: boolean } = {}) {
  await transitionTrainingCourse({ ...f.actor, actorId: f.reviewerId, courseId: f.course.id, expectedRevision: f.course.revision, action: "approve", reason: "Independent policy review" });
  const created = await createTrainingSession({ ...f.actor, id: randomUUID(), courseId: f.course.id, name: overrides.code ?? "January safety training", location: "Training room",
    startsAt: "2026-01-09T10:00:00Z", endsAt: "2026-01-09T11:00:00Z", timeZone: "America/Toronto", capacity: overrides.capacity ?? 10, reason: "Scheduled delivery" });
  const scheduled = await transitionTrainingSession({ ...f.actor, sessionId: created.id, expectedRevision: created.revision, action: "schedule", reason: "Published employee invitations" });
  const participant = await inviteTrainingParticipant({ ...f.actor, id: randomUUID(), sessionId: scheduled.id, employmentId: f.employmentId, reason: "Required workplace training" });
  const session = overrides.start === false ? scheduled : await transitionTrainingSession({ ...f.actor, sessionId: scheduled.id, expectedRevision: scheduled.revision, action: "start", reason: "Delivery started" });
  return { session, participant };
}
const resultInput = (f: Fixture, participantId: string, expectedRevision: number) => ({ ...f.actor, participantId, expectedRevision,
  attendanceSeconds: 3600, score: 80, evidenceFileId: null, existingQualificationId: null, notes: "Completed practical assessment", reason: "Recorded instructor result" });

test("course delivery creates pending qualification evidence once, preserves audit and revokes it atomically when voided", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const { session, participant } = await delivery(f);
    const complete = resultInput(f, participant.id, participant.revision);
    const finished = await completeTrainingParticipant(complete);
    assert.equal(finished.status, "completed"); assert.ok(finished.qualificationId);
    assert.equal(finished.qualificationCreated, true);
    const held = (await db.execute<{ status: string; expires: string }>(sql`select status,expires_on::text as expires from hrm_worker_qualifications where org_id=${f.org.orgId} and id=${finished.qualificationId}`)).rows[0]!;
    assert.equal(held.status, "pending_verification", "attendance completion cannot authorize a credential for dispatch");
    assert.equal(held.expires, "2027-01-09");
    assert.equal((await completeTrainingParticipant(complete)).id, finished.id);
    assert.equal((await db.execute(sql`select id from hrm_worker_qualifications where org_id=${f.org.orgId} and employment_id=${f.employmentId}`)).rows.length, 1);
    const audit = (await db.execute<{ changes: { before: { status: string }; after: { status: string }; reason: string }; actorId: string }>(sql`select changes,actor_id as "actorId" from audit_log
      where org_id=${f.org.orgId} and table_name='hrm_training_participants' and row_id=${participant.id} and action='update'`)).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0]!.changes.before.status, "invited"); assert.equal(audit[0]!.changes.after.status, "completed"); assert.equal(audit[0]!.actorId, f.authorId);
    await transitionTrainingSession({ ...f.actor, sessionId: session.id, expectedRevision: session.revision, action: "complete", reason: "Delivered and assessed" });
    await withOrgTransaction(f.org.orgId, () => verifyQualification(db, { ...f.actor, actorId: f.reviewerId, qualificationId: finished.qualificationId! }));
    const voided = await voidTrainingOutcome({ ...f.actor, participantId: participant.id, expectedRevision: finished.revision, reason: "Instructor corrected the attendance evidence" });
    assert.equal(voided.status, "voided"); assert.equal(voided.attendanceSeconds, 3600);
    assert.equal((await db.execute<{ status: string }>(sql`select status from hrm_worker_qualifications where org_id=${f.org.orgId} and id=${finished.qualificationId}`)).rows[0]!.status, "revoked");
    await assert.rejects(completeTrainingParticipant({ ...complete, expectedRevision: voided.revision }), /completed outcomes can only be voided/);
  });
});

test("course approval resolves person identity rather than accepting a second login for the author", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    for (const actorId of [f.authorId, f.aliasId]) await assert.rejects(transitionTrainingCourse({ ...f.actor, actorId, courseId: f.course.id, expectedRevision: f.course.revision, action: "approve", reason: "Review attempt" }), /independently identified person.*someone other than the author/);
    const approved = await transitionTrainingCourse({ ...f.actor, actorId: f.reviewerId, courseId: f.course.id, expectedRevision: f.course.revision, action: "approve", reason: "Independent review" });
    assert.equal(approved.decidedBy, f.reviewerId);
    await assert.rejects(createTrainingCourse({ ...f.request, id: randomUUID(), version: 2 }).then(row => transitionTrainingCourse({ ...f.actor, actorId: f.reviewerId, courseId: row.id, expectedRevision: row.revision, action: "approve", reason: "Review overlapping dates" })), /Approved course versions overlap.*non-overlapping effective dates/);
  });
});

test("session capacity is serialized, discarded invitations free a place, and unfinished outcomes cannot close delivery", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const { session, participant } = await delivery(f, { capacity: 1, start: false });
    const other = await seedEmployment(f.org.orgId, f.org.subsidiaryId, { from: "2026-01-01" });
    await assert.rejects(inviteTrainingParticipant({ ...f.actor, id: randomUUID(), sessionId: session.id, employmentId: other.employmentId, reason: "Second invitation" }), /session is full.*another session/);
    const declined = await respondTrainingInvitation({ ...f.actor, actorId: f.employeeId, participantId: participant.id, expectedRevision: participant.revision, action: "decline", audience: "self", reason: "Unable to attend" });
    assert.equal(declined.status, "declined");
    const third = await seedEmployment(f.org.orgId, f.org.subsidiaryId, { from: "2026-01-01" });
    const competing = await Promise.allSettled([other, third].map(worker => inviteTrainingParticipant({ ...f.actor, id: randomUUID(), sessionId: session.id, employmentId: worker.employmentId, reason: "Claim available place" })));
    const won = competing.filter((row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof inviteTrainingParticipant>>> => row.status === "fulfilled");
    const lost = competing.filter((row): row is PromiseRejectedResult => row.status === "rejected");
    assert.equal(won.length, 1, "one remaining place admits exactly one concurrent invitation"); assert.equal(lost.length, 1); assert.match(String(lost[0]!.reason), /session is full/);
    const started = await transitionTrainingSession({ ...f.actor, sessionId: session.id, expectedRevision: session.revision, action: "start", reason: "Delivery started" });
    await assert.rejects(transitionTrainingSession({ ...f.actor, sessionId: session.id, expectedRevision: started.revision, action: "complete", reason: "Premature close" }), /Participant outcomes are unfinished.*record each result/);
    await respondTrainingInvitation({ ...f.actor, participantId: won[0]!.value.id, expectedRevision: won[0]!.value.revision, action: "cancel", audience: "staff", reason: "No attendance" });
    await assert.rejects(transitionTrainingSession({ ...f.actor, sessionId: session.id, expectedRevision: started.revision, action: "complete", reason: "Empty close" }), /no completed participant results.*cancel/);
    await transitionTrainingSession({ ...f.actor, sessionId: session.id, expectedRevision: started.revision, action: "cancel", reason: "No attendees" });
  });
});

test("employee responses, feedback history and list context remain limited to the native linked employee", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const { participant } = await delivery(f);
    await assert.rejects(getTrainingParticipant({ ...f.actor, actorId: f.outsiderId, participantId: participant.id, audience: "self" }), /not found/);
    const own = await listOwnTraining({ ...f.actor, actorId: f.employeeId });
    assert.equal(own.length, 1); assert.equal(own[0]!.id, participant.id); assert.equal(own[0]!.sessionName, "January safety training");
    assert.deepEqual(await listOwnTraining({ ...f.actor, actorId: f.outsiderId }), []);
    await completeTrainingParticipant(resultInput(f, participant.id, participant.revision));
    const firstInput = { ...f.actor, actorId: f.employeeId, id: randomUUID(), participantId: participant.id, rating: 4, comments: "Clear instruction", supersedesId: null, reason: "Participant feedback", audience: "self" as const };
    const first = await recordTrainingFeedback(firstInput);
    assert.equal((await recordTrainingFeedback(firstInput)).id, first.id);
    const corrected = await recordTrainingFeedback({ ...firstInput, id: randomUUID(), rating: 5, supersedesId: first.id, reason: "Corrected rating" });
    assert.equal(corrected.supersedesId, first.id);
    const detail = await getTrainingParticipant({ ...f.actor, actorId: f.employeeId, participantId: participant.id, audience: "self" });
    assert.deepEqual(detail.feedback.map(row => row.rating), [4, 5]);
    await assert.rejects(recordTrainingFeedback({ ...firstInput, id: randomUUID(), rating: 3 }), /Feedback changed.*latest entry/);
    await assert.rejects(recordTrainingFeedback({ ...firstInput, id: randomUUID(), actorId: f.outsiderId }), /not found/);
  });
});

test("approved course expiry remains exact after the native taxonomy changes, including an explicit non-expiring policy", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    await withOrgTransaction(f.org.orgId, () => updateQualificationType(db, { ...f.actor, typeId: f.type.id, validityMonths: null }));
    const second = await createTrainingCourse({ ...f.request, id: randomUUID(), code: "PERMANENT", qualificationTypeId: f.type.id });
    const qualified = { ...f, course: second };
    const { participant } = await delivery(qualified);
    await withOrgTransaction(f.org.orgId, () => updateQualificationType(db, { ...f.actor, typeId: f.type.id, validityMonths: 24 }));
    const completed = await completeTrainingParticipant(resultInput(qualified, participant.id, participant.revision));
    assert.equal((await db.execute<{ expiresOn: string | null }>(sql`select expires_on::text as "expiresOn" from hrm_worker_qualifications where org_id=${f.org.orgId} and id=${completed.qualificationId}`)).rows[0]!.expiresOn, null);
  });
});

test("failed attendance records the failed result and creates no qualification; course sessions remain scoped to their selected parent", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const { participant } = await delivery(f);
    const failed = await completeTrainingParticipant({ ...resultInput(f, participant.id, participant.revision), attendanceSeconds: 3239 });
    assert.equal(failed.status, "failed"); assert.equal(failed.qualificationId, null);
    assert.equal((await db.execute(sql`select id from hrm_worker_qualifications where org_id=${f.org.orgId} and employment_id=${f.employmentId}`)).rows.length, 0);
    const other = await createTrainingCourse({ ...f.request, id: randomUUID(), code: "OTHER" });
    assert.deepEqual((await getTrainingCourse({ ...f.actor, courseId: other.id })).sessions, []);
    assert.equal((await getTrainingCourse({ ...f.actor, courseId: f.course.id })).sessions.length, 1);
  });
});

test("feature-off and altered retries refuse by name while preserving all existing training history", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    assert.equal((await createTrainingCourse(f.request)).id, f.course.id);
    await assert.rejects(createTrainingCourse({ ...f.request, name: "Different request" }), /different content.*existing record is preserved/);
    await setFeatures(f.org.orgId, { hrmCertifications: false });
    await assert.rejects(listTrainingCourses(f.actor), /Training delivery is disabled.*Company Settings.*Features/);
    assert.equal((await db.execute(sql`select id from hrm_training_courses where org_id=${f.org.orgId}`)).rows.length, 1);
  });
});

test("a caught participant failure rolls back newly issued qualification and audit effects without losing earlier caller work", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const { session, participant } = await delivery(f);
    assert.ok(process.env.OPENBOOKS_TEST_ADMIN_DB_URL, "the rollback proof requires the named isolated database");
    const admin = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL }); await admin.connect();
    const name = `training_refusal_${randomUUID().replaceAll("-", "")}`;
    try {
      await admin.query(`create function public.${name}() returns trigger language plpgsql as $$ begin if NEW.org_id='${f.org.orgId}'::uuid then raise exception 'Synthetic outcome write failure'; end if; return NEW; end $$`);
      await admin.query(`create trigger ${name} before update on hrm_training_participants for each row execute function public.${name}()`);
      await withOrgTransaction(f.org.orgId, async () => {
      await db.execute(sql`update parties set display_name='Earlier caller work' where org_id=${f.org.orgId} and id=${f.workerPartyId}`);
      await assert.rejects(completeTrainingParticipant(resultInput(f, participant.id, participant.revision)), error => String((error as { cause?: unknown }).cause).includes("Synthetic outcome write failure"));
      assert.equal((await db.execute(sql`select id from hrm_worker_qualifications where org_id=${f.org.orgId} and employment_id=${f.employmentId}`)).rows.length, 0);
      assert.equal((await db.execute<{ name: string }>(sql`select display_name as name from parties where org_id=${f.org.orgId} and id=${f.workerPartyId}`)).rows[0]!.name, "Earlier caller work");
      });
    } finally {
      await admin.query(`drop trigger if exists ${name} on hrm_training_participants`);
      await admin.query(`drop function if exists public.${name}()`);
      await admin.end();
    }
    assert.equal((await getTrainingSession({ ...f.actor, sessionId: session.id })).participants[0]!.status, "invited");
  });
});

test("native storage rejects result rewriting and deletion, and no legal-entity scope grants no training records", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const { participant } = await delivery(f);
    const completed = await completeTrainingParticipant(resultInput(f, participant.id, participant.revision));
    await assert.rejects(db.execute(sql`update hrm_training_participants set score=99,revision=revision+1 where org_id=${f.org.orgId} and id=${completed.id}`), error => /participant transition|results are immutable/i.test(String((error as { cause?: unknown }).cause)));
    await assert.rejects(db.execute(sql`delete from hrm_training_participants where org_id=${f.org.orgId} and id=${completed.id}`), error => /history cannot be deleted/.test(String((error as { cause?: unknown }).cause)));
    await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${f.org.orgId}`);
    assert.deepEqual(await listTrainingCourses(f.actor), []);
    await assert.rejects(getTrainingCourse({ ...f.actor, courseId: f.course.id }), /not found/);
    assert.deepEqual(await listOwnTraining({ ...f.actor, actorId: f.employeeId }), []);
  });
});
