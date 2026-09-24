import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { HrmPerformanceError } from "./errors.ts";
import { createCycle, closeCycle, moveToCalibrating, openCycle } from "./review-cycles.ts";
import { calibrateReview, reopenReview, shareReview, submitReview } from "./reviews.ts";
import {
  addCompetencyLevel,
  competencyProfileForEmployment,
  createCompetency,
  createFramework,
  setSectionCompetency,
} from "./competencies.ts";
import { createGoal } from "./goals.ts";
import { fulfillRequest, listFeedback, retractFeedback, writeFeedback } from "./feedback.ts";
import { getCycleDetail, getRetentionOverview, getReviewDetail, getTurnover, listCycleProgress, listMyReviews } from "./performance-read.ts";
import { getExitRecord, listExitRecords, recordExit, updateExitRecord } from "./exits.ts";

/**
 * g11_performance_exits: legal-entity scope across the performance module
 * plus the four exit-record behaviours. DB-owned (they skip without
 * OPENBOOKS_DB_URL, one file at a time).
 *
 * Every scope proof uses restricted A/B HR users (role subsidiary
 * restriction lists, permissions on the role so the grant and the scope
 * come from the same place): HR-A covers subsidiary A only, HR-B covers
 * subsidiary B only, HR-full is unrestricted. A cross-scope attempt must
 * fail; the same attempt inside the actor's scope must succeed.
 *
 * Every refusal asserts its code AND its message: the message is the
 * entire product of a failing check.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrmPerformance}', 'true'::jsonb, true)
     where id = ${orgId}`);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrmFeedback}', 'true'::jsonb, true)
     where id = ${orgId}`);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrmCompetencies}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function mkHr(
  orgId: string,
  name: string,
  roleKey: string,
  subsidiaryIds: string[] | null,
): Promise<string> {
  const userId = await createScratchUser(orgId, name, roleKey);
  await linkPerson(orgId, userId);
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.performance.read", "hrm.performance.manage", "hrm.retention.read", "hrm.self.read", "hrm.employment.read"]'::jsonb,
           subsidiary_restriction = ${subsidiaryIds === null ? JSON.stringify({ mode: "all" }) : JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
  return userId;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkVersion(orgId: string, employmentId: string, from: string, status = "active"): Promise<void> {
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${orgId}, ${employmentId}, 1, ${status}, ${from}::date)`);
}

async function mkReporting(orgId: string, employmentId: string, managerEmploymentId: string): Promise<void> {
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from)
    values (${orgId}, ${employmentId}, ${managerEmploymentId}, 'line', ${randomUUID()}, 1, '2020-01-01'::date)
  `);
}

async function mkSecondSubsidiary(orgId: string, parentId: string): Promise<string> {
  // One root per org: the scratch fixture already created it, so the
  // second legal entity hangs under the root like every other test entity.
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function mkTemplate(orgId: string, actorId: string): Promise<string> {
  const templateId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
    values (${orgId}, 'Annual', '{"min": 1, "max": 5, "labels": []}'::jsonb, ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  const sectionId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_template_sections (org_id, template_id, position, title, kind, created_by, updated_by)
    values (${orgId}, ${templateId}, 0, 'Impact', 'competency', ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into hrm_review_template_questions
      (org_id, section_id, position, prompt, answer_kind, required, created_by, updated_by)
    values (${orgId}, ${sectionId}, 0, 'Customer impact', 'rating_and_text', true, ${actorId}, ${actorId})
  `);
  return templateId;
}

async function mkChange(orgId: string, employmentId: string, kind: string, actorId: string): Promise<string> {
  // employment_changes carries a per-employment revision unique: successive
  // changes on one employment take the next revision, never a hardcoded 1.
  const next = (await db.execute<{ revision: number }>(sql`
    select coalesce(max(revision), 0) + 1 as revision from employment_changes
     where org_id = ${orgId} and employment_id = ${employmentId}`)).rows[0]!.revision;
  return (await db.execute<{ id: string }>(sql`
    insert into employment_changes (org_id, employment_id, revision, change_kind, prior_snapshot, reason, recorded_by)
    values (${orgId}, ${employmentId}, ${next}, ${kind}, '{}'::jsonb, 'test change', ${actorId})
    returning id`)).rows[0]!.id;
}

type Side = {
  userId: string;
  partyId: string;
  employmentId: string;
  managerUserId: string;
  managerPartyId: string;
  managerEmploymentId: string;
};

async function mkSide(orgId: string, label: string, subsidiaryId: string): Promise<Side> {
  const userId = await createScratchUser(orgId, `Worker ${label}`, `worker_${label}`);
  const partyId = await linkPerson(orgId, userId);
  const employmentId = await mkEmployment(orgId, partyId, subsidiaryId);
  await mkVersion(orgId, employmentId, "2020-01-01");
  const managerUserId = await createScratchUser(orgId, `Manager ${label}`, `manager_${label}`);
  const managerPartyId = await linkPerson(orgId, managerUserId);
  const managerEmploymentId = await mkEmployment(orgId, managerPartyId, subsidiaryId);
  await mkVersion(orgId, managerEmploymentId, "2020-01-01");
  await mkReporting(orgId, employmentId, managerEmploymentId);
  return { userId, partyId, employmentId, managerUserId, managerPartyId, managerEmploymentId };
}

type Harness = {
  org: ScratchOrg;
  subB: string;
  hrFull: string;
  hrA: string;
  hrB: string;
  a: Side;
  b: Side;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const subB = await mkSecondSubsidiary(org.orgId, org.subsidiaryId);
  const hrFull = await mkHr(org.orgId, "HR Full", "hr_full", null);
  const hrA = await mkHr(org.orgId, "HR A", "hr_a", [org.subsidiaryId]);
  const hrB = await mkHr(org.orgId, "HR B", "hr_b", [subB]);
  const a = await mkSide(org.orgId, "a", org.subsidiaryId);
  const b = await mkSide(org.orgId, "b", subB);
  return { org, subB, hrFull, hrA, hrB, a, b };
}

async function openScopedCycle(h: Harness): Promise<string> {
  const templateId = await mkTemplate(h.org.orgId, h.hrFull);
  const cycle = await createCycle({
    orgId: h.org.orgId,
    actorId: h.hrFull,
    templateId,
    name: "FY26 A-scope",
    periodStartOn: "2026-01-01",
    periodEndOn: "2026-06-30",
    appliesTo: { employer_subsidiary_id: h.org.subsidiaryId, department_id: null },
  });
  await openCycle({ orgId: h.org.orgId, actorId: h.hrFull, cycleId: cycle.id });
  return cycle.id;
}

async function managerReviewId(orgId: string, cycleId: string, employmentId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${orgId} and cycle_id = ${cycleId}
       and employment_id = ${employmentId} and kind = 'manager'`)).rows[0]!.id;
}

async function submitManagerReview(h: Harness, cycleId: string, side: Side): Promise<string> {
  const reviewId = await managerReviewId(h.org.orgId, cycleId, side.employmentId);
  const answerId = (await db.execute<{ id: string }>(sql`
    select id from hrm_review_answers where org_id = ${h.org.orgId} and review_id = ${reviewId}
     order by position limit 1`)).rows[0]!.id;
  await submitReview({
    orgId: h.org.orgId,
    actorId: side.managerUserId,
    reviewId,
    answers: [{ answerId, rating: "3", text: "meets expectations" }],
    overallRating: "3",
  });
  return reviewId;
}

test("a restricted HR calibrates and reopens only inside their legal-entity scope", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const cycleId = await openScopedCycle(h);
    const reviewId = await submitManagerReview(h, cycleId, h.a);
    // HR-B covers subsidiary B only: the A-side review is not theirs to touch.
    await assert.rejects(
      calibrateReview({
        orgId: h.org.orgId, actorId: h.hrB, reviewId, calibratedRating: "4", reason: "cross-scope attempt",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError);
        assert.match(e.message, /not visible in this organization and legal-entity scope/);
        return true;
      },
    );
    // HR-A covers it: calibration lands with the original rating intact.
    const calibrated = await calibrateReview({
      orgId: h.org.orgId, actorId: h.hrA, reviewId, calibratedRating: "4", reason: "exceeded in H2",
    });
    assert.equal(calibrated.calibratedRating, "4.0000");
    assert.equal(calibrated.overallRating, "3.0000");
    // Reopening follows the same scope: B refused, A succeeds.
    await assert.rejects(
      reopenReview({ orgId: h.org.orgId, actorId: h.hrB, reviewId, reason: "cross-scope reopen" }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError);
        assert.match(e.message, /not visible in this organization and legal-entity scope/);
        return true;
      },
    );
    const reopened = await reopenReview({
      orgId: h.org.orgId, actorId: h.hrA, reviewId, reason: "correct the rating",
    });
    assert.equal(reopened.status, "pending");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a restricted HR shares only inside their legal-entity scope", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const cycleId = await openScopedCycle(h);
    const reviewId = await submitManagerReview(h, cycleId, h.a);
    await assert.rejects(
      shareReview({ orgId: h.org.orgId, actorId: h.hrB, reviewId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError);
        assert.match(e.message, /not visible in this organization and legal-entity scope/);
        return true;
      },
    );
    const shared = await shareReview({ orgId: h.org.orgId, actorId: h.hrA, reviewId });
    assert.equal(shared.status, "shared");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a restricted HR reads only the feedback whose subject they cover", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    await writeFeedback({
      orgId: h.org.orgId, actorId: h.hrFull, subjectEmploymentId: h.a.employmentId,
      kind: "feedback", visibility: "manager_and_subject", body: "A-side feedback",
    });
    await writeFeedback({
      orgId: h.org.orgId, actorId: h.hrFull, subjectEmploymentId: h.b.employmentId,
      kind: "feedback", visibility: "manager_and_subject", body: "B-side feedback",
    });
    const seenByA = await listFeedback({ orgId: h.org.orgId, actorId: h.hrA });
    assert.deepEqual(seenByA.map((f) => f.body).sort(), ["A-side feedback"]);
    const seenByB = await listFeedback({ orgId: h.org.orgId, actorId: h.hrB });
    assert.deepEqual(seenByB.map((f) => f.body).sort(), ["B-side feedback"]);
    const seenByFull = await listFeedback({ orgId: h.org.orgId, actorId: h.hrFull });
    assert.deepEqual(seenByFull.map((f) => f.body).sort(), ["A-side feedback", "B-side feedback"]);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a restricted HR moves only the cycles they cover", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const cycleId = await openScopedCycle(h);
    // HR-B cannot force calibration on an A-scoped cycle — the scope
    // refusal fires before the pending-reviews refusal.
    await assert.rejects(
      moveToCalibrating({ orgId: h.org.orgId, actorId: h.hrB, cycleId, force: true, forceReason: "rush" }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError);
        assert.match(e.message, /not visible in this organization and legal-entity scope/);
        return true;
      },
    );
    await assert.rejects(
      closeCycle({ orgId: h.org.orgId, actorId: h.hrB, cycleId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError);
        assert.match(e.message, /not visible in this organization and legal-entity scope/);
        return true;
      },
    );
    const closed = await closeCycle({ orgId: h.org.orgId, actorId: h.hrA, cycleId });
    assert.equal(closed.status, "closed");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("restricted HR must choose a legal entity when creating a review cycle", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const templateId = await mkTemplate(h.org.orgId, h.hrFull);
    await assert.rejects(
      createCycle({
        orgId: h.org.orgId,
        actorId: h.hrA,
        templateId,
        name: "Unscoped FY26",
        periodStartOn: "2026-01-01",
        periodEndOn: "2026-06-30",
      }),
      (error: unknown) => {
        assert.ok(error instanceof HrmAuthorizationError);
        assert.match(error.message, /must name an employer subsidiary in their scope/);
        return true;
      },
    );
    const scoped = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrA,
      templateId,
      name: "A-scope FY26",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
      appliesTo: { employer_subsidiary_id: h.org.subsidiaryId, department_id: null },
    });
    assert.equal(scoped.appliesTo.employerSubsidiaryId, h.org.subsidiaryId);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("restricted HR cycle lists and details hide other subsidiaries and scope org-wide progress", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const templateId = await mkTemplate(h.org.orgId, h.hrFull);
    const cycleB = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrFull,
      templateId,
      name: "FY26 B-scope",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
      appliesTo: { employer_subsidiary_id: h.subB, department_id: null },
    });
    await openCycle({ orgId: h.org.orgId, actorId: h.hrFull, cycleId: cycleB.id });
    const orgCycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrFull,
      templateId,
      name: "FY26 org-wide",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
    });
    await openCycle({ orgId: h.org.orgId, actorId: h.hrFull, cycleId: orgCycle.id });

    const listed = await listCycleProgress({ orgId: h.org.orgId, actorId: h.hrA });
    assert.ok(!listed.some((cycle) => cycle.id === cycleB.id), "B-scoped cycle is not disclosed");
    const orgProgress = listed.find((cycle) => cycle.id === orgCycle.id);
    assert.ok(orgProgress, "the org-wide cycle remains visible");
    assert.equal(orgProgress.totalSelf, 2, "only A's worker and manager self reviews contribute");
    assert.equal(orgProgress.totalManager, 1, "only A's manager review contributes");

    const orgDetail = await getCycleDetail({ orgId: h.org.orgId, actorId: h.hrA, cycleId: orgCycle.id });
    assert.deepEqual(
      new Set(orgDetail.reviews.map((review) => review.employmentId)),
      new Set([h.a.employmentId, h.a.managerEmploymentId]),
    );
    await assert.rejects(
      getCycleDetail({ orgId: h.org.orgId, actorId: h.hrA, cycleId: cycleB.id }),
      (error: unknown) => {
        assert.ok(error instanceof HrmPerformanceError);
        assert.equal(error.code, "NOT_FOUND");
        return true;
      },
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("goal creation refuses a cycle whose scope excludes the subject employment", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const templateId = await mkTemplate(h.org.orgId, h.hrFull);
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrFull,
      templateId,
      name: "FY26 A-scope",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
      appliesTo: { employer_subsidiary_id: h.org.subsidiaryId, department_id: null },
    });
    // Worker B sits in subsidiary B: linking their goal to the A cycle is refused by name.
    await assert.rejects(
      createGoal({
        orgId: h.org.orgId, actorId: h.hrFull, employmentId: h.b.employmentId,
        title: "Ship the widget", cycleId: cycle.id,
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /outside the scope of review cycle/);
        return true;
      },
    );
    // Worker A sits inside it: the same call lands.
    const goal = await createGoal({
      orgId: h.org.orgId, actorId: h.hrFull, employmentId: h.a.employmentId,
      title: "Ship the widget", cycleId: cycle.id,
    });
    assert.equal(goal.cycleId, cycle.id);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("subject-facing reads strip the calibration justification; HR and reviewer keep it", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const cycleId = await openScopedCycle(h);
    const reviewId = await submitManagerReview(h, cycleId, h.a);
    await calibrateReview({
      orgId: h.org.orgId, actorId: h.hrFull, reviewId, calibratedRating: "4", reason: "private HR justification",
    });
    await shareReview({ orgId: h.org.orgId, actorId: h.a.managerUserId, reviewId });
    // The subject sees the calibrated rating with its share note — never the reason.
    const detail = await getCycleDetail({ orgId: h.org.orgId, actorId: h.a.userId, cycleId });
    const subjectView = detail.reviews.find((r) => r.id === reviewId)!;
    assert.equal(subjectView.calibratedRating, "4.0000");
    assert.equal(subjectView.calibrationReason, null);
    const mine = await listMyReviews({ orgId: h.org.orgId, actorId: h.a.userId });
    assert.equal(mine.asSubject.find((r) => r.id === reviewId)?.calibrationReason, null);
    const single = await getReviewDetail({ orgId: h.org.orgId, actorId: h.a.userId, reviewId });
    assert.equal(single.review.calibrationReason, null);
    // HR and the authoring reviewer keep the justification.
    const hrView = await getReviewDetail({ orgId: h.org.orgId, actorId: h.hrFull, reviewId });
    assert.equal(hrView.review.calibrationReason, "private HR justification");
    const hrCycle = await getCycleDetail({ orgId: h.org.orgId, actorId: h.hrFull, cycleId });
    assert.equal(hrCycle.reviews.find((r) => r.id === reviewId)?.calibrationReason, "private HR justification");
    const reviewerMine = await listMyReviews({ orgId: h.org.orgId, actorId: h.a.managerUserId });
    assert.equal(reviewerMine.asReviewer.find((r) => r.id === reviewId)?.calibrationReason, "private HR justification");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("fulfilling a request twice returns the one fulfilment", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const request = await writeFeedback({
      orgId: h.org.orgId, actorId: h.hrFull, subjectEmploymentId: h.a.employmentId,
      kind: "request", visibility: "manager_and_subject", body: "Tell me about the launch",
      requestedFromPartyId: h.a.managerPartyId,
    });
    const first = await fulfillRequest({
      orgId: h.org.orgId, actorId: h.a.managerUserId, requestId: request.id,
      visibility: "manager_and_subject", body: "They led the launch",
    });
    const second = await fulfillRequest({
      orgId: h.org.orgId, actorId: h.a.managerUserId, requestId: request.id,
      visibility: "manager_and_subject", body: "They led the launch",
    });
    assert.equal(second.id, first.id);
    const count = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_feedback
       where org_id = ${h.org.orgId} and kind = 'feedback'
         and context->>'fulfills_request_id' = ${request.id}`)).rows[0]!.n;
    assert.equal(count, "1");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a restricted HR retracts feedback only inside their legal-entity scope", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const onB = await writeFeedback({
      orgId: h.org.orgId, actorId: h.hrFull, subjectEmploymentId: h.b.employmentId,
      kind: "feedback", visibility: "manager_and_subject", body: "B-side note",
    });
    // HR-A holds the manage grant but covers A only: the B row answers
    // as missing, never as refused — they cannot read it, so from their
    // side there is nothing to retract.
    await assert.rejects(
      retractFeedback({ orgId: h.org.orgId, actorId: h.hrA, id: onB.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        assert.match(e.message, /another organization or already be retracted/);
        return true;
      },
    );
    // The covering HR retracts it; a second retraction names the state —
    // the row is in scope and readable, so the refusal says retracted,
    // never missing.
    await retractFeedback({ orgId: h.org.orgId, actorId: h.hrB, id: onB.id });
    await assert.rejects(
      retractFeedback({ orgId: h.org.orgId, actorId: h.hrB, id: onB.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "BAD_STATE");
        assert.match(e.message, /already retracted/);
        return true;
      },
    );
    // In-scope retraction by the restricted HR works on their own side.
    const onA = await writeFeedback({
      orgId: h.org.orgId, actorId: h.hrFull, subjectEmploymentId: h.a.employmentId,
      kind: "feedback", visibility: "manager_and_subject", body: "A-side note",
    });
    await retractFeedback({ orgId: h.org.orgId, actorId: h.hrA, id: onA.id });
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a restricted HR fulfils requests only inside their legal-entity scope", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const request = await writeFeedback({
      orgId: h.org.orgId, actorId: h.hrFull, subjectEmploymentId: h.b.employmentId,
      kind: "request", visibility: "manager_and_subject", body: "Tell me about the launch",
      requestedFromPartyId: h.b.managerPartyId,
    });
    // HR-A is neither the requested party nor the covering HR: refused,
    // and the refusal stores nothing.
    await assert.rejects(
      fulfillRequest({
        orgId: h.org.orgId, actorId: h.hrA, requestId: request.id,
        visibility: "manager_and_subject", body: "Out-of-scope answer",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "FORBIDDEN");
        assert.match(e.message, /only the requested party or HR may fulfil/);
        return true;
      },
    );
    const stored = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_feedback
       where org_id = ${h.org.orgId} and kind = 'feedback'
         and context->>'fulfills_request_id' = ${request.id}`)).rows[0]!.n;
    assert.equal(stored, "0");
    // The covering HR fulfils it.
    const answer = await fulfillRequest({
      orgId: h.org.orgId, actorId: h.hrB, requestId: request.id,
      visibility: "manager_and_subject", body: "They led the launch",
    });
    assert.equal(answer.subjectEmploymentId, h.b.employmentId);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

async function mkLeaver(
  h: Harness,
  label: string,
  subsidiaryId: string,
): Promise<{ employmentId: string }> {
  // Versions are append-only evidence — tests never update them either —
  // so a leaver is a fresh employment whose FIRST version is terminated,
  // exactly like the neighbouring exits test seeds them.
  const key = `leaver_${label.replace(/[^a-z0-9]+/gi, "_")}`;
  const userId = await createScratchUser(h.org.orgId, `Leaver ${label}`, key);
  const partyId = await linkPerson(h.org.orgId, userId);
  const employmentId = await mkEmployment(h.org.orgId, partyId, subsidiaryId);
  await mkVersion(h.org.orgId, employmentId, "2026-01-01", "terminated");
  return { employmentId };
}


test("a restricted HR reads only the exit records they cover", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const leaverA = await mkLeaver(h, "leaver-a", h.org.subsidiaryId);
    const leaverB = await mkLeaver(h, "leaver-b", h.subB);
    const exitA = await recordExit({
      orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaverA.employmentId,
      reasonKind: "resignation", isVoluntary: true,
    });
    const exitB = await recordExit({
      orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaverB.employmentId,
      reasonKind: "redundancy", isVoluntary: false,
    });
    // Cross-scope reads answer as missing, never as refused.
    await assert.rejects(
      getExitRecord({ orgId: h.org.orgId, actorId: h.hrA, exitId: exitB.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
    assert.equal((await getExitRecord({ orgId: h.org.orgId, actorId: h.hrA, exitId: exitA.id })).id, exitA.id);
    assert.deepEqual(
      (await listExitRecords({ orgId: h.org.orgId, actorId: h.hrA })).map((e) => e.id),
      [exitA.id],
    );
    assert.deepEqual(
      (await listExitRecords({ orgId: h.org.orgId, actorId: h.hrB })).map((e) => e.id),
      [exitB.id],
    );
    // Listed rows carry the revision the correction path requires.
    for (const row of await listExitRecords({ orgId: h.org.orgId, actorId: h.hrFull })) {
      assert.equal(row.revision, 1);
    }
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a divergent second fulfilment is refused, never silently dropped", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const request = await writeFeedback({
      orgId: h.org.orgId, actorId: h.hrFull, subjectEmploymentId: h.a.employmentId,
      kind: "request", visibility: "manager_and_subject", body: "Tell me about the launch",
      requestedFromPartyId: h.a.managerPartyId,
    });
    const first = await fulfillRequest({
      orgId: h.org.orgId, actorId: h.a.managerUserId, requestId: request.id,
      visibility: "manager_and_subject", body: "They led the launch",
    });
    // A changed body is a divergent answer: refused by name, naming the
    // prior fulfilment and the remedy — never dropped while reporting success.
    await assert.rejects(
      fulfillRequest({
        orgId: h.org.orgId, actorId: h.a.managerUserId, requestId: request.id,
        visibility: "manager_and_subject", body: "They sank the launch",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /already fulfilled/);
        assert.match(e.message, /write a new feedback entry instead/);
        return true;
      },
    );
    // A changed visibility, or the same words from a different author, diverges too.
    await assert.rejects(
      fulfillRequest({
        orgId: h.org.orgId, actorId: h.a.managerUserId, requestId: request.id,
        visibility: "manager_only", body: "They led the launch",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        return true;
      },
    );
    await assert.rejects(
      fulfillRequest({
        orgId: h.org.orgId, actorId: h.hrFull, requestId: request.id,
        visibility: "manager_and_subject", body: "They led the launch",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        return true;
      },
    );
    // The first answer stands alone and unchanged.
    const stored = (await db.execute<{ n: string; body: string }>(sql`
      select count(*)::text as n, min(body) as body from hrm_feedback
       where org_id = ${h.org.orgId} and kind = 'feedback'
         and context->>'fulfills_request_id' = ${request.id}`)).rows[0]!;
    assert.equal(stored.n, "1");
    assert.equal(stored.body, "They led the launch");
    assert.equal(first.body, "They led the launch");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("HR-A's turnover and overview count only A's leavers and gaps", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const leaverA = await mkLeaver(h, "t-a", h.org.subsidiaryId);
    await recordExit({
      orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaverA.employmentId,
      reasonKind: "resignation", isVoluntary: true,
      interviewHeldOn: "2026-02-01", interviewerPartyId: h.a.managerPartyId,
    });
    // B-side gaps HR-A must never see: a leaver with no exit record, and
    // an exit record with no interview.
    const leaverB1 = await mkLeaver(h, "t-b1", h.subB);
    const leaverB2 = await mkLeaver(h, "t-b2", h.subB);
    await recordExit({
      orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaverB2.employmentId,
      reasonKind: "redundancy", isVoluntary: false,
    });
    const periods = [{ start: "2025-01-01", end: "2027-01-01" }];
    const aTurnover = await getTurnover({ orgId: h.org.orgId, actorId: h.hrA, periods });
    assert.equal(
      aTurnover.periods.reduce((n, row) => n + row.terminations, 0),
      1,
      "HR-A's turnover counts only the A-side leaver",
    );
    const fullTurnover = await getTurnover({ orgId: h.org.orgId, actorId: h.hrFull, periods });
    assert.equal(
      fullTurnover.periods.reduce((n, row) => n + row.terminations, 0),
      3,
      "unrestricted HR keeps the org-wide turnover",
    );
    const aOverview = await getRetentionOverview({ orgId: h.org.orgId, actorId: h.hrA });
    assert.equal(aOverview.trailingTwelveMonths?.terminations, 1);
    assert.deepEqual(aOverview.missingExitRecords, []);
    assert.deepEqual(aOverview.exitRecordsWithoutInterview, []);
    const fullOverview = await getRetentionOverview({ orgId: h.org.orgId, actorId: h.hrFull });
    assert.equal(fullOverview.trailingTwelveMonths?.terminations, 3);
    assert.deepEqual(
      fullOverview.missingExitRecords.map((m) => m.employmentId),
      [leaverB1.employmentId],
    );
    assert.equal(fullOverview.exitRecordsWithoutInterview.length, 1);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("the termination link must be this employment's own termination", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const leaverA = await mkLeaver(h, "leaver-a", h.org.subsidiaryId);
    const leaverB = await mkLeaver(h, "leaver-b", h.subB);
    const otherTermination = await mkChange(h.org.orgId, leaverB.employmentId, "terminated", h.hrFull);
    const sameNonTermination = await mkChange(h.org.orgId, leaverA.employmentId, "status_changed", h.hrFull);
    // Another employment's termination is refused by name.
    await assert.rejects(
      recordExit({
        orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaverA.employmentId,
        terminationChangeId: otherTermination, reasonKind: "resignation", isVoluntary: true,
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /is not the termination of employment/);
        return true;
      },
    );
    // A non-terminating change on the same employment is refused too.
    await assert.rejects(
      recordExit({
        orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaverA.employmentId,
        terminationChangeId: sameNonTermination, reasonKind: "resignation", isVoluntary: true,
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /is not the termination of employment/);
        return true;
      },
    );
    // The employment's own termination links cleanly.
    const ownTermination = await mkChange(h.org.orgId, leaverA.employmentId, "terminated", h.hrFull);
    const exit = await recordExit({
      orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaverA.employmentId,
      terminationChangeId: ownTermination, reasonKind: "resignation", isVoluntary: true,
    });
    assert.equal(exit.terminationChangeId, ownTermination);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("corrections clear explicit nulls, require the read revision, and append audit events", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const leaver = await mkLeaver(h, "leaver", h.org.subsidiaryId);
    const exit = await recordExit({
      orgId: h.org.orgId, actorId: h.hrFull, employmentId: leaver.employmentId,
      reasonKind: "resignation", isVoluntary: true, notes: "Left for growth", destination: "Competition",
    });
    assert.equal(exit.revision, 1);
    // An explicit null clears; an omitted field keeps its value.
    const cleared = await updateExitRecord({
      orgId: h.org.orgId, actorId: h.hrFull, exitId: exit.id, expectedRevision: exit.revision,
      notes: null, reason: "notes were speculation",
    });
    assert.equal(cleared.notes, null);
    assert.equal(cleared.destination, "Competition");
    assert.equal(cleared.revision, 2);
    // A stale revision refuses instead of overwriting.
    await assert.rejects(
      updateExitRecord({
        orgId: h.org.orgId, actorId: h.hrFull, exitId: exit.id, expectedRevision: exit.revision,
        destination: "Elsewhere",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "BAD_STATE");
        assert.match(e.message, /at revision 2, not 1 — re-read it/);
        return true;
      },
    );
    // The audit trail holds the recording plus the correction, with
    // actor, before/after images, and the correction reason.
    const events = (await db.execute<{
      kind: string; actor: string | null; reason: string | null; before: unknown; after: unknown;
    }>(sql`
      select kind, actor_user_id::text as actor, reason,
             before_snapshot as before, after_snapshot as after
        from hrm_exit_record_events
       where org_id = ${h.org.orgId} and exit_record_id = ${exit.id}
       order by recorded_at`)).rows;
    assert.deepEqual(events.map((e) => e.kind), ["recorded", "corrected"]);
    assert.equal(events[1]!.actor, h.hrFull);
    assert.equal(events[1]!.reason, "notes were speculation");
    assert.equal((events[1]!.before as { notes: string }).notes, "Left for growth");
    assert.equal((events[1]!.after as { notes: null }).notes, null);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a restricted HR reads only the competency profiles they cover", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    // Org-wide cycle so both sides hold a calibrated, shared manager review.
    const templateId = await mkTemplate(h.org.orgId, h.hrFull);
    const sectionId = (await db.execute<{ id: string }>(sql`
      select id from hrm_review_template_sections
       where org_id = ${h.org.orgId} and template_id = ${templateId}`)).rows[0]!.id;
    const framework = await createFramework({
      orgId: h.org.orgId, actorId: h.hrFull, name: "Engineering",
    });
    const competency = await createCompetency({
      orgId: h.org.orgId, actorId: h.hrFull, frameworkId: framework.id,
      code: "IMPACT", name: "Customer impact",
    });
    await addCompetencyLevel({
      orgId: h.org.orgId, actorId: h.hrFull, competencyId: competency.id,
      levelRank: 1, label: "Meets", expectation: "Ships working software",
    });
    await setSectionCompetency({
      orgId: h.org.orgId, actorId: h.hrFull, sectionId, competencyId: competency.id,
    });
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrFull,
      templateId,
      name: "FY26 profile scope",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
    });
    await openCycle({ orgId: h.org.orgId, actorId: h.hrFull, cycleId: cycle.id });
    for (const side of [h.a, h.b]) {
      const reviewId = await submitManagerReview(h, cycle.id, side);
      await calibrateReview({
        orgId: h.org.orgId, actorId: h.hrFull, reviewId,
        calibratedRating: "4", reason: "exceeded in H2",
      });
      await shareReview({ orgId: h.org.orgId, actorId: h.hrFull, reviewId });
    }
    // HR-A covers subsidiary A only: the B employment's profile answers
    // as missing, never as refused.
    await assert.rejects(
      competencyProfileForEmployment({ orgId: h.org.orgId, actorId: h.hrA, employmentId: h.b.employmentId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError);
        assert.match(e.message, /not visible in this organization and legal-entity scope/);
        return true;
      },
    );
    await assert.rejects(
      competencyProfileForEmployment({ orgId: h.org.orgId, actorId: h.hrB, employmentId: h.a.employmentId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError);
        assert.match(e.message, /not visible in this organization and legal-entity scope/);
        return true;
      },
    );
    // Inside their own scope the same call lands with the assessed rating.
    const profileA = await competencyProfileForEmployment({
      orgId: h.org.orgId, actorId: h.hrA, employmentId: h.a.employmentId,
    });
    assert.equal(profileA.length, 1);
    assert.equal(profileA[0]!.sectionTitle, "Impact");
    assert.equal(profileA[0]!.assessedRating, "3.0000");
    assert.equal(profileA[0]!.levels.length, 1);
    // The subject and their line manager read their own slice without the grant.
    const own = await competencyProfileForEmployment({
      orgId: h.org.orgId, actorId: h.a.userId, employmentId: h.a.employmentId,
    });
    assert.equal(own.length, 1);
    const managed = await competencyProfileForEmployment({
      orgId: h.org.orgId, actorId: h.a.managerUserId, employmentId: h.a.employmentId,
    });
    assert.equal(managed.length, 1);
    // A stranger without the grant keeps the grant refusal.
    await assert.rejects(
      competencyProfileForEmployment({ orgId: h.org.orgId, actorId: h.b.userId, employmentId: h.a.employmentId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "FORBIDDEN");
        return true;
      },
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
