import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "../../platform/db.ts";
import { addMonthsClamped } from "../../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { lockActorCommandAuthority } from "../../organization/actor-command-authority.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import { HrmAuthorizationError, loadOwnEmploymentIds, lockEmploymentsForScope } from "../authorization.ts";
import { recordQualification, revokeQualification } from "../qualifications/qualifications.ts";
import { HrmQualificationError } from "../qualifications/errors.ts";
import { TrainingError, requireUuid, trainingInteger, trainingPolicy, trainingRequestHash, trainingResult, trainingSessionWindow, trainingText, trainingWindow, type TrainingPolicy } from "./policy.ts";

export interface TrainingActor { readonly orgId: string; readonly actorId: string }
export type TrainingCourse = TrainingPolicy & {
  readonly id: string; readonly subsidiaryId: string; readonly code: string; readonly version: number;
  readonly name: string; readonly description: string | null; readonly effectiveFrom: string; readonly effectiveTo: string | null;
  readonly status: "draft" | "approved" | "retired" | "cancelled"; readonly revision: number;
  readonly createdBy: string; readonly authorPartyId: string; readonly decidedBy: string | null;
  readonly qualificationValidityMonths: number | null; readonly qualificationRequiresEvidence: boolean;
};
export type TrainingSession = {
  readonly id: string; readonly subsidiaryId: string; readonly courseId: string; readonly name: string; readonly location: string;
  readonly timeZone: string; readonly startsAt: string; readonly endsAt: string; readonly startsOn: string; readonly endsOn: string;
  readonly durationSeconds: number; readonly capacity: number; readonly revision: number;
  readonly status: "draft" | "scheduled" | "in_progress" | "completed" | "cancelled";
};
export type TrainingParticipant = {
  readonly id: string; readonly sessionId: string; readonly employmentId: string; readonly subsidiaryId: string;
  readonly status: "invited" | "accepted" | "declined" | "completed" | "failed" | "voided" | "cancelled";
  readonly attendanceSeconds: number | null; readonly score: number | null; readonly evidenceFileId: string | null;
  readonly notes: string | null; readonly qualificationTypeId: string | null; readonly qualificationId: string | null;
  readonly qualificationCreated: boolean; readonly completionHash: string | null; readonly revision: number;
};
export type TrainingFeedback = { readonly id: string; readonly participantId: string; readonly rating: number; readonly comments: string | null; readonly supersedesId: string | null; readonly createdAt: string; readonly createdBy: string };

const COURSE = sql`id,subsidiary_id as "subsidiaryId",code,version,name,description,effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",
 qualification_type_id as "qualificationTypeId",qualification_validity_months as "qualificationValidityMonths",qualification_requires_evidence as "qualificationRequiresEvidence",minimum_attendance_percent as "minimumAttendancePercent",passing_score as "passingScore",status,revision,
 created_by as "createdBy",author_party_id as "authorPartyId",decided_by as "decidedBy"`;
const SESSION = sql`id,subsidiary_id as "subsidiaryId",course_id as "courseId",name,location,time_zone as "timeZone",
 starts_at::text as "startsAt",ends_at::text as "endsAt",starts_on::text as "startsOn",ends_on::text as "endsOn",duration_seconds as "durationSeconds",capacity,status,revision`;
const PARTICIPANT = sql`id,session_id as "sessionId",employment_id as "employmentId",subsidiary_id as "subsidiaryId",status,
 attendance_seconds as "attendanceSeconds",score,evidence_file_id as "evidenceFileId",notes,qualification_type_id as "qualificationTypeId",qualification_id as "qualificationId",
 qualification_created as "qualificationCreated",completion_hash as "completionHash",revision`;
const FEEDBACK = sql`id,participant_id as "participantId",rating,comments,supersedes_id as "supersedesId",created_at::text as "createdAt",created_by as "createdBy"`;

