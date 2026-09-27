import assert from "node:assert/strict";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { createScratchUser } from "../../testing/fixtures.ts";
import { linkPerson, mkEmployment, mkParty, mkReporting, mkReviewTemplate, scopeRole, type ReviewTemplateSeed } from "../../testing/hrm-harness.ts";
import { countRows, refusal, scopeMatrix, scopeRow, type ScopeWorld } from "../../testing/hrm-scope-matrix.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { createPosition } from "../positions.ts";
import { HrmPerformanceError } from "./errors.ts";
import { closeCycle, createCycle, moveToCalibrating, openCycle } from "./review-cycles.ts";
import { acknowledgeReview, calibrateReview, reopenReview, shareReview, submitReview } from "./reviews.ts";
import {
  addCompetencyLevel, competencyProfileForEmployment, createCompetency, createFramework,
  getFramework, listFrameworks, setFrameworkActive, setSectionCompetency,
} from "./competencies.ts";
import { createGoal } from "./goals.ts";
import { fulfillRequest, listFeedback, listOpenRequestsForParty, retractFeedback, writeFeedback } from "./feedback.ts";
import { getCycleDetail, getRetentionOverview, getReviewDetail, getTurnover, listCycleProgress, listMyReviews } from "./performance-read.ts";
import { getExitRecord, listExitRecords, recordExit, updateExitRecord } from "./exits.ts";
import {
  cancelOneOnOne, getOneOnOne, holdOneOnOne, listOneOnOneDirectory, listOneOnOnes, scheduleOneOnOne, skipOneOnOne,
} from "./one-on-ones.ts";
import {
  addSuccessionCandidate, createSuccessionPlan, listSuccessionPlans, listTalentDirectory, listTalentReviews,
  recordTalentReview, removeSuccessionCandidate, resolveTalentScales, setSuccessionPlanNotes, setSuccessionPlanStatus,
} from "./talent.ts";
import { closeCalibrationSession, createCalibrationSession, openCalibrationSession, revertEntry, setCalibratedRating } from "./calibration.ts";

/**
 * Performance under a legal-entity lens: reviews, cycles, feedback, exits,
 * competencies, 1:1s, talent and calibration. A scoped HR actor acts only on
 * people employed by the entities their role covers, and a cross-entity
 * attempt refuses. Where a row checks storage it proves the refusal stored
 * nothing, and where the surface has an in-lens form it proves that succeeds.
 */

const PERF = ["hrm.performance.read", "hrm.performance.manage", "hrm.retention.read", "hrm.self.read", "hrm.employment.read"];
const PERF_FEATURES = ["hrmPerformance"];
const MANAGE = ["hrm.performance.manage"];
const HR = { hrFull: { scope: "all", link: true }, hrA: { scope: "A", link: true }, hrB: { scope: "B", link: true } } as const;
const SCOPE_DENIED = /not visible in this organization and legal-entity scope/;

type World = ScopeWorld<"hrFull">;
type AppliesTo = { employer_subsidiary_id: string | null; department_id: string | null };
const entity = (subsidiaryId: string): AppliesTo => ({ employer_subsidiary_id: subsidiaryId, department_id: null });

async function refused(promise: Promise<unknown>, code: string, message?: RegExp): Promise<HrmPerformanceError> {
  const error = await refusal(promise, HrmPerformanceError, message);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}

const denied = (promise: Promise<unknown>) => refusal(promise, HrmAuthorizationError, SCOPE_DENIED);

type Side = { userId: string; partyId: string; employmentId: string; managerUserId: string; managerPartyId: string; managerEmploymentId: string };

/** A worker and their line manager, both linked users employed by one legal entity. */
async function side(orgId: string, label: string, subsidiaryId: string): Promise<Side> {
  const person = async (role: string) => {
    const userId = await createScratchUser(orgId, `${role} ${label}`, `${role.toLowerCase()}_${label}`);
    const partyId = await linkPerson(orgId, userId);
    return { userId, partyId, employmentId: await mkEmployment(orgId, partyId, subsidiaryId, { from: "2020-01-01" }) };
  };
  const worker = await person("Worker");
  const manager = await person("Manager");
  await mkReporting(orgId, worker.employmentId, manager.employmentId);
  return { ...worker, managerUserId: manager.userId, managerPartyId: manager.partyId, managerEmploymentId: manager.employmentId };
}

const sides = async (w: World) => ({ a: await side(w.orgId, "a", w.subA), b: await side(w.orgId, "b", w.subB) });

function cycle(w: World, templateId: string, name: string, appliesTo?: AppliesTo, actorId = w.hrFull) {
  return createCycle({ orgId: w.orgId, actorId, templateId, name, periodStartOn: "2026-01-01", periodEndOn: "2026-06-30", appliesTo });
}

async function openedCycle(w: World, templateId: string, name: string, appliesTo?: AppliesTo): Promise<string> {
  const draft = await cycle(w, templateId, name, appliesTo);
  await openCycle({ orgId: w.orgId, actorId: w.hrFull, cycleId: draft.id });
  return draft.id;
}

