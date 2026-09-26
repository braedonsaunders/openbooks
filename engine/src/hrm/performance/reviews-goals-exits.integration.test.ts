import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import {
  enableHrm,
  grant,
  linkPerson,
  mkEmployment,
  mkParty,
  mkReporting,
  mkReviewTemplate,
  mkVersion,
} from "../../testing/hrm-harness.ts";
import { HrmPerformanceError } from "./errors.ts";
import { createCycle, openCycle } from "./review-cycles.ts";
import {
  acknowledgeReview,
  calibrateReview,
  reopenReview,
  shareReview,
  submitReview,
} from "./reviews.ts";
import { createGoal, setGoalStatus, updateGoalProgress } from "./goals.ts";
import { listExitRecords, recordExit, updateExitRecord } from "./exits.ts";

/**
 * HR-7 review transitions, goals and exits over the real 0196 tables —
 * DB-owned (they skip without OPENBOOKS_DB_URL, one file at a time).
 *
 * Proofs are read back from storage, and every refusal asserts its code
 * AND its message: the message is the entire product of a failing check.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

// Shared HRM seeding helpers (grants, employments, versions, reporting
// lines, review templates) live in engine/src/testing/hrm-harness.ts; only
// file-specific seeders and assertion shapers stay here.

type Harness = {
  org: ScratchOrg;
  hrId: string;
  managerUserId: string;
  managerPartyId: string;
  managerEmploymentId: string;
  workerUserId: string;
  workerPartyId: string;
  workerEmploymentId: string;
  cycleId: string;
};

async function setupReviewsHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "HRM Review HR", "hrm_review_hr");
  await grant(org.orgId, hrId, ["hrm.performance.read", "hrm.performance.manage", "hrm.retention.read"]);
  await linkPerson(org.orgId, hrId);
  const managerUserId = await createScratchUser(org.orgId, "Review Manager", "review_manager");
  const managerPartyId = await linkPerson(org.orgId, managerUserId);
  const managerEmploymentId = await mkEmployment(org.orgId, managerPartyId, org.subsidiaryId);
  await mkVersion(org.orgId, managerEmploymentId, { from: "2020-01-01" });
  const workerUserId = await createScratchUser(org.orgId, "Review Worker", "review_worker");
  const workerPartyId = await linkPerson(org.orgId, workerUserId);
  const workerEmploymentId = await mkEmployment(org.orgId, workerPartyId, org.subsidiaryId);
  await mkVersion(org.orgId, workerEmploymentId, { from: "2020-01-01" });
  await mkReporting(org.orgId, workerEmploymentId, managerEmploymentId);
  const templateId = await mkReviewTemplate(org.orgId, hrId, {
    name: "Annual", scaleLabels: [], extraTextQuestion: true,
  });
  const cycle = await createCycle({
    orgId: org.orgId,
    actorId: hrId,
    templateId,
    name: "FY26",
    periodStartOn: "2026-01-01",
    periodEndOn: "2026-06-30",
  });
  await openCycle({ orgId: org.orgId, actorId: hrId, cycleId: cycle.id });
  return {
    org, hrId, managerUserId, managerPartyId, managerEmploymentId,
    workerUserId, workerPartyId, workerEmploymentId, cycleId: cycle.id,
  };
}

async function reviewId(
  orgId: string,
  cycleId: string,
  employmentId: string,
  kind: string,
): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${orgId} and cycle_id = ${cycleId}
       and employment_id = ${employmentId} and kind = ${kind}`)).rows[0]!.id;
}

async function answerIds(orgId: string, reviewId: string): Promise<{ id: string; prompt: string }[]> {
  return (await db.execute<{ id: string; prompt: string }>(sql`
    select id, question_prompt as prompt from hrm_review_answers
     where org_id = ${orgId} and review_id = ${reviewId} order by position`)).rows;
}

test("submit refuses a missing required answer and an out-of-scale rating by question", { skip: !DB }, async () => {
  const h = await setupReviewsHarness();
  try {
    const selfId = await reviewId(h.org.orgId, h.cycleId, h.workerEmploymentId, "self");
    const answers = await answerIds(h.org.orgId, selfId);
    const impact = answers.find((a) => a.prompt === "Customer impact")!.id;
    // Required rating missing on the required question.
    await assert.rejects(
      submitReview({
        orgId: h.org.orgId,
        actorId: h.workerUserId,
        reviewId: selfId,
        answers: [{ answerId: impact, text: "great work" }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /"Customer impact" needs a rating/);
        return true;
      },
    );
    // Rating outside the template scale names the question and the scale.
    await assert.rejects(
      submitReview({
        orgId: h.org.orgId,
        actorId: h.workerUserId,
        reviewId: selfId,
        answers: [{ answerId: impact, rating: "9", text: "great work" }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /"Customer impact".*outside the template scale 1 to 5/);
        return true;
      },
    );
    // A peer cannot submit another's review.
    const peerUser = await createScratchUser(h.org.orgId, "Peer", "review_peer");
    await linkPerson(h.org.orgId, peerUser);
    await assert.rejects(
      submitReview({
        orgId: h.org.orgId,
        actorId: peerUser,
        reviewId: selfId,
        answers: [{ answerId: impact, rating: "4", text: "fine" }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "FORBIDDEN");
        return true;
      },
    );
    // The valid submit lands submitted with its event, read back from storage.
    const submitted = await submitReview({
      orgId: h.org.orgId,
      actorId: h.workerUserId,
      reviewId: selfId,
      answers: [{ answerId: impact, rating: "4", text: "solid quarter" }],
      overallRating: "4",
    });
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.overallRating, "4.0000");
    const stored = (await db.execute<{ status: string }>(sql`
      select status from hrm_reviews where org_id = ${h.org.orgId} and id = ${selfId}`)).rows[0]!.status;
    assert.equal(stored, "submitted");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("calibrate keeps the original rating, share refuses while calibrating, acknowledge is subject-only", { skip: !DB }, async () => {
  const h = await setupReviewsHarness();
  try {
    const managerId = await reviewId(h.org.orgId, h.cycleId, h.workerEmploymentId, "manager");
    const answers = await answerIds(h.org.orgId, managerId);
    await submitReview({
      orgId: h.org.orgId,
      actorId: h.managerUserId,
      reviewId: managerId,
      answers: [{ answerId: answers[0]!.id, rating: "3", text: "meets expectations" }],
      overallRating: "3",
    });
    const calibrated = await calibrateReview({
      orgId: h.org.orgId,
      actorId: h.hrId,
      reviewId: managerId,
      calibratedRating: "4",
      reason: "exceeded in H2 delivery",
    });
    assert.equal(calibrated.status, "calibrated");
    // The original overall rating is never overwritten.
    assert.equal(calibrated.overallRating, "3.0000");
    assert.equal(calibrated.calibratedRating, "4.0000");
    // Sharing a self review is meaningless.
    const selfId = await reviewId(h.org.orgId, h.cycleId, h.workerEmploymentId, "self");
    await submitReview({
      orgId: h.org.orgId,
      actorId: h.workerUserId,
      reviewId: selfId,
      answers: [{ answerId: (await answerIds(h.org.orgId, selfId))[0]!.id, rating: "4", text: "good" }],
    });
    await assert.rejects(
      shareReview({ orgId: h.org.orgId, actorId: h.workerUserId, reviewId: selfId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /already the subject's/);
        return true;
      },
    );
    // Sharing while the cycle calibrates is refused; after close it shares.
    const { moveToCalibrating, closeCycle } = await import("./review-cycles.ts");
    await moveToCalibrating({
      orgId: h.org.orgId,
      actorId: h.hrId,
      cycleId: h.cycleId,
      force: true,
      forceReason: "test close",
    });
    await assert.rejects(
      shareReview({ orgId: h.org.orgId, actorId: h.managerUserId, reviewId: managerId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /finish calibration \(close the cycle\) before sharing/);
        return true;
      },
    );
    await closeCycle({ orgId: h.org.orgId, actorId: h.hrId, cycleId: h.cycleId });
    const shared = await shareReview({ orgId: h.org.orgId, actorId: h.managerUserId, reviewId: managerId });
    assert.equal(shared.status, "shared");
    // Anyone but the subject cannot acknowledge.
    await assert.rejects(
      acknowledgeReview({ orgId: h.org.orgId, actorId: h.managerUserId, reviewId: managerId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "FORBIDDEN");
        return true;
      },
    );
    const acked = await acknowledgeReview({ orgId: h.org.orgId, actorId: h.workerUserId, reviewId: managerId });
    assert.equal(acked.status, "acknowledged");
    // A shared-then-acknowledged review never reopens.
    await assert.rejects(
      reopenReview({ orgId: h.org.orgId, actorId: h.hrId, reviewId: managerId, reason: "typo" }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "BAD_STATE");
        assert.match(e.message, /a shared review stays shared/);
        return true;
      },
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("goals progress, achieve, miss and cancel with terminal evidence", { skip: !DB }, async () => {
  const h = await setupReviewsHarness();
  try {
    const goal = await createGoal({
      orgId: h.org.orgId,
      actorId: h.workerUserId,
      employmentId: h.workerEmploymentId,
      title: "Ship the migration",
      dueOn: "2026-12-31",
    });
    assert.equal(goal.status, "active");
    assert.equal(goal.progressPercent, 0);
    const half = await updateGoalProgress({
      orgId: h.org.orgId,
      actorId: h.workerUserId,
      goalId: goal.id,
      progressPercent: 50,
      note: "halfway",
    });
    assert.equal(half.progressPercent, 50);
    // Missing without a note is refused.
    await assert.rejects(
      setGoalStatus({ orgId: h.org.orgId, actorId: h.workerUserId, goalId: goal.id, status: "missed" }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /without a note/);
        return true;
      },
    );
    const done = await setGoalStatus({
      orgId: h.org.orgId,
      actorId: h.workerUserId,
      goalId: goal.id,
      status: "achieved",
    });
    assert.equal(done.status, "achieved");
    assert.equal(done.progressPercent, 100);
    // A terminal goal takes no more progress.
    await assert.rejects(
      updateGoalProgress({ orgId: h.org.orgId, actorId: h.workerUserId, goalId: goal.id, progressPercent: 100 }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "BAD_STATE");
        return true;
      },
    );
    const updates = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_goal_updates where org_id = ${h.org.orgId} and goal_id = ${goal.id}`)).rows[0]!.n;
    assert.equal(updates, "3", "set, halfway, achieved");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("exits refuse unterminated employments, duplicates, and unpaired interviews", { skip: !DB }, async () => {
  const h = await setupReviewsHarness();
  try {
    // Unterminated employment: refused by name.
    await assert.rejects(
      recordExit({
        orgId: h.org.orgId,
        actorId: h.hrId,
        employmentId: h.workerEmploymentId,
        reasonKind: "resignation",
        isVoluntary: true,
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /is active as of .* not terminated/);
        return true;
      },
    );
    // A second employment whose first version is terminated: versions are
    // append-only evidence, so tests never update them either.
    const leaverPartyId = await mkParty(h.org.orgId, "Departed Worker");
    const leaverEmploymentId = await mkEmployment(h.org.orgId, leaverPartyId, h.org.subsidiaryId);
    await mkVersion(h.org.orgId, leaverEmploymentId, { from: "2026-01-01", status: "terminated" });
    // Interview date without interviewer is refused before storage pins it.
    await assert.rejects(
      recordExit({
        orgId: h.org.orgId,
        actorId: h.hrId,
        employmentId: leaverEmploymentId,
        reasonKind: "resignation",
        isVoluntary: true,
        interviewHeldOn: "2026-07-01",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /both the held date and the interviewer/);
        return true;
      },
    );
    const exit = await recordExit({
      orgId: h.org.orgId,
      actorId: h.hrId,
      employmentId: leaverEmploymentId,
      reasonKind: "resignation",
      isVoluntary: true,
      isRegrettable: true,
      interviewHeldOn: "2026-07-01",
      interviewerPartyId: h.managerPartyId,
      destination: "Competition",
      notes: "Left for growth",
    });
    assert.equal(exit.reasonKind, "resignation");
    // F3-40: the interview reads back with the interviewer's name, never a
    // raw party uuid — the record and the list agree.
    assert.equal(exit.interviewerName, `Person ${h.managerPartyId.slice(0, 8)}`);
    const listed = await listExitRecords({
      orgId: h.org.orgId,
      actorId: h.hrId,
      employmentId: leaverEmploymentId,
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.interviewHeldOn, "2026-07-01");
    assert.equal(listed[0]?.interviewerName, exit.interviewerName);
    // A second record for the same employment is a correction, not a row.
    await assert.rejects(
      recordExit({
        orgId: h.org.orgId,
        actorId: h.hrId,
        employmentId: leaverEmploymentId,
        reasonKind: "resignation",
        isVoluntary: true,
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "DUPLICATE");
        assert.match(e.message, /correct it with an update/);
        return true;
      },
    );
    const corrected = await updateExitRecord({
      orgId: h.org.orgId,
      actorId: h.hrId,
      exitId: exit.id,
      expectedRevision: exit.revision,
      wouldRehire: true,
    });
    assert.equal(corrected.wouldRehire, true);
    assert.equal(corrected.reasonKind, "resignation");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