function single<T>(rows: T[]): T {
  if (rows.length !== 1) throw new ScopeNotFoundError();
  return rows[0]!;
}
function actor(input: TrainingActor) { requireUuid(input.orgId, "Organization"); requireUuid(input.actorId, "Actor"); }
function revision(row: { revision: number }, expected: unknown) {
  if (!Number.isSafeInteger(expected) || row.revision !== expected) throw new TrainingError("Training revision changed — reload the record and review its current state before saving.");
}
function optionalText(value: unknown, name: string, limit: number): string | null {
  return value === null || value === undefined || value === "" ? null : trainingText(value, name, limit);
}

/** All public commands own or join one tenant transaction, including qualification issuance. */
async function transaction<T>(input: TrainingActor, fn: () => Promise<T>): Promise<T> {
  actor(input);
  try { return await withOrgTransaction(input.orgId, () => withTransactionSavepoint(db, fn)); }
  catch (error) {
    if (error instanceof HrmAuthorizationError) throw new ScopeNotFoundError();
    if (error instanceof HrmQualificationError) throw new TrainingError(error.message);
    const visited = new Set<object>();
    let item: unknown = error;
    while (item && typeof item === "object" && !visited.has(item)) {
      visited.add(item);
      const cause = item as { code?: string; constraint?: string; message?: string; where?: string; cause?: unknown };
      if (cause.code === "42P01" && /hrm_training_/.test(cause.message ?? "")) throw new TrainingError("Training delivery requires the database upgrade — ask an administrator to complete the training migration before using this workspace.");
      if (cause.code === "P0001" && /PL\/pgSQL function (?:public\.)?hrm_training_guard\(\)/.test(cause.where ?? "") && cause.message) throw new TrainingError(cause.message);
      if (cause.constraint?.startsWith("hrm_training_")) {
        if (cause.code === "23505") throw new TrainingError("This course version, participant invitation or feedback predecessor already exists — reload its native register and open the existing record.");
        if (cause.code === "23P01") throw new TrainingError("Approved course versions overlap — retire the replaced version or choose non-overlapping effective dates before approval.");
        if (cause.code === "23503") throw new TrainingError("A training reference is unavailable — reload and select a current native employer, employment, course or qualification.");
        if (cause.code === "23514") throw new TrainingError("Training data violates its lifecycle or evidence rules — reload the record and review the required dates, attendance and assessment.");
      }
      if (cause.code === "40001" || cause.code === "40P01") throw new TrainingError("Training changed during this operation — reload and retry; no part of this operation was saved.");
      item = cause.cause;
    }
    throw error;
  }
}

async function begin(input: TrainingActor, permission: "hrm.certifications.read" | "hrm.certifications.manage" | "hrm.self.read" | "hrm.self.request", subsidiaryId: string | null = null) {
  const scope = await lockActorCommandAuthority(db, input.orgId, input.actorId, subsidiaryId, permission);
  if (!await lockAndCheckOrgFeature(db, input.orgId, "hrm") || !await lockAndCheckOrgFeature(db, input.orgId, "hrmTraining")) {
    throw new TrainingError("Training delivery is disabled — enable HRM and Training delivery on Company Settings → Features; existing training history is preserved.");
  }
  return scope;
}
async function course(input: TrainingActor, id: string, write: boolean): Promise<TrainingCourse> {
  const scope = await begin(input, write ? "hrm.certifications.manage" : "hrm.certifications.read");
  const row = single((await db.execute<TrainingCourse>(sql`select ${COURSE} from hrm_training_courses
    where org_id=${input.orgId} and id=${requireUuid(id, "Course")} ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)} ${write ? sql`for update` : sql`for share`}`)).rows);
  await lockActorCommandAuthority(db, input.orgId, input.actorId, row.subsidiaryId, write ? "hrm.certifications.manage" : "hrm.certifications.read");
  return row;
}
async function session(input: TrainingActor, id: string, write: boolean, self = false): Promise<TrainingSession> {
  const permission = self ? write ? "hrm.self.request" : "hrm.self.read" : write ? "hrm.certifications.manage" : "hrm.certifications.read";
  const scope = await begin(input, permission);
  const row = single((await db.execute<TrainingSession>(sql`select ${SESSION} from hrm_training_sessions
    where org_id=${input.orgId} and id=${requireUuid(id, "Session")} ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)} ${write ? sql`for update` : sql`for share`}`)).rows);
  await lockActorCommandAuthority(db, input.orgId, input.actorId, row.subsidiaryId, permission);
  return row;
}
async function participant(input: TrainingActor, id: string, write: boolean, self = false) {
  await begin(input, self ? write ? "hrm.self.request" : "hrm.self.read" : write ? "hrm.certifications.manage" : "hrm.certifications.read");
  const identity = single((await db.execute<{ sessionId: string; employmentId: string }>(sql`select session_id as "sessionId",employment_id as "employmentId"
    from hrm_training_participants where org_id=${input.orgId} and id=${requireUuid(id, "Participant")}`)).rows);
  if (self && !(await loadOwnEmploymentIds(db, input.orgId, input.actorId)).includes(identity.employmentId)) throw new ScopeNotFoundError();
  const delivery = await session(input, identity.sessionId, write, self);
  await lockEmploymentsForScope(db, [identity.employmentId], input);
  const row = single((await db.execute<TrainingParticipant>(sql`select ${PARTICIPANT} from hrm_training_participants
    where org_id=${input.orgId} and id=${id} and session_id=${delivery.id} ${write ? sql`for update` : sql`for share`}`)).rows);
  return { row, delivery };
}