/** The line manager submits the worker's manager review with an overall 3. */
async function submitManagerReview(orgId: string, cycleId: string, subject: Side): Promise<string> {
  const reviewId = (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${orgId} and cycle_id = ${cycleId} and employment_id = ${subject.employmentId} and kind = 'manager'`)).rows[0]!.id;
  const answerId = (await db.execute<{ id: string }>(sql`
    select id from hrm_review_answers where org_id = ${orgId} and review_id = ${reviewId} order by position limit 1`)).rows[0]!.id;
  const submitted = await submitReview({
    orgId, actorId: subject.managerUserId, reviewId, answers: [{ answerId, rating: "3", text: "meets expectations" }], overallRating: "3",
  });
  assert.equal(submitted.status, "submitted");
  return reviewId;
}

async function statusOf(table: "hrm_reviews" | "hrm_review_cycles" | "hrm_calibration_sessions", orgId: string, id: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`select status from ${sql.identifier(table)} where org_id = ${orgId} and id = ${id}`)).rows[0]!.status;
}

/** Both sides plus an open A-scoped cycle holding A's submitted manager review. */
async function reviewWorld(w: World, template: ReviewTemplateSeed = { name: "Annual", scaleLabels: [] }) {
  const people = await sides(w);
  const cycleId = await openedCycle(w, await mkReviewTemplate(w.orgId, w.hrFull, template), "FY26 A-scope", entity(w.subA));
  return { ...people, cycleId, reviewId: await submitManagerReview(w.orgId, cycleId, people.a) };
}

/**
 * Start each write while a transaction holds `lock`, pausing between them,
 * run `whileHeld` inside the still-open transaction, and return every outcome
 * (value or refusal) once the lock is released. Asserts none settled early.
 */
async function whileLocked(lock: SQL, writes: Array<() => Promise<unknown>>, whileHeld?: SQL): Promise<unknown[]> {
  let settled = 0;
  let waited = false;
  const outcomes: Promise<unknown>[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(lock);
    for (const write of writes) {
      outcomes.push(write().then((value) => value, (error: unknown) => error).finally(() => { settled += 1; }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    waited = settled === 0;
    if (whileHeld) await tx.execute(whileHeld);
  });
  assert.equal(waited, true, "every write waits behind the held lock");
  return Promise.all(outcomes);
}

const fulfilments = (orgId: string, requestId: string) =>
  sql`from hrm_feedback where org_id = ${orgId} and kind = 'feedback' and context->>'fulfills_request_id' = ${requestId}`;

/** A leaver: an employment whose first version is already terminated, since versions are append-only. */
async function leaver(orgId: string, name: string, subsidiaryId: string): Promise<string> {
  return mkEmployment(orgId, await mkParty(orgId, name), subsidiaryId, { from: "2026-01-01", status: "terminated" });
}

/** An employment change at the employment's next revision. */
async function mkChange(orgId: string, employmentId: string, kind: string, actorId: string): Promise<string> {
  const revision = await countRows(sql`from employment_changes where org_id = ${orgId} and employment_id = ${employmentId}`) + 1;
  return (await db.execute<{ id: string }>(sql`
    insert into employment_changes (org_id, employment_id, revision, change_kind, prior_snapshot, reason, recorded_by)
    values (${orgId}, ${employmentId}, ${revision}, ${kind}, '{}'::jsonb, 'test change', ${actorId}) returning id`)).rows[0]!.id;
}

const department = async (orgId: string, name: string, subsidiaryId: string) => (await db.execute<{ id: string }>(sql`
  insert into departments (org_id, name, subsidiary_id) values (${orgId}, ${name}, ${subsidiaryId}) returning id`)).rows[0]!.id;

async function oneOnOnes(w: World) {
  const people = await sides(w);
  const schedule = (s: Side, scheduledAt: string) => scheduleOneOnOne({
    orgId: w.orgId, actorId: w.hrFull, managerEmploymentId: s.managerEmploymentId, reportEmploymentId: s.employmentId, scheduledAt,
  });
  const oneA = (await schedule(people.a, "2026-03-01T10:00:00Z")).id;
  return { ...people, oneA, oneB: (await schedule(people.b, "2026-03-01T11:00:00Z")).id };
}

const ONE_ON_ONE = { features: PERF_FEATURES, permissions: ["hrm.performance.read", "hrm.performance.manage", "hrm.self.read"], actors: HR };

/** Talent world: an A and a B employment, an org-wide cycle, and an HR whose role covers no entity. */
async function talentWorld(w: World) {
  const hrEmpty = await createScratchUser(w.orgId, "Talent HR Empty", "talent_hr_empty");
  await scopeRole(w.orgId, "talent_hr_empty", MANAGE, []);
  const empA = await mkEmployment(w.orgId, await mkParty(w.orgId, "Employee A"), w.subA);
  const empB = await mkEmployment(w.orgId, await mkParty(w.orgId, "Employee B"), w.subB);
  const templateId = await mkReviewTemplate(w.orgId, w.hrFull);
  return { hrEmpty, empA, empB, templateId, cycleId: (await cycle(w, templateId, "Talent cycle")).id };
}

const TALENT = {
  features: PERF_FEATURES,
  permissions: MANAGE,
  actors: { hrFull: { scope: "all", permissions: [...MANAGE, "hrm.position.manage"] }, hrA: { scope: "A" } },
} as const;

/** Calibration world: both sides in an open org-wide cycle, with the named sides' manager reviews submitted. */
async function calibrationWorld(w: World, submit: ReadonlyArray<"a" | "b">) {
  const people = await sides(w);
  const templateId = await mkReviewTemplate(w.orgId, w.hrFull);
  const cycleId = await openedCycle(w, templateId, "FY26");
  const reviewIds: string[] = [];
  for (const key of submit) reviewIds.push(await submitManagerReview(w.orgId, cycleId, people[key]));
  const session = await createCalibrationSession({ orgId: w.orgId, actorId: w.hrFull, cycleId, name: "Calibration" });
  return { ...people, templateId, cycleId, reviewIds, sessionId: session.id };
}

const CALIBRATION = { features: PERF_FEATURES, permissions: MANAGE, actors: HR };

scopeMatrix([
  scopeRow({
    name: "a restricted HR calibrates, reopens and shares a review only inside their legal-entity scope",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: (w) => reviewWorld(w),
    write: async (w, { a, cycleId, reviewId }) => {
      const orgId = w.orgId;
      for (const call of [
        () => calibrateReview({ orgId, actorId: w.hrB, reviewId, calibratedRating: "4", reason: "cross-scope attempt" }),
        () => reopenReview({ orgId, actorId: w.hrB, reviewId, reason: "cross-scope reopen" }),
        () => shareReview({ orgId, actorId: w.hrB, reviewId }),
      ]) await denied(call());
      assert.equal(await statusOf("hrm_reviews", orgId, reviewId), "submitted", "the refused transitions left the review untouched");

      const calibrated = await calibrateReview({ orgId, actorId: w.hrA, reviewId, calibratedRating: "4", reason: "exceeded in H2" });
      assert.deepEqual([calibrated.calibratedRating, calibrated.overallRating], ["4.0000", "3.0000"], "calibration keeps the original rating");
      assert.equal((await reopenReview({ orgId, actorId: w.hrA, reviewId, reason: "correct the rating" })).status, "pending");
      await submitManagerReview(orgId, cycleId, a);
      assert.equal((await shareReview({ orgId, actorId: w.hrA, reviewId })).status, "shared");
    },
  }),
  scopeRow({
    name: "sharing waits for the cycle transition and refuses once calibration starts",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: (w) => reviewWorld(w),
    write: async (w, { a, cycleId, reviewId }) => {
      const [outcome] = await whileLocked(
        sql`select id from hrm_review_cycles where org_id = ${w.orgId} and id = ${cycleId} for update`,
        [() => shareReview({ orgId: w.orgId, actorId: a.managerUserId, reviewId })],
        sql`update hrm_review_cycles set status = 'calibrating' where org_id = ${w.orgId} and id = ${cycleId}`,
      );
      await refused(Promise.reject(outcome), "REFUSED", /calibrating cycle/);
      assert.equal(await statusOf("hrm_reviews", w.orgId, reviewId), "submitted");
    },
  }),
  scopeRow({
    name: "the calibration justification reaches HR and the reviewer but never the subject",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: { ...HR, manageOnly: { scope: "all", permissions: MANAGE, link: true } },
    seed: async (w) => {
      const seeded = await reviewWorld(w);
      await calibrateReview({ orgId: w.orgId, actorId: w.hrFull, reviewId: seeded.reviewId, calibratedRating: "4", reason: "private HR justification" });
      return seeded;
    },
    write: async (w, { a, cycleId, reviewId }) => {
      const orgId = w.orgId;
      // A caller who may manage the transition but not read the review gets the same projection a read would.
      assert.equal((await shareReview({ orgId, actorId: w.manageOnly, reviewId })).calibrationReason, null);
      const subjectView = (await getCycleDetail({ orgId, actorId: a.userId, cycleId })).reviews.find((r) => r.id === reviewId)!;
      assert.deepEqual([subjectView.calibratedRating, subjectView.calibrationReason], ["4.0000", null], "the subject sees the rating, never the reason");
      assert.equal((await listMyReviews({ orgId, actorId: a.userId })).asSubject.find((r) => r.id === reviewId)?.calibrationReason, null);
      assert.equal((await getReviewDetail({ orgId, actorId: a.userId, reviewId })).review.calibrationReason, null);

      const reason = "private HR justification";
      assert.equal((await getReviewDetail({ orgId, actorId: w.hrFull, reviewId })).review.calibrationReason, reason);
      assert.equal((await getCycleDetail({ orgId, actorId: w.hrFull, cycleId })).reviews.find((r) => r.id === reviewId)?.calibrationReason, reason);
      assert.equal((await listMyReviews({ orgId, actorId: a.managerUserId })).asReviewer.find((r) => r.id === reviewId)?.calibrationReason, reason);

      const acknowledged = await acknowledgeReview({ orgId, actorId: a.userId, reviewId });
      assert.deepEqual([acknowledged.status, acknowledged.calibrationReason], ["acknowledged", null]);
    },
  }),
  scopeRow({
    name: "review cycles are created, opened, moved and closed only inside the HR's legal-entity scope",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: async (w) => ({ ...(await sides(w)), templateId: await mkReviewTemplate(w.orgId, w.hrFull, { name: "Annual", scaleLabels: [] }) }),
    write: async (w, { a, b, templateId }) => {
      const orgId = w.orgId;
      await refusal(cycle(w, templateId, "Unscoped FY26", undefined, w.hrA), HrmAuthorizationError, /must name a department or employer subsidiary in their scope/);
      const scoped = await cycle(w, templateId, "A-scope FY26", entity(w.subA), w.hrA);
      assert.equal(scoped.appliesTo.employerSubsidiaryId, w.subA);

      // A goal links only to a cycle whose scope covers its subject.
      const goal = (employmentId: string) => createGoal({ orgId, actorId: w.hrFull, employmentId, title: "Ship the widget", cycleId: scoped.id });
      await refused(goal(b.employmentId), "REFUSED", /outside the scope of review cycle/);
      assert.equal((await goal(a.employmentId)).cycleId, scoped.id);

      const departmentB = await department(orgId, "B-only department", w.subB);
      await refusal(cycle(w, templateId, "Mismatched scope", { employer_subsidiary_id: w.subA, department_id: departmentB }), HrmPerformanceError, /department belongs to another subsidiary/);
      const orgWide = await cycle(w, templateId, "Org-wide draft");
      const departmentCycle = await cycle(w, templateId, "B department cycle", { employer_subsidiary_id: null, department_id: departmentB });
      for (const draft of [orgWide, departmentCycle]) {
        await denied(openCycle({ orgId, actorId: w.hrA, cycleId: draft.id }));
        assert.equal(await statusOf("hrm_review_cycles", orgId, draft.id), "draft");
        assert.equal(await countRows(sql`from hrm_reviews where org_id = ${orgId} and cycle_id = ${draft.id}`), 0, "the refused open generated no reviews");
      }
      assert.equal((await listCycleProgress({ orgId, actorId: w.hrA })).some((item) => item.id === departmentCycle.id), false);
      await refused(getCycleDetail({ orgId, actorId: w.hrA, cycleId: departmentCycle.id }), "NOT_FOUND");

      // The scope refusal fires before the pending-reviews refusal a forced move would otherwise raise.
      await openCycle({ orgId, actorId: w.hrFull, cycleId: scoped.id });
      await denied(moveToCalibrating({ orgId, actorId: w.hrB, cycleId: scoped.id, force: true, forceReason: "rush" }));
      await denied(closeCycle({ orgId, actorId: w.hrB, cycleId: scoped.id }));
      assert.equal((await closeCycle({ orgId, actorId: w.hrA, cycleId: scoped.id })).status, "closed");
    },
  }),
  scopeRow({
    name: "cycle lists and details hide other entities and scope org-wide progress",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: async (w) => {
      const { a } = await sides(w);
      const templateId = await mkReviewTemplate(w.orgId, w.hrFull, { name: "Annual", scaleLabels: [] });
      return { a, cycleB: await openedCycle(w, templateId, "FY26 B-scope", entity(w.subB)), orgCycle: await openedCycle(w, templateId, "FY26 org-wide") };
    },
    read: async (w, { a, cycleB, orgCycle }) => {
      const listed = await listCycleProgress({ orgId: w.orgId, actorId: w.hrA });
      assert.ok(!listed.some((item) => item.id === cycleB), "the B-scoped cycle is not disclosed");
      const progress = listed.find((item) => item.id === orgCycle);
      assert.ok(progress, "the org-wide cycle remains visible");
      assert.deepEqual([progress.templateId, progress.templateName, progress.managerGapCount], [null, null, null], "no org-wide template metadata or gap count");
      assert.deepEqual([progress.totalSelf, progress.totalManager], [2, 1], "only A's worker and manager contribute");

      const detail = await getCycleDetail({ orgId: w.orgId, actorId: w.hrA, cycleId: orgCycle });
      assert.deepEqual([detail.templateId, detail.templateName, detail.managerGapCount], [null, null, null]);
      assert.deepEqual(new Set(detail.reviews.map((review) => review.employmentId)), new Set([a.employmentId, a.managerEmploymentId]));
      await refused(getCycleDetail({ orgId: w.orgId, actorId: w.hrA, cycleId: cycleB }), "NOT_FOUND");
    },
  }),
  scopeRow({
    name: "feedback reads, writes, retractions and request fulfilment follow the subject's legal entity",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: async (w) => {
      const people = await sides(w);
      const note = (s: Side, body: string) => writeFeedback({
        orgId: w.orgId, actorId: w.hrFull, subjectEmploymentId: s.employmentId, kind: "feedback", visibility: "manager_and_subject", body,
      });
      return { ...people, onA: await note(people.a, "A-side feedback"), onB: await note(people.b, "B-side feedback") };
    },
    read: async (w) => {
      const bodies = async (actorId: string) => (await listFeedback({ orgId: w.orgId, actorId })).map((f) => f.body).sort();
      assert.deepEqual(await bodies(w.hrA), ["A-side feedback"]);
      assert.deepEqual(await bodies(w.hrB), ["B-side feedback"]);
      assert.deepEqual(await bodies(w.hrFull), ["A-side feedback", "B-side feedback"]);
    },
    write: async (w, { b, onA, onB }) => {
      const orgId = w.orgId;
      await refused(writeFeedback({
        orgId, actorId: w.hrA, subjectEmploymentId: b.employmentId, kind: "praise", visibility: "public", body: "Out-of-scope public praise",
      }), "NOT_FOUND");
      assert.equal(await countRows(sql`from hrm_feedback where org_id = ${orgId} and body = 'Out-of-scope public praise'`), 0, "the refused praise stored nothing");

      // Out of scope the row answers as missing; in scope a repeat retraction names the state instead.
      await refused(retractFeedback({ orgId, actorId: w.hrA, id: onB.id }), "NOT_FOUND", /another organization or already be retracted/);
      await retractFeedback({ orgId, actorId: w.hrB, id: onB.id });
      await refused(retractFeedback({ orgId, actorId: w.hrB, id: onB.id }), "BAD_STATE", /already retracted/);
      await retractFeedback({ orgId, actorId: w.hrA, id: onA.id });

      const request = await writeFeedback({
        orgId, actorId: w.hrFull, subjectEmploymentId: b.employmentId, kind: "request", visibility: "manager_and_subject",
        body: "Tell me about the launch", requestedFromPartyId: b.managerPartyId,
      });
      const fulfil = (actorId: string, body: string) => fulfillRequest({ orgId, actorId, requestId: request.id, visibility: "manager_and_subject", body });
      await refused(fulfil(w.hrA, "Out-of-scope answer"), "FORBIDDEN", /only the requested party or HR may fulfil/);
      assert.equal(await countRows(fulfilments(orgId, request.id)), 0, "the refused fulfilment stored nothing");
      assert.equal((await fulfil(w.hrB, "They led the launch")).subjectEmploymentId, b.employmentId);
    },
  }),
  scopeRow({
    name: "a request is fulfilled once: a repeat returns the answer and a divergent one is refused",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: (w) => sides(w),
    write: async (w, { a }) => {
      const orgId = w.orgId;
      const request = await writeFeedback({
        orgId, actorId: w.hrFull, subjectEmploymentId: a.employmentId, kind: "request", visibility: "manager_and_subject",
        body: "Tell me about the launch", requestedFromPartyId: a.managerPartyId,
      });
      const inbox = async () => (await listOpenRequestsForParty({ orgId, actorId: a.managerUserId })).map((row) => row.id);
      const fulfil = (actorId: string, body: string, visibility: "manager_and_subject" | "manager_only" = "manager_and_subject") =>
        fulfillRequest({ orgId, actorId, requestId: request.id, visibility, body });
      assert.deepEqual(await inbox(), [request.id]);
      const first = await fulfil(a.managerUserId, "They led the launch");
      assert.deepEqual(await inbox(), [], "the answered request leaves the open inbox");
      assert.equal((await fulfil(a.managerUserId, "They led the launch")).id, first.id, "an identical repeat returns the one fulfilment");

      // A changed body names the prior fulfilment and the remedy; a changed visibility or author diverges too.
      const changed = await refused(fulfil(a.managerUserId, "They sank the launch"), "REFUSED", /already fulfilled/);
      assert.match(changed.message, /write a new feedback entry instead/);
      await refused(fulfil(a.managerUserId, "They led the launch", "manager_only"), "REFUSED");
      await refused(fulfil(w.hrFull, "They led the launch"), "REFUSED");
      const stored = (await db.execute<{ body: string }>(sql`select body ${fulfilments(orgId, request.id)}`)).rows;
      assert.deepEqual([first.body, ...stored.map((row) => row.body)], ["They led the launch", "They led the launch"], "the first answer stands alone and unchanged");
    },
  }),
  scopeRow({
    name: "exit records, turnover and retention gaps show a restricted HR only their entities' leavers",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: async (w) => {
      const orgId = w.orgId;
      const leaverA = await leaver(orgId, "Leaver A", w.subA);
      // B-side gaps HR-A must never see: a leaver with no exit record, and an exit record with no interview.
      const leaverB1 = await leaver(orgId, "Leaver B1", w.subB);
      const leaverB2 = await leaver(orgId, "Leaver B2", w.subB);
      const exitA = await recordExit({
        orgId, actorId: w.hrFull, employmentId: leaverA, reasonKind: "resignation", isVoluntary: true,
        interviewHeldOn: "2026-02-01", interviewerPartyId: w.party.hrFull,
      });
      const exitB = await recordExit({ orgId, actorId: w.hrFull, employmentId: leaverB2, reasonKind: "redundancy", isVoluntary: false });
      return { leaverB1, exitA: exitA.id, exitB: exitB.id };
    },
    read: async (w, { leaverB1, exitA, exitB }) => {
      const orgId = w.orgId;
      await refused(getExitRecord({ orgId, actorId: w.hrA, exitId: exitB }), "NOT_FOUND");
      assert.equal((await getExitRecord({ orgId, actorId: w.hrA, exitId: exitA })).id, exitA);
      assert.deepEqual((await listExitRecords({ orgId, actorId: w.hrA })).map((e) => e.id), [exitA]);
      assert.deepEqual((await listExitRecords({ orgId, actorId: w.hrB })).map((e) => e.id), [exitB]);
      assert.deepEqual((await listExitRecords({ orgId, actorId: w.hrFull })).map((e) => e.revision), [1, 1], "listed rows carry the revision a correction requires");

      const periods = [{ start: "2025-01-01", end: "2027-01-01" }];
      const terminations = async (actorId: string) => (await getTurnover({ orgId, actorId, periods })).periods.reduce((n, row) => n + row.terminations, 0);
      assert.equal(await terminations(w.hrA), 1, "HR-A's turnover counts only the A-side leaver");
      assert.equal(await terminations(w.hrFull), 3, "unrestricted HR keeps the org-wide turnover");
      const scoped = await getRetentionOverview({ orgId, actorId: w.hrA });
      assert.deepEqual([scoped.trailingTwelveMonths?.terminations, scoped.missingExitRecords, scoped.exitRecordsWithoutInterview], [1, [], []]);
      const full = await getRetentionOverview({ orgId, actorId: w.hrFull });
      assert.equal(full.trailingTwelveMonths?.terminations, 3);
      assert.deepEqual(full.missingExitRecords.map((m) => m.employmentId), [leaverB1]);
      assert.equal(full.exitRecordsWithoutInterview.length, 1);
    },
  }),
  scopeRow({
    name: "an exit links only its own termination and corrects under revision with an audit trail",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    write: async (w) => {
      const orgId = w.orgId;
      const leaverA = await leaver(orgId, "Leaver A", w.subA);
      const leaverB = await leaver(orgId, "Leaver B", w.subB);
      const record = (terminationChangeId: string) => recordExit({
        orgId, actorId: w.hrFull, employmentId: leaverA, terminationChangeId, reasonKind: "resignation", isVoluntary: true,
        notes: "Left for growth", destination: "Competition",
      });
      // Another employment's termination, or a non-terminating change on this one, is refused by name.
      for (const changeId of [await mkChange(orgId, leaverB, "terminated", w.hrFull), await mkChange(orgId, leaverA, "status_changed", w.hrFull)]) {
        await refused(record(changeId), "REFUSED", /is not the termination of employment/);
      }
      const own = await mkChange(orgId, leaverA, "terminated", w.hrFull);
      const exit = await record(own);
      assert.deepEqual([exit.terminationChangeId, exit.revision], [own, 1]);

      // An explicit null clears; an omitted field keeps its value; a stale revision refuses instead of overwriting.
      const cleared = await updateExitRecord({ orgId, actorId: w.hrFull, exitId: exit.id, expectedRevision: 1, notes: null, reason: "notes were speculation" });
      assert.deepEqual([cleared.notes, cleared.destination, cleared.revision], [null, "Competition", 2]);
      await refused(updateExitRecord({ orgId, actorId: w.hrFull, exitId: exit.id, expectedRevision: 1, destination: "Elsewhere" }), "BAD_STATE", /at revision 2, not 1 — re-read it/);

      const events = (await db.execute<{ kind: string; actor: string | null; reason: string | null; before: { notes?: string | null }; after: { notes?: string | null } }>(sql`
        select kind, actor_user_id::text as actor, reason, before_snapshot as before, after_snapshot as after
          from hrm_exit_record_events where org_id = ${orgId} and exit_record_id = ${exit.id} order by recorded_at`)).rows;
      assert.deepEqual(events.map((e) => e.kind), ["recorded", "corrected"]);
      const correction = events[1]!;
      assert.deepEqual([correction.actor, correction.reason, correction.before.notes, correction.after.notes], [w.hrFull, "notes were speculation", "Left for growth", null]);
    },
  }),
  scopeRow({
    name: "competency profiles read only inside the reader's scope and the framework's applicability",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: async (w) => {
      const orgId = w.orgId;
      const people = await sides(w);
      const templateId = await mkReviewTemplate(orgId, w.hrFull, { name: "Annual", scaleLabels: [] });
      const sectionId = (await db.execute<{ id: string }>(sql`
        select id from hrm_review_template_sections where org_id = ${orgId} and template_id = ${templateId}`)).rows[0]!.id;
      const framework = await createFramework({ orgId, actorId: w.hrFull, name: "Engineering", appliesTo: entity(w.subB) });
      const competency = await createCompetency({ orgId, actorId: w.hrFull, frameworkId: framework.id, code: "IMPACT", name: "Customer impact" });
      await addCompetencyLevel({ orgId, actorId: w.hrFull, competencyId: competency.id, levelRank: 1, label: "Meets", expectation: "Ships working software" });
      await setSectionCompetency({ orgId, actorId: w.hrFull, sectionId, competencyId: competency.id });
      // An org-wide cycle, so both sides hold a calibrated, shared manager review.
      const cycleId = await openedCycle(w, templateId, "FY26 profile scope");
      for (const subject of [people.a, people.b]) {
        const reviewId = await submitManagerReview(orgId, cycleId, subject);
        await calibrateReview({ orgId, actorId: w.hrFull, reviewId, calibratedRating: "4", reason: "exceeded in H2" });
        await shareReview({ orgId, actorId: w.hrFull, reviewId });
      }
      return people;
    },
    read: async (w, { a, b }) => {
      const profile = (actorId: string, employmentId: string) => competencyProfileForEmployment({ orgId: w.orgId, actorId, employmentId });
      await denied(profile(w.hrA, b.employmentId));
      await denied(profile(w.hrB, a.employmentId));
      // The framework applies to B only, so A's readable assessment exposes no competency to HR, the subject or the manager.
      for (const actorId of [w.hrA, a.userId, a.managerUserId]) assert.deepEqual(await profile(actorId, a.employmentId), []);
      assert.deepEqual((await profile(w.hrB, b.employmentId)).map((row) => row.assessedRating), ["3.0000"]);
      // A stranger without the grant keeps the grant refusal.
      await refused(profile(b.userId, a.employmentId), "FORBIDDEN");
    },
  }),
  scopeRow({
    name: "competency framework reads and writes obey the subsidiary applicability",
    features: PERF_FEATURES,
    permissions: PERF,
    actors: HR,
    seed: async (w) => {
      const orgId = w.orgId;
      const frameworkA = await createFramework({ orgId, actorId: w.hrFull, name: "A framework", appliesTo: entity(w.subA) });
      const frameworkB = await createFramework({ orgId, actorId: w.hrFull, name: "B framework", appliesTo: entity(w.subB) });
      const departmentB = await department(orgId, "B framework department", w.subB);
      const departmentOnlyB = await createFramework({
        orgId, actorId: w.hrFull, name: "B department-only framework", appliesTo: { employer_subsidiary_id: null, department_id: departmentB },
      });
      const competencyB = await createCompetency({ orgId, actorId: w.hrFull, frameworkId: frameworkB.id, code: "B-SKILL", name: "B-only skill" });
      return { frameworkA: frameworkA.id, frameworkB: frameworkB.id, departmentOnlyB: departmentOnlyB.id, competencyB: competencyB.id };
    },
    read: async (w, { frameworkA, frameworkB, departmentOnlyB }) => {
      assert.deepEqual((await listFrameworks({ orgId: w.orgId, actorId: w.hrA })).map((framework) => framework.id), [frameworkA]);
      for (const id of [frameworkB, departmentOnlyB]) assert.equal(await getFramework({ orgId: w.orgId, actorId: w.hrA, id }), null);
    },
    write: async (w, { frameworkB, competencyB }) => {
      const orgId = w.orgId;
      for (const call of [
        () => createFramework({ orgId, actorId: w.hrA, name: "Unrestricted framework" }),
        () => setFrameworkActive({ orgId, actorId: w.hrA, id: frameworkB, isActive: false }),
        () => createCompetency({ orgId, actorId: w.hrA, frameworkId: frameworkB, code: "A-CANNOT-ADD", name: "Out-of-scope skill" }),
        () => addCompetencyLevel({ orgId, actorId: w.hrA, competencyId: competencyB, levelRank: 1, label: "Entry", expectation: "A B-only expectation" }),
      ]) await denied(call());
    },
  }),
  scopeRow({
    name: "a restricted HR lists, reads and directories only the 1:1 pairs they cover",
    ...ONE_ON_ONE,
    seed: oneOnOnes,
    read: async (w, { a, b, oneA, oneB }) => {
      const orgId = w.orgId;
      const ids = async (actorId: string, employmentId?: string) => (await listOneOnOnes({ orgId, actorId, employmentId })).map((one) => one.id).sort();
      assert.deepEqual(await ids(w.hrA), [oneA]);
      assert.deepEqual(await ids(w.hrFull), [oneA, oneB].sort());
      // A cross-scope single read answers as missing; the pair itself reads its own 1:1 without the grant.
      await refused(getOneOnOne({ orgId, actorId: w.hrA, id: oneB }), "NOT_FOUND");
      for (const actorId of [w.hrA, a.userId]) assert.equal((await getOneOnOne({ orgId, actorId, id: oneA })).id, oneA);

      const directory = new Set((await listOneOnOneDirectory({ orgId, actorId: w.hrA })).employments.map((row) => row.id));
      assert.deepEqual([a.managerEmploymentId, a.employmentId, b.managerEmploymentId, b.employmentId].map((id) => directory.has(id)), [true, true, false, false]);
      assert.ok((await listOneOnOneDirectory({ orgId, actorId: w.hrFull })).employments.length >= 4);

      // The self-service report filter lists nothing for a foreign employment.
      assert.deepEqual(await ids(a.managerUserId, b.employmentId), []);
      assert.deepEqual(await ids(a.managerUserId, a.employmentId), [oneA]);
      assert.deepEqual(await ids(w.hrA, b.employmentId), []);
    },
  }),
  scopeRow({
    name: "a restricted HR schedules, holds, skips and cancels only the 1:1 pairs they cover",
    ...ONE_ON_ONE,
    seed: oneOnOnes,
    write: async (w, { a, b, oneA, oneB }) => {
      const orgId = w.orgId;
      const schedule = (s: Side) => scheduleOneOnOne({
        orgId, actorId: w.hrA, managerEmploymentId: s.managerEmploymentId, reportEmploymentId: s.employmentId, scheduledAt: "2026-03-08T10:00:00Z",
      });
      for (const call of [
        () => schedule(b),
        () => holdOneOnOne({ orgId, actorId: w.hrA, id: oneB }),
        () => skipOneOnOne({ orgId, actorId: w.hrA, id: oneB, reason: "away" }),
        () => cancelOneOnOne({ orgId, actorId: w.hrA, id: oneB }),
      ]) await refused(call(), "NOT_FOUND", /not found/);
      const bScheduled = sql`from hrm_one_on_ones where org_id = ${orgId} and report_employment_id = ${b.employmentId} and status = 'scheduled'`;
      assert.equal(await countRows(bScheduled), 1, "the refused writes left B's 1:1 alone");

      const scheduled = await schedule(a);
      assert.equal(scheduled.reportEmploymentId, a.employmentId);
      assert.equal((await holdOneOnOne({ orgId, actorId: w.hrA, id: oneA })).status, "held");
      await cancelOneOnOne({ orgId, actorId: w.hrA, id: scheduled.id });
    },
  }),
  scopeRow({
    name: "a 1:1 write waits for the report employment's scope lock",
    ...ONE_ON_ONE,
    seed: oneOnOnes,
    write: async (w, { a, oneA }) => {
      const [held] = await whileLocked(
        sql`select id from worker_employments where org_id = ${w.orgId} and id = ${a.employmentId} for update`,
        [() => holdOneOnOne({ orgId: w.orgId, actorId: w.hrA, id: oneA })],
      );
      assert.equal((held as { status?: string }).status, "held", "the write lands once the report's employer has been rechecked");
    },
  }),
  scopeRow({
    name: "a recurring 1:1 follows its weekday and local time across daylight saving",
    ...ONE_ON_ONE,
    seed: oneOnOnes,
    write: async (w, { a }) => {
      const orgId = w.orgId;
      await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{timeZone}', '"America/New_York"'::jsonb, true) where id = ${orgId}`);
      const scheduled = await scheduleOneOnOne({
        orgId, actorId: w.hrFull, managerEmploymentId: a.managerEmploymentId, reportEmploymentId: a.employmentId,
        scheduledAt: "2026-03-02T15:00:00Z", recurrence: { every_weeks: 2, weekday: 3, time: "16:30" },
      });
      await skipOneOnOne({ orgId, actorId: w.hrFull, id: scheduled.id, reason: "reschedule" });
      const next = (await db.execute<{ scheduled_at: string }>(sql`
        select scheduled_at::text from hrm_one_on_ones where org_id = ${orgId} and series_id = ${scheduled.id} and status = 'scheduled'`)).rows[0];
      assert.ok(next, "skipping a recurring occurrence creates its next occurrence");
      assert.equal(new Date(next.scheduled_at).toISOString(), "2026-03-18T20:30:00.000Z");
    },
  }),
  scopeRow({
    name: "talent reviews, lists, the directory and rating scales stay inside the HR's legal entities",
    ...TALENT,
    seed: talentWorld,
    write: async (w, { hrEmpty, empA, empB, templateId, cycleId }) => {
      const orgId = w.orgId;
      const record = (employmentId: string, actorId: string) => recordTalentReview({
        orgId, actorId, employmentId, cycleId, performanceKey: "low", potentialKey: "high", impactOfLoss: "low", riskOfLoss: "low",
      });
      assert.equal((await record(empA, w.hrA)).employmentId, empA);
      await refused(record(empB, w.hrA), "NOT_FOUND", /employment was not found/);
      assert.equal((await record(empB, w.hrFull)).employmentId, empB, "unrestricted HR records either side");

      assert.deepEqual((await listTalentReviews({ orgId, actorId: w.hrA })).map((review) => review.employmentId), [empA]);
      assert.equal((await listTalentReviews({ orgId, actorId: w.hrFull })).length, 2);
      const directory = (await listTalentDirectory({ orgId, actorId: w.hrA })).employments.map((e) => e.id);
      assert.ok(directory.includes(empA) && !directory.includes(empB), "the other entity's people stay hidden");
      assert.deepEqual(await listTalentReviews({ orgId, actorId: hrEmpty }), []);
      assert.deepEqual(await listTalentDirectory({ orgId, actorId: hrEmpty }), { employments: [], positions: [] });

      const cycleB = await cycle(w, templateId, "B cycle", entity(w.subB));
      await refused(resolveTalentScales({ orgId, actorId: w.hrA, cycleId: cycleB.id }), "NOT_FOUND", /review cycle was not found/);
      const cycleA = await cycle(w, templateId, "A cycle", entity(w.subA));
      assert.deepEqual([...(await resolveTalentScales({ orgId, actorId: w.hrA, cycleId: cycleA.id })).performance], ["low", "high"]);
    },
  }),
  scopeRow({
    name: "succession plans and candidates stay inside the fence and an active plan keeps its candidates",
    ...TALENT,
    seed: talentWorld,
    write: async (w, { hrEmpty, empA, empB }) => {
      const orgId = w.orgId;
      const position = (positionCode: string, employerSubsidiaryId: string) => createPosition({
        orgId, actorId: w.hrFull, positionCode, title: positionCode, employerSubsidiaryId, plannedFte: "1.0000",
        status: "open", effectiveFrom: "2026-01-01", reason: "scope seed",
      });
      const positionB = await position("LEAD-B", w.subB);
      const positionA = await position("LEAD-A", w.subA);
      await refused(createSuccessionPlan({ orgId, actorId: w.hrA, positionId: positionB.id }), "NOT_FOUND", /position was not found/);
      const planB = await createSuccessionPlan({ orgId, actorId: w.hrFull, positionId: positionB.id });
      const planA = await createSuccessionPlan({ orgId, actorId: w.hrFull, positionId: positionA.id, notes: "Interim coverage while the successor is prepared." });
      const notesOf = async () => (await listSuccessionPlans({ orgId, actorId: w.hrFull })).find((plan) => plan.id === planA.id)?.notes;
      assert.equal(await notesOf(), "Interim coverage while the successor is prepared.", "plan notes read back from storage");
      await setSuccessionPlanNotes({ orgId, actorId: w.hrFull, id: planA.id, notes: "The regional lead will cover the role through quarter end." });
      assert.equal(await notesOf(), "The regional lead will cover the role through quarter end.", "plan notes can be edited and read back");

      // A scoped HR cannot move another entity's plan; nobody staffs a plan with another entity's employee.
      await refused(setSuccessionPlanStatus({ orgId, actorId: w.hrA, id: planB.id, status: "active" }), "NOT_FOUND");
      await refused(addSuccessionCandidate({ orgId, actorId: w.hrFull, planId: planA.id, employmentId: empB, readiness: "ready_now" }), "NOT_FOUND", /employment was not found/);
      assert.deepEqual((await listSuccessionPlans({ orgId, actorId: w.hrA })).map((plan) => plan.id), [planA.id]);
      assert.deepEqual(await listSuccessionPlans({ orgId, actorId: hrEmpty }), []);

      const evidence = /active succession plan keeps its candidates as evidence/;
      await setSuccessionPlanStatus({ orgId, actorId: w.hrA, id: planA.id, status: "active" });
      await refused(addSuccessionCandidate({ orgId, actorId: w.hrA, planId: planA.id, employmentId: empA, readiness: "ready_now" }), "REFUSED", evidence);
      await setSuccessionPlanStatus({ orgId, actorId: w.hrFull, id: planA.id, status: "draft" });
      const second = await mkEmployment(orgId, await mkParty(orgId, "Second candidate"), w.subA);
      const [candidate, secondCandidate] = await Promise.all([
        addSuccessionCandidate({ orgId, actorId: w.hrA, planId: planA.id, employmentId: empA, readiness: "ready_now" }),
        addSuccessionCandidate({ orgId, actorId: w.hrFull, planId: planA.id, employmentId: second, readiness: "one_to_two_years" }),
      ]);
      assert.notEqual(candidate.order, secondCandidate.order, "concurrent appends receive distinct ranks");
      // An out-of-scope candidate planted directly never surfaces to the scoped reader.
      await db.execute(sql`
        insert into hrm_succession_candidates (org_id, plan_id, employment_id, readiness, candidate_order, created_by, updated_by)
        values (${orgId}, ${planA.id}, ${empB}, 'ready_now', 99, ${w.hrFull}, ${w.hrFull})`);
      const scopedPlan = (await listSuccessionPlans({ orgId, actorId: w.hrA })).find((plan) => plan.id === planA.id)!;
      assert.ok(scopedPlan.candidates.every((item) => item.employmentId !== empB));

      // A removal racing the plan's activation waits for the plan lock and then refuses.
      const [removal] = await whileLocked(
        sql`select id from hrm_succession_plans where org_id = ${orgId} and id = ${planA.id} for update`,
        [() => removeSuccessionCandidate({ orgId, actorId: w.hrFull, planId: planA.id, candidateId: candidate.id })],
        sql`update hrm_succession_plans set status = 'active' where org_id = ${orgId} and id = ${planA.id}`,
      );
      await refused(Promise.reject(removal), "REFUSED", evidence);
      const candidates = sql`from hrm_succession_candidates where org_id = ${orgId} and plan_id = ${planA.id}`;
      assert.equal(await countRows(candidates), 3, "both added candidates and the planted row survive the refused removal");
      await setSuccessionPlanStatus({ orgId, actorId: w.hrFull, id: planA.id, status: "draft" });
      await removeSuccessionCandidate({ orgId, actorId: w.hrFull, planId: planA.id, candidateId: candidate.id });
      assert.equal(await countRows(candidates), 2, "removal drops exactly the targeted candidate");
    },
  }),
  scopeRow({
    name: "calibration sessions open only on live cycles inside the HR's scope",
    ...CALIBRATION,
    seed: (w) => calibrationWorld(w, []),
    write: async (w, { templateId }) => {
      const orgId = w.orgId;
      const draft = await cycle(w, templateId, "Draft calibration cycle");
      const early = /draft.*open or calibrating/;
      await refused(createCalibrationSession({ orgId, actorId: w.hrFull, cycleId: draft.id, name: "Too early" }), "BAD_STATE", early);
      // A session stored before the rule existed cannot open either, and the refusal enters nothing.
      const legacyId = (await db.execute<{ id: string }>(sql`
        insert into hrm_calibration_sessions (org_id, cycle_id, name, created_by, updated_by)
        values (${orgId}, ${draft.id}, 'Legacy draft session', ${w.hrFull}, ${w.hrFull}) returning id`)).rows[0]!.id;
      await refused(openCalibrationSession({ orgId, actorId: w.hrFull, id: legacyId }), "BAD_STATE", early);
      assert.equal(await statusOf("hrm_calibration_sessions", orgId, legacyId), "draft");
      assert.equal(await countRows(sql`from hrm_calibration_entries where org_id = ${orgId} and session_id = ${legacyId}`), 0);

      const cycleB = await cycle(w, templateId, "B cycle", entity(w.subB));
      await refused(createCalibrationSession({ orgId, actorId: w.hrA, cycleId: cycleB.id, name: "B session" }), "NOT_FOUND", /review cycle was not found/);
    },
  }),
  scopeRow({
    name: "a scoped HR's session enters and decides only in-scope reviews without naming the others",
    ...CALIBRATION,
    seed: (w) => calibrationWorld(w, ["a", "b"]),
    write: async (w, { a, b, sessionId }) => {
      const opened = await openCalibrationSession({ orgId: w.orgId, actorId: w.hrA, id: sessionId });
      assert.equal(opened.status, "open");
      assert.deepEqual(opened.entries.map((e) => e.employmentId), [a.employmentId], "only the allowed entity's reviews enter");
      assert.ok(!opened.missing.some((m) => m.employmentId === b.employmentId), "the missing list never names the other entity's review");
      const workerName = (await db.execute<{ name: string }>(sql`
        select display_name as name from parties where org_id = ${w.orgId} and id = ${a.partyId}`)).rows[0]!.name;
      assert.ok(opened.missing.length > 0, "the in-scope self review remains listed as missing");
      assert.ok(
        opened.missing.some((m) => m.subjectName === workerName) && opened.missing.every((m) => m.subjectName !== m.reviewId.slice(0, 8)),
        "missing reviews identify the worker by name, never by a review id fragment",
      );
      const decided = await setCalibratedRating({ orgId: w.orgId, actorId: w.hrA, entryId: opened.entries[0]!.id, calibratedRating: "4", justification: "evidence reviewed" });
      assert.equal(decided.calibratedRating, "4.0000");
    },
  }),
  scopeRow({
    name: "deciding another entity's entry or closing a session that holds one is refused",
    ...CALIBRATION,
    seed: (w) => calibrationWorld(w, ["a", "b"]),
    write: async (w, { a, b, sessionId }) => {
      const orgId = w.orgId;
      const opened = await openCalibrationSession({ orgId, actorId: w.hrFull, id: sessionId });
      assert.equal(opened.entries.length, 2);
      const entryOf = (s: Side) => opened.entries.find((e) => e.employmentId === s.employmentId)!.id;
      const decide = (actorId: string, entryId: string, calibratedRating: string) =>
        setCalibratedRating({ orgId, actorId, entryId, calibratedRating, justification: "evidence reviewed" });
      await refused(decide(w.hrA, entryOf(b), "4"), "NOT_FOUND", /calibration entry was not found/);
      await decide(w.hrFull, entryOf(a), "4");
      await decide(w.hrFull, entryOf(b), "3");
      await refused(closeCalibrationSession({ orgId, actorId: w.hrA, id: sessionId }), "FORBIDDEN", /outside your subsidiaries/);
      assert.equal((await closeCalibrationSession({ orgId, actorId: w.hrFull, id: sessionId })).status, "closed");
    },
  }),
  scopeRow({
    name: "rating changes and reversions wait for a closing calibration session",
    ...CALIBRATION,
    seed: (w) => calibrationWorld(w, ["a"]),
    write: async (w, { reviewIds, sessionId }) => {
      const orgId = w.orgId;
      const reviewId = reviewIds[0]!;
      const opened = await openCalibrationSession({ orgId, actorId: w.hrFull, id: sessionId });
      const entryId = opened.entries.find((entry) => entry.reviewId === reviewId)!.id;
      await setCalibratedRating({ orgId, actorId: w.hrFull, entryId, calibratedRating: "4", justification: "initial calibration" });
      // Close pauses on the locked review after inspecting the session; its session lock must fence both edits.
      const [closing, changing, reverting] = await whileLocked(sql`select id from hrm_reviews where org_id = ${orgId} and id = ${reviewId} for update`, [
        () => closeCalibrationSession({ orgId, actorId: w.hrFull, id: sessionId }),
        () => setCalibratedRating({ orgId, actorId: w.hrFull, entryId, calibratedRating: "3", justification: "late change" }),
        () => revertEntry({ orgId, actorId: w.hrFull, entryId, reason: "late reversion" }),
      ]);
      assert.equal((closing as { status?: string }).status, "closed");
      for (const late of [changing, reverting]) await refused(Promise.reject(late), "BAD_STATE", /session is closed/);
    },
  }),
]);