/** Creation retries use the same caller-held UUID, never a second row. */
async function creationReplay<T>(input: TrainingActor, table: "hrm_training_courses" | "hrm_training_sessions" | "hrm_training_participants" | "hrm_training_feedback", id: string, hash: string, columns: typeof COURSE): Promise<T | null> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`training-create:${input.orgId}:${id}`},0))`);
  const rows = (await db.execute<T & { requestHash: string; createdBy: string }>(sql`select ${columns},request_hash as "requestHash",created_by as "createdBy"
    from ${sql.identifier(table)} where org_id=${input.orgId} and id=${id}`)).rows;
  if (!rows.length) return null;
  const stored = single(rows);
  if (stored.requestHash !== hash || stored.createdBy !== input.actorId) throw new TrainingError("This training request key already has different content — reopen the creation form to start a new request; the existing record is preserved.");
  const { requestHash: _hash, createdBy: _actor, ...result } = stored;
  // Course and feedback reads include the creator as part of their public evidence.
  return { ...result, ...(table === "hrm_training_courses" || table === "hrm_training_feedback" ? { createdBy: stored.createdBy } : {}) } as T;
}

export async function listTrainingCourses(input: TrainingActor): Promise<TrainingCourse[]> {
  return transaction(input, async () => {
    const scope = await begin(input, "hrm.certifications.read");
    return (await db.execute<TrainingCourse>(sql`select ${COURSE} from hrm_training_courses where org_id=${input.orgId}
      ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)} order by code,version desc,id`)).rows;
  });
}
export async function createTrainingCourse(input: TrainingActor & TrainingPolicy & {
  id: string; subsidiaryId: string; code: string; version: number; name: string; description: string | null;
  effectiveFrom: string; effectiveTo: string | null; reason: string;
}): Promise<TrainingCourse> {
  const id = requireUuid(input.id, "Request key"), subsidiaryId = requireUuid(input.subsidiaryId, "Employer");
  const definition = { subsidiaryId, code: trainingText(input.code, "Course code", 64), version: trainingInteger(input.version, "Course version", 2147483647),
    name: trainingText(input.name, "Course name", 160), description: optionalText(input.description, "Description", 2000),
    ...trainingWindow(input.effectiveFrom, input.effectiveTo), ...trainingPolicy(input), reason: trainingText(input.reason, "Reason") };
  if (definition.version === 0) throw new TrainingError("Course version starts at 1 — choose a positive version number.");
  return transaction(input, async () => {
    await begin(input, "hrm.certifications.manage", subsidiaryId);
    if (!(await db.execute(sql`select id from subsidiaries where org_id=${input.orgId} and id=${subsidiaryId} and is_active for share`)).rows.length) throw new ScopeNotFoundError();
    const identity = single((await db.execute<{ partyId: string | null }>(sql`select party_id as "partyId" from users where org_id=${input.orgId} and id=${input.actorId} for share`)).rows);
    if (!identity.partyId) throw new TrainingError("Course authorship needs a native person identity — link your user to its person record before creating a course.");
    const hash = trainingRequestHash(definition), replay = await creationReplay<TrainingCourse>(input, "hrm_training_courses", id, hash, COURSE);
    if (replay) return replay;
    if (definition.qualificationTypeId && !await lockAndCheckOrgFeature(db, input.orgId, "hrmCertifications")) throw new TrainingError("Qualification outcomes are disabled — enable Certifications and licenses on Company Settings → Features, or create a course without a qualification outcome.");
    const qualification = definition.qualificationTypeId ? (await db.execute<{ validityMonths: number | null; requiresEvidence: boolean }>(sql`select validity_months as "validityMonths",requires_evidence as "requiresEvidence"
      from hrm_qualification_types where org_id=${input.orgId} and id=${definition.qualificationTypeId} and is_active for share`)).rows[0] : null;
    if (definition.qualificationTypeId && !qualification) {
      throw new TrainingError("The qualification type is unavailable — declare or reactivate its native qualification type before authoring the course.");
    }
    return single((await db.execute<TrainingCourse>(sql`insert into hrm_training_courses
      (id,org_id,subsidiary_id,code,version,name,description,effective_from,effective_to,qualification_type_id,qualification_validity_months,qualification_requires_evidence,minimum_attendance_percent,passing_score,author_party_id,request_hash,reason,created_by,updated_by)
      values(${id},${input.orgId},${subsidiaryId},${definition.code},${definition.version},${definition.name},${definition.description},${definition.effectiveFrom},${definition.effectiveTo},
        ${definition.qualificationTypeId},${qualification?.validityMonths ?? null},${qualification?.requiresEvidence ?? false},${definition.minimumAttendancePercent},${definition.passingScore},${identity.partyId},${hash},${definition.reason},${input.actorId},${input.actorId}) returning ${COURSE}`)).rows);
  });
}
export async function transitionTrainingCourse(input: TrainingActor & { courseId: string; expectedRevision: number; action: "approve" | "retire" | "cancel"; reason: string }): Promise<TrainingCourse> {
  const reason = trainingText(input.reason, "Reason");
  return transaction(input, async () => {
    const row = await course(input, input.courseId, true);
    const status = input.action === "approve" ? "approved" : input.action === "retire" ? "retired" : input.action === "cancel" ? "cancelled" : null;
    if (!status) throw new TrainingError("Choose approve, retire or cancel for the course.");
    if (row.revision === input.expectedRevision + 1 && row.status === status && (await db.execute(sql`select id from hrm_training_courses where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    revision(row, input.expectedRevision);
    if (row.status !== (input.action === "retire" ? "approved" : "draft")) throw new TrainingError("This course cannot make that transition — reload and use an action available for its current state.");
    if (status === "approved") {
      const identities = (await db.execute<{ id: string; partyId: string | null; active: boolean }>(sql`select id,party_id as "partyId",is_active as active
        from users where org_id=${input.orgId} and id in (${input.actorId},${row.createdBy}) order by id for share`)).rows;
      const author = identities.find(r => r.id === row.createdBy), reviewer = identities.find(r => r.id === input.actorId);
      if (!author?.partyId || !reviewer?.active || !reviewer.partyId || reviewer.id === row.createdBy || reviewer.partyId === author.partyId || reviewer.partyId === row.authorPartyId) {
        throw new TrainingError("Course approval needs an independently identified person — link the approver to their person record and choose someone other than the author.");
      }
    }
    return single((await db.execute<TrainingCourse>(sql`update hrm_training_courses set status=${status},revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now(),
      decided_by=case when ${status === "approved"} then ${input.actorId}::uuid else decided_by end,decided_at=case when ${status === "approved"} then now() else decided_at end
      where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${COURSE}`)).rows);
  });
}

export async function listTrainingSessions(input: TrainingActor & { courseId?: string }): Promise<TrainingSession[]> {
  return transaction(input, async () => {
    const scope = await begin(input, "hrm.certifications.read");
    if (input.courseId) await course(input, input.courseId, false);
    return (await db.execute<TrainingSession>(sql`select ${SESSION} from hrm_training_sessions where org_id=${input.orgId}
      ${input.courseId ? sql`and course_id=${input.courseId}` : sql``} ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)} order by starts_at desc,id`)).rows;
  });
}
export async function createTrainingSession(input: TrainingActor & { id: string; courseId: string; name: string; location: string; startsAt: string; endsAt: string; timeZone: string; capacity: number; reason: string }): Promise<TrainingSession> {
  const id = requireUuid(input.id, "Request key"), courseId = requireUuid(input.courseId, "Course");
  const definition = { courseId, name: trainingText(input.name, "Session name", 160), location: trainingText(input.location, "Location", 500),
    ...trainingSessionWindow(input.startsAt, input.endsAt, input.timeZone), capacity: trainingInteger(input.capacity, "Capacity", 10000), reason: trainingText(input.reason, "Reason") };
  if (definition.capacity === 0) throw new TrainingError("Session capacity starts at 1 — choose a positive participant capacity.");
  return transaction(input, async () => {
    const policy = await course(input, courseId, true);
    const hash = trainingRequestHash(definition), replay = await creationReplay<TrainingSession>(input, "hrm_training_sessions", id, hash, SESSION);
    if (replay) return replay;
    if (policy.status !== "approved" || definition.startsOn < policy.effectiveFrom || (policy.effectiveTo !== null && definition.endsOn > policy.effectiveTo)) {
      throw new TrainingError("Choose an approved course version covering every session date — create and approve a successor version when its policy window has ended.");
    }
    return single((await db.execute<TrainingSession>(sql`insert into hrm_training_sessions
      (id,org_id,subsidiary_id,course_id,name,location,time_zone,starts_at,ends_at,starts_on,ends_on,duration_seconds,capacity,request_hash,reason,created_by,updated_by)
      values(${id},${input.orgId},${policy.subsidiaryId},${policy.id},${definition.name},${definition.location},${definition.timeZone},${definition.startsAt},${definition.endsAt},
        ${definition.startsOn},${definition.endsOn},${definition.durationSeconds},${definition.capacity},${hash},${definition.reason},${input.actorId},${input.actorId}) returning ${SESSION}`)).rows);
  });
}
export async function transitionTrainingSession(input: TrainingActor & { sessionId: string; expectedRevision: number; action: "schedule" | "start" | "complete" | "cancel"; reason: string }): Promise<TrainingSession> {
  const reason = trainingText(input.reason, "Reason");
  return transaction(input, async () => {
    const row = await session(input, input.sessionId, true);
    const status = input.action === "schedule" ? "scheduled" : input.action === "start" ? "in_progress" : input.action === "complete" ? "completed" : input.action === "cancel" ? "cancelled" : null;
    if (!status) throw new TrainingError("Choose schedule, start, complete or cancel for the session.");
    if (row.revision === input.expectedRevision + 1 && row.status === status && (await db.execute(sql`select id from hrm_training_sessions where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    revision(row, input.expectedRevision);
    return single((await db.execute<TrainingSession>(sql`update hrm_training_sessions set status=${status},revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now()
      where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${SESSION}`)).rows);
  });
}

export async function inviteTrainingParticipant(input: TrainingActor & { id: string; sessionId: string; employmentId: string; reason: string }): Promise<TrainingParticipant> {
  const id = requireUuid(input.id, "Request key"), employmentId = requireUuid(input.employmentId, "Employment");
  const reason = trainingText(input.reason, "Reason");
  return transaction(input, async () => {
    const delivery = await session(input, input.sessionId, true);
    const subject = single(await lockEmploymentsForScope(db, [employmentId], input));
    if (subject.employerSubsidiaryId !== delivery.subsidiaryId) throw new TrainingError("Participant employment belongs to a different employer — choose an employment for the session employer.");
    const hash = trainingRequestHash({ sessionId: delivery.id, employmentId, reason }), replay = await creationReplay<TrainingParticipant>(input, "hrm_training_participants", id, hash, PARTICIPANT);
    if (replay) return replay;
    const declared = single((await db.execute<TrainingCourse>(sql`select ${COURSE}
      from hrm_training_courses where org_id=${input.orgId} and id=${delivery.courseId} for share`)).rows);
    return single((await db.execute<TrainingParticipant>(sql`insert into hrm_training_participants
      (id,org_id,session_id,employment_id,subsidiary_id,qualification_type_id,request_hash,reason,created_by,updated_by)
      values(${id},${input.orgId},${delivery.id},${employmentId},${delivery.subsidiaryId},${declared.qualificationTypeId},${hash},${reason},${input.actorId},${input.actorId}) returning ${PARTICIPANT}`)).rows);
  });
}
export async function respondTrainingInvitation(input: TrainingActor & { participantId: string; expectedRevision: number; action: "accept" | "decline" | "cancel"; reason: string; audience: "staff" | "self" }): Promise<TrainingParticipant> {
  const reason = trainingText(input.reason, "Reason");
  if (input.audience !== "staff" && input.audience !== "self") throw new TrainingError("Choose the employee or HR invitation workflow.");
  if (input.audience === "self" && input.action === "cancel") throw new TrainingError("Use decline to release your invitation — session invitation cancellation belongs to HR.");
  return transaction(input, async () => {
    const { row, delivery } = await participant(input, input.participantId, true, input.audience === "self");
    const status = input.action === "accept" ? "accepted" : input.action === "decline" ? "declined" : input.action === "cancel" ? "cancelled" : null;
    if (!status) throw new TrainingError("Choose accept, decline or cancel for the invitation.");
    if (row.revision === input.expectedRevision + 1 && row.status === status && (await db.execute(sql`select id from hrm_training_participants where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    revision(row, input.expectedRevision);
    if (!['scheduled', 'in_progress'].includes(delivery.status)) throw new TrainingError("The session is no longer open for invitation responses — contact HR about its current status.");
    return single((await db.execute<TrainingParticipant>(sql`update hrm_training_participants set status=${status},revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now()
      where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${PARTICIPANT}`)).rows);
  });
}

export async function completeTrainingParticipant(input: TrainingActor & { participantId: string; expectedRevision: number; attendanceSeconds: number; score: number | null; evidenceFileId: string | null; existingQualificationId: string | null; notes: string | null; reason: string }): Promise<TrainingParticipant> {
  const reason = trainingText(input.reason, "Reason"), notes = optionalText(input.notes, "Result notes", 5000);
  const evidence = input.evidenceFileId === null ? null : requireUuid(input.evidenceFileId, "Evidence file");
  const existing = input.existingQualificationId === null ? null : requireUuid(input.existingQualificationId, "Existing qualification");
  return transaction(input, async () => {
    const { row, delivery } = await participant(input, input.participantId, true);
    const declared = single((await db.execute<TrainingCourse>(sql`select ${COURSE}
      from hrm_training_courses where org_id=${input.orgId} and id=${delivery.courseId} for share`)).rows);
    const result = trainingResult(declared, delivery.durationSeconds, input.attendanceSeconds, input.score);
    const hash = trainingRequestHash({ ...result, evidence, existing, notes, reason });
    if (row.completionHash === hash && row.status === (result.passed ? "completed" : "failed")) return row;
    revision(row, input.expectedRevision);
    if (!['invited', 'accepted'].includes(row.status) || delivery.status !== "in_progress") throw new TrainingError("Record results for an invited or accepted participant in a started session — completed outcomes can only be voided with a reason.");
    if (evidence && !(await db.execute(sql`select id from files where org_id=${input.orgId} and id=${evidence} for share`)).rows.length) throw new TrainingError("Evidence is not in this organization — upload the certificate to the native File Cabinet before attaching it.");
    let qualificationId: string | null = null;
    let qualificationCreated = false;
    if (existing && (!result.passed || !declared.qualificationTypeId)) throw new TrainingError("Only a passing qualification-producing course may link a qualification — remove the unrelated qualification reference.");
    if (result.passed && declared.qualificationTypeId) {
      if (existing) {
        const held = (await db.execute<{ id: string; status: string; evidenceFileId: string | null }>(sql`select id,status,evidence_file_id as "evidenceFileId" from hrm_worker_qualifications
          where org_id=${input.orgId} and id=${existing} and employment_id=${row.employmentId} and type_id=${declared.qualificationTypeId} and issued_on=${delivery.endsOn}::date for share`)).rows[0];
        if (!held || held.status === "revoked") throw new TrainingError("The existing qualification does not match this employment, course type and completion date — select its matching non-revoked ledger record or leave the link empty to create one.");
        if (declared.qualificationRequiresEvidence && !held.evidenceFileId) throw new TrainingError("The approved course requires qualification evidence — attach its certificate to the existing qualification before linking it.");
        qualificationId = held.id;
      } else {
        if (declared.qualificationRequiresEvidence && !evidence) throw new TrainingError("The approved course requires qualification evidence — attach its certificate before completing the participant.");
        const qualification = await recordQualification(db, { orgId: input.orgId, actorId: input.actorId, employmentId: row.employmentId,
          typeId: declared.qualificationTypeId, issuedOn: delivery.endsOn, expiresOn: declared.qualificationValidityMonths === null ? null : addMonthsClamped(delivery.endsOn, declared.qualificationValidityMonths),
          expiryPolicy: "explicit", evidenceFileId: evidence, notes: notes ?? `Training session ${delivery.name}.` });
        qualificationId = qualification.id;
        qualificationCreated = true;
      }
    }
    return single((await db.execute<TrainingParticipant>(sql`update hrm_training_participants set status=${result.passed ? "completed" : "failed"},
      attendance_seconds=${result.attendanceSeconds},score=${result.score},evidence_file_id=${evidence},notes=${notes},qualification_id=${qualificationId},qualification_created=${qualificationCreated},
      completion_hash=${hash},revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now()
      where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${PARTICIPANT}`)).rows);
  });
}
export async function voidTrainingOutcome(input: TrainingActor & { participantId: string; expectedRevision: number; reason: string }): Promise<TrainingParticipant> {
  const reason = trainingText(input.reason, "Correction reason");
  return transaction(input, async () => {
    const { row } = await participant(input, input.participantId, true);
    if (row.status === "voided" && row.revision === input.expectedRevision + 1 && (await db.execute(sql`select id from hrm_training_participants where org_id=${input.orgId} and id=${row.id} and updated_by=${input.actorId} and reason=${reason}`)).rows.length) return row;
    revision(row, input.expectedRevision);
    if (!['completed', 'failed'].includes(row.status)) throw new TrainingError("Only a completed result can be voided — cancel an unused invitation instead.");
    if (row.qualificationCreated && row.qualificationId) {
      const qualification = single((await db.execute<{ status: string }>(sql`select status from hrm_worker_qualifications where org_id=${input.orgId} and id=${row.qualificationId} for update`)).rows);
      if (qualification.status !== "revoked") await revokeQualification(db, { orgId: input.orgId, actorId: input.actorId, qualificationId: row.qualificationId, reason });
    }
    return single((await db.execute<TrainingParticipant>(sql`update hrm_training_participants set status='voided',revision=revision+1,reason=${reason},updated_by=${input.actorId},updated_at=now()
      where org_id=${input.orgId} and id=${row.id} and revision=${input.expectedRevision} returning ${PARTICIPANT}`)).rows);
  });
}

export async function recordTrainingFeedback(input: TrainingActor & { id: string; participantId: string; rating: number; comments: string | null; supersedesId: string | null; reason: string; audience: "staff" | "self" }): Promise<TrainingFeedback> {
  const id = requireUuid(input.id, "Request key"), rating = trainingInteger(input.rating, "Rating", 5);
  if (rating === 0) throw new TrainingError("Feedback rating starts at 1 — choose 1 through 5.");
  if (input.audience !== "staff" && input.audience !== "self") throw new TrainingError("Choose the employee or HR feedback workflow.");
  const comments = optionalText(input.comments, "Feedback comments", 5000), reason = trainingText(input.reason, "Reason");
  const supersedes = input.supersedesId === null ? null : requireUuid(input.supersedesId, "Previous feedback");
  return transaction(input, async () => {
    const { row } = await participant(input, input.participantId, true, input.audience === "self");
    const hash = trainingRequestHash({ participantId: row.id, rating, comments, supersedes, reason }), replay = await creationReplay<TrainingFeedback>(input, "hrm_training_feedback", id, hash, FEEDBACK);
    if (replay) return replay;
    const latest = (await db.execute<{ id: string }>(sql`select f.id from hrm_training_feedback f where f.org_id=${input.orgId} and f.participant_id=${row.id}
      and not exists(select 1 from hrm_training_feedback successor where successor.org_id=f.org_id and successor.supersedes_id=f.id) for share`)).rows[0];
    if ((latest?.id ?? null) !== supersedes) throw new TrainingError("Feedback changed — reload the latest entry and select it as the predecessor when recording a correction.");
    return single((await db.execute<TrainingFeedback>(sql`insert into hrm_training_feedback(id,org_id,participant_id,rating,comments,supersedes_id,request_hash,reason,created_by)
      values(${id},${input.orgId},${row.id},${rating},${comments},${supersedes},${hash},${reason},${input.actorId}) returning ${FEEDBACK}`)).rows);
  });
}

export async function getTrainingCourse(input: TrainingActor & { courseId: string }) {
  return transaction(input, async () => ({ course: await course(input, input.courseId, false), sessions: await listTrainingSessions(input) }));
}
export async function getTrainingSession(input: TrainingActor & { sessionId: string }) {
  return transaction(input, async () => {
    const delivery = await session(input, input.sessionId, false);
    const scope = await begin(input, "hrm.certifications.read");
    // The parent share lock prevents invitation/result changes while this
    // single scoped statement reads its participant context.
    const participants = (await db.execute<TrainingParticipant>(sql`select ${PARTICIPANT} from
      (select p.* from hrm_training_participants p join worker_employments e on e.org_id=p.org_id and e.id=p.employment_id
       where p.org_id=${input.orgId} and p.session_id=${delivery.id} ${subsidiaryVisibleFilter(sql`e.employer_subsidiary_id`, scope)}) visible
      order by created_at,id`)).rows;
    return { session: delivery, participants };
  });
}
export async function getTrainingParticipant(input: TrainingActor & { participantId: string; audience: "staff" | "self" }) {
  if (input.audience !== "staff" && input.audience !== "self") throw new TrainingError("Choose the employee or HR participant workflow.");
  return transaction(input, async () => {
    const { row, delivery } = await participant(input, input.participantId, false, input.audience === "self");
    const feedback = (await db.execute<TrainingFeedback>(sql`select ${FEEDBACK} from hrm_training_feedback where org_id=${input.orgId} and participant_id=${row.id} order by created_at,id`)).rows;
    return { participant: row, session: delivery, feedback };
  });
}
export async function listOwnTraining(input: TrainingActor): Promise<(TrainingParticipant & { sessionName: string; startsAt: string; endsAt: string; location: string; timeZone: string })[]> {
  return transaction(input, async () => {
    const scope = await begin(input, "hrm.self.read"), employments = await loadOwnEmploymentIds(db, input.orgId, input.actorId);
    if (!employments.length) return [];
    return (await db.execute<TrainingParticipant & { sessionName: string; startsAt: string; endsAt: string; location: string; timeZone: string }>(sql`select ${PARTICIPANT},
      session_name as "sessionName",starts_at::text as "startsAt",ends_at::text as "endsAt",location,time_zone as "timeZone" from
      (select p.*,s.name as session_name,s.starts_at,s.ends_at,s.location,s.time_zone from hrm_training_participants p
       join worker_employments e on e.org_id=p.org_id and e.id=p.employment_id
       join hrm_training_sessions s on s.org_id=p.org_id and s.id=p.session_id
       where p.org_id=${input.orgId} and p.employment_id in (${sql.join(employments.map(id => sql`${id}`),sql`, `)})
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope)} ${subsidiaryVisibleFilter(sql`e.employer_subsidiary_id`, scope)}) visible
      order by starts_at desc,id`)).rows;
  });
}
