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
import { SelfServiceError } from "./actor.ts";
import { HrmPerformanceError } from "../performance/errors.ts";
import { BenefitsError } from "../benefits/errors.ts";
import { createCycle, openCycle } from "../performance/review-cycles.ts";
import { calibrateReview, shareReview } from "../performance/reviews.ts";
import { createGoal } from "../performance/goals.ts";
import {
  acknowledgeMyReview,
  changeMyBenefit,
  electMyBenefit,
  getMyBenefitsWorkspace,
  getMyReviewWorkspace,
  loadManagerOwedReviews,
  selfWorkspaceCapabilities,
  submitMySelfAssessment,
  updateMyGoalProgress,
} from "./my-work.ts";

/**
 * HR-10 Me-workspace reviews and benefits DB coverage (integration
 * partition): the NO_LINK named refusal on every entry (never an empty
 * list), the reviews privacy scope (an unshared manager review is
 * invisible; calibration never reaches the subject even after sharing),
 * self writes through the existing services (submit, acknowledge, goal
 * progress), the benefits selfRequest election path under hrm.self.*
 * only (no hrm.benefits.* grant), the closed-window refusals on elect
 * and change, the hostile-employment-id refusals on every write, and the
 * manager's owed reviews in the open cycle.
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string, name: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  const employmentId = (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null)`);
  return employmentId;
}

async function mkReporting(orgId: string, employmentId: string, managerEmploymentId: string): Promise<void> {
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from)
    values (${orgId}, ${employmentId}, ${managerEmploymentId}, 'line', ${randomUUID()}, 1, '2020-01-01'::date)
  `);
}

async function mkTemplate(orgId: string, actorId: string): Promise<string> {
  const templateId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
    values (${orgId}, 'Annual review', '{"min": 1, "max": 5}'::jsonb, ${actorId}, ${actorId})
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

async function seedComponent(orgId: string, code: string, kind: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into pay_components (org_id, code, name, kind, is_active)
    values (${orgId}, ${code}, ${code}, ${kind}, true) returning id`)).rows[0]!.id;
}

async function seedPlan(orgId: string): Promise<string> {
  const ded = await seedComponent(orgId, `DED_${randomUUID().slice(0, 6)}`, "deduction");
  const er = await seedComponent(orgId, `ER_${randomUUID().slice(0, 6)}`, "employer_contribution");
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_benefit_plans
      (org_id, code, name, kind, currency, employee_cost_basis, employee_cost,
       employer_cost_basis, employer_cost, employee_pay_component_id,
       employer_pay_component_id, proration_basis, waiting_period_days,
       requires_approval, is_active, effective_from)
    values (${orgId}, ${`MED_${randomUUID().slice(0, 6)}`}, 'Health', 'health', 'USD',
            'per_month', '250.0000', 'per_month', '500.0000', ${ded}, ${er},
            'full_month', 0, false, true, '2020-01-01') returning id`)).rows[0]!.id;
}

async function seedWindow(orgId: string, status: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_enrollment_windows
      (org_id, name, kind, opens_on, closes_on, plan_year_start_on, applies_to, status)
    values (${orgId}, ${`Window ${randomUUID().slice(0, 6)}`}, 'open_enrollment',
            '2020-01-01'::date, '2030-12-31'::date, '2026-01-01'::date,
            '{}'::jsonb, ${status}) returning id`)).rows[0]!.id;
}

type Harness = {
  org: ScratchOrg;
  hrId: string;
  workerId: string;
  managerId: string;
  outsiderId: string;
  noLinkId: string;
  workerParty: string;
  managerParty: string;
  workerEmployment: string;
  managerEmployment: string;
  outsiderEmployment: string;
  cycleId: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "HR-10 HR", "hr10_hr");
  // The employee holds ONLY the self-service keys: no hrm.performance.*,
  // no hrm.benefits.*. Every self write below must succeed on those.
  const workerId = await createScratchUser(org.orgId, "HR-10 Worker", "hr10_worker");
  const managerId = await createScratchUser(org.orgId, "HR-10 Manager", "hr10_manager");
  const outsiderId = await createScratchUser(org.orgId, "HR-10 Outsider", "hr10_outsider");
  const noLinkId = await createScratchUser(org.orgId, "HR-10 NoLink", "hr10_nolink");
  await grant(org.orgId, hrId, ["hrm.performance.read", "hrm.performance.manage", "hrm.benefits.manage"]);
  await grant(org.orgId, workerId, ["hrm.self.read", "hrm.self.request"]);
  await grant(org.orgId, managerId, ["hrm.self.read", "hrm.self.request"]);
  await grant(org.orgId, outsiderId, ["hrm.self.read", "hrm.self.request"]);
  await grant(org.orgId, noLinkId, ["hrm.self.read", "hrm.self.request"]);
  await linkPerson(org.orgId, hrId, "HR-10 HR Person");
  const workerParty = await linkPerson(org.orgId, workerId, "HR-10 Worker Person");
  const managerParty = await linkPerson(org.orgId, managerId, "HR-10 Manager Person");
  const outsiderParty = await linkPerson(org.orgId, outsiderId, "HR-10 Outsider Person");
  const workerEmployment = await mkEmployment(org.orgId, workerParty, org.subsidiaryId);
  const managerEmployment = await mkEmployment(org.orgId, managerParty, org.subsidiaryId);
  const outsiderEmployment = await mkEmployment(org.orgId, outsiderParty, org.subsidiaryId);
  await mkReporting(org.orgId, workerEmployment, managerEmployment);
  const templateId = await mkTemplate(org.orgId, hrId);
  const cycle = await createCycle({
    orgId: org.orgId,
    actorId: hrId,
    templateId,
    name: "FY26 annual",
    periodStartOn: "2026-01-01",
    periodEndOn: "2026-06-30",
  });
  await openCycle({ orgId: org.orgId, actorId: hrId, cycleId: cycle.id });
  return {
    org, hrId, workerId, managerId, outsiderId, noLinkId,
    workerParty, managerParty, workerEmployment, managerEmployment, outsiderEmployment,
    cycleId: cycle.id,
  };
}

async function reviewRows(orgId: string, cycleId: string): Promise<Array<{ id: string; kind: string; status: string; reviewer: string; subject: string }>> {
  return (await db.execute<{ id: string; kind: string; status: string; reviewer: string; subject: string }>(sql`
    select id, kind, status,
           reviewer_party_id as reviewer, subject_party_id as subject
      from hrm_reviews where org_id = ${orgId} and cycle_id = ${cycleId}`)).rows;
}

async function answerIds(reviewId: string): Promise<string[]> {
  return (await db.execute<{ id: string }>(sql`
    select id from hrm_review_answers where review_id = ${reviewId} order by position`)).rows.map((r) => r.id);
}

test("an unlinked login gets the named NO_LINK refusal on every entry, never an empty list", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    for (const fn of [
      () => getMyReviewWorkspace({ orgId: h.org.orgId, actorId: h.noLinkId }),
      () => getMyBenefitsWorkspace({ orgId: h.org.orgId, actorId: h.noLinkId }),
      () => loadManagerOwedReviews({ orgId: h.org.orgId, actorId: h.noLinkId }),
      () => submitMySelfAssessment({ orgId: h.org.orgId, actorId: h.noLinkId, reviewId: randomUUID(), answers: [] }),
      () => acknowledgeMyReview({ orgId: h.org.orgId, actorId: h.noLinkId, reviewId: randomUUID() }),
      () => updateMyGoalProgress({ orgId: h.org.orgId, actorId: h.noLinkId, goalId: randomUUID(), progressPercent: 10 }),
      () => electMyBenefit({ orgId: h.org.orgId, actorId: h.noLinkId, employmentId: h.workerEmployment, planId: randomUUID(), effectiveFrom: "2026-03-01" }),
      () => changeMyBenefit({ orgId: h.org.orgId, actorId: h.noLinkId, enrollmentId: randomUUID(), changeDate: "2026-03-01", reason: "x" }),
    ]) {
      await assert.rejects(fn, (e: unknown) => {
        assert.ok(e instanceof SelfServiceError, `expected SelfServiceError, got ${String(e)}`);
        assert.equal(e.code, "NO_LINK");
        assert.match(e.message, /Admin → Users → Link person/);
        return true;
      });
    }
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("the workspace shows the owed self-assessment but never an unshared manager review", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const workspace = await getMyReviewWorkspace({ orgId: h.org.orgId, actorId: h.workerId });
    assert.equal(workspace.cycles.length, 1);
    const group = workspace.cycles[0]!;
    assert.equal(group.name, "FY26 annual");
    assert.ok(group.mySelf, "the instantiated self-assessment is owed");
    assert.equal(group.mySelf!.kind, "self");
    assert.equal(group.mySelf!.status, "pending");
    assert.equal(group.sharedWithMe.length, 0, "the pending manager review is invisible to its subject");
    // A second person's workspace names only their own slice: the
    // outsider sees the same cycle with their own self-assessment and
    // nothing of the worker's reviews.
    const outsider = await getMyReviewWorkspace({ orgId: h.org.orgId, actorId: h.outsiderId });
    assert.equal(outsider.cycles.length, 1);
    assert.ok(outsider.cycles[0]!.mySelf, "the outsider owes their own self-assessment");
    assert.equal(outsider.cycles[0]!.sharedWithMe.length, 0);
    assert.ok(
      outsider.cycles[0]!.mySelf!.id !== group.mySelf!.id,
      "slices never cross subjects",
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a shared manager review reaches the subject with calibration stripped", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const rows = await reviewRows(h.org.orgId, h.cycleId);
    const managerReview = rows.find((r) => r.kind === "manager" && r.subject === h.workerParty)!;
    const managerAnswers = await answerIds(managerReview.id);
    const { submitReview } = await import("../performance/reviews.ts");
    await submitReview({
      orgId: h.org.orgId, actorId: h.managerId, reviewId: managerReview.id,
      answers: managerAnswers.map((answerId) => ({ answerId, rating: "4", text: "Solid delivery" })),
      overallRating: "4",
    });
    await calibrateReview({ orgId: h.org.orgId, actorId: h.hrId, reviewId: managerReview.id, calibratedRating: "5", reason: "calibration round" });
    await shareReview({ orgId: h.org.orgId, actorId: h.managerId, reviewId: managerReview.id });
    const stored = (await db.execute<{ status: string; calibrated: string | null }>(sql`
      select status, calibrated_rating::text as calibrated from hrm_reviews where id = ${managerReview.id}`)).rows[0]!;
    assert.equal(stored.status, "shared");
    assert.equal(stored.calibrated, "5.0000");
    const workspace = await getMyReviewWorkspace({ orgId: h.org.orgId, actorId: h.workerId });
    const shared = workspace.cycles[0]!.sharedWithMe;
    assert.equal(shared.length, 1);
    assert.equal(shared[0]!.id, managerReview.id);
    assert.ok(!("calibratedRating" in shared[0]!), "calibration never reaches the subject");
    assert.ok(!("calibrationReason" in shared[0]!), "calibration reasons never reach the subject");
    assert.ok(!("managerGapCount" in workspace.cycles[0]!), "the calibration gap count never reaches the subject");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("submit and acknowledge ride the existing services with storage proof", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const rows = await reviewRows(h.org.orgId, h.cycleId);
    const selfReview = rows.find((r) => r.kind === "self" && r.subject === h.workerParty)!;
    const ids = await answerIds(selfReview.id);
    assert.ok(ids.length > 0, "openCycle snapshots the template answers");
    const submitted = await submitMySelfAssessment({
      orgId: h.org.orgId, actorId: h.workerId, reviewId: selfReview.id,
      answers: ids.map((answerId) => ({ answerId, rating: "4", text: "Strong quarter" })),
      overallRating: "4",
    });
    assert.equal(submitted.status, "submitted");
    const storedSelf = (await db.execute<{ status: string; overall: string | null }>(sql`
      select status, overall_rating::text as overall from hrm_reviews where id = ${selfReview.id}`)).rows[0]!;
    assert.equal(storedSelf.status, "submitted");
    assert.equal(storedSelf.overall, "4.0000");
    // Another person's review never submits: the service's reviewer
    // identity refuses, and the refusal names the remedy.
    const outsiderSelf = rows.find((r) => r.kind === "self" && r.subject !== h.workerParty && r.subject !== h.managerParty);
    if (outsiderSelf) {
      await assert.rejects(
        submitMySelfAssessment({ orgId: h.org.orgId, actorId: h.workerId, reviewId: outsiderSelf.id, answers: [] }),
        (e: unknown) => {
          assert.ok(e instanceof HrmPerformanceError);
          assert.equal(e.code, "FORBIDDEN");
          assert.match(e.message, /only its reviewer submits it/);
          return true;
        },
      );
    }
    const managerReview = rows.find((r) => r.kind === "manager" && r.subject === h.workerParty)!;
    const managerAnswers = await answerIds(managerReview.id);
    const { submitReview: submitAsReviewer } = await import("../performance/reviews.ts");
    await submitAsReviewer({
      orgId: h.org.orgId, actorId: h.managerId, reviewId: managerReview.id,
      answers: managerAnswers.map((answerId) => ({ answerId, rating: "4", text: "Solid delivery" })),
      overallRating: "4",
    });
    await shareReview({ orgId: h.org.orgId, actorId: h.managerId, reviewId: managerReview.id });
    const acknowledged = await acknowledgeMyReview({ orgId: h.org.orgId, actorId: h.workerId, reviewId: managerReview.id });
    assert.equal(acknowledged.status, "acknowledged");
    const storedAck = (await db.execute<{ status: string }>(sql`
      select status from hrm_reviews where id = ${managerReview.id}`)).rows[0]!;
    assert.equal(storedAck.status, "acknowledged");
    // Acknowledging a review shared with someone else refuses by identity.
    await assert.rejects(
      acknowledgeMyReview({ orgId: h.org.orgId, actorId: h.outsiderId, reviewId: managerReview.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.match(e.message, /only the subject acknowledges it/);
        return true;
      },
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("goal progress rides the existing service; another person's goal refuses", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const goal = await createGoal({ orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmployment, title: "Ship the migration" });
    const moved = await updateMyGoalProgress({ orgId: h.org.orgId, actorId: h.workerId, goalId: goal.id, progressPercent: 50, note: "halfway" });
    assert.equal(moved.progressPercent, 50);
    const stored = (await db.execute<{ progress: number; notes: string }>(sql`
      select progress_percent as progress,
             (select count(*)::text from hrm_goal_updates where goal_id = ${goal.id}) as notes
        from hrm_goals where id = ${goal.id}`)).rows[0]!;
    assert.equal(stored.progress, 50);
    assert.equal(stored.notes, "2", "creation plus the progress write both leave evidence");
    const workspace = await getMyReviewWorkspace({ orgId: h.org.orgId, actorId: h.workerId });
    assert.ok(workspace.goals.some((g) => g.id === goal.id && g.progressPercent === 50));
    const outsiderGoal = await createGoal({ orgId: h.org.orgId, actorId: h.outsiderId, employmentId: h.outsiderEmployment, title: "Theirs" });
    await assert.rejects(
      updateMyGoalProgress({ orgId: h.org.orgId, actorId: h.workerId, goalId: outsiderGoal.id, progressPercent: 10 }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError, `expected HrmAuthorizationError, got ${String(e)}`);
        return true;
      },
    );
    const untouched = (await db.execute<{ progress: number }>(sql`
      select progress_percent as progress from hrm_goals where id = ${outsiderGoal.id}`)).rows[0]!;
    assert.equal(untouched.progress, 0, "the refused write moved nothing");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("the manager owes pending reviews for direct reports in the open cycle", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const owed = await loadManagerOwedReviews({ orgId: h.org.orgId, actorId: h.managerId });
    assert.equal(owed.length, 1);
    assert.equal(owed[0]!.employmentId, h.workerEmployment);
    assert.equal(owed[0]!.kind, "manager");
    assert.equal(owed[0]!.status, "pending");
    assert.equal(owed[0]!.cycleName, "FY26 annual");
    assert.match(owed[0]!.drawerHref, /\/hrm\/performance\?cycle=.*&review=/);
    // A report-less caller owes nothing: empty is a fact, never a refusal.
    assert.deepEqual(await loadManagerOwedReviews({ orgId: h.org.orgId, actorId: h.workerId }), []);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("self-service elects inside an open window on the self keys alone, with stored amounts", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const planId = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId, "open");
    await db.execute(sql`
      insert into hrm_benefit_dependents (org_id, employment_id, relationship, display_name, is_active)
      values (${h.org.orgId}, ${h.workerEmployment}, 'spouse', 'Alex Worker', true)`);
    const elected = await electMyBenefit({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmployment,
      planId, windowId, effectiveFrom: "2026-03-01",
    });
    assert.equal(elected.status, "active");
    const stored = (await db.execute<{ employee: string; employer: string; currency: string }>(sql`
      select employee_amount_per_period::text as employee,
             employer_amount_per_period::text as employer, currency
        from hrm_benefit_enrollments where id = ${elected.id}`)).rows[0]!;
    assert.equal(stored.employee, "250.0000", "the stored plan amount is what payroll deducts");
    assert.equal(stored.employer, "500.0000");
    assert.equal(stored.currency, "USD");
    const workspace = await getMyBenefitsWorkspace({ orgId: h.org.orgId, actorId: h.workerId });
    assert.equal(workspace.elections.length, 1);
    assert.equal(workspace.elections[0]!.employeeAmountPerPeriod, "250.0000");
    assert.equal(workspace.openWindows.length, 1);
    assert.equal(workspace.dependents.length, 1);
    assert.equal(workspace.dependents[0]!.displayName, "Alex Worker");
    assert.ok(workspace.plans.some((p) => p.id === planId));
    // Another employment's elections never list: the outsider sees none.
    const outsider = await getMyBenefitsWorkspace({ orgId: h.org.orgId, actorId: h.outsiderId });
    assert.equal(outsider.elections.length, 0);
    assert.equal(outsider.dependents.length, 0);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a closed window refuses elect and change by name; another employment id refuses", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const planId = await seedPlan(h.org.orgId);
    const closedId = await seedWindow(h.org.orgId, "closed");
    // Electing against a closed window: the entry gate refuses by name.
    await assert.rejects(
      electMyBenefit({
        orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmployment,
        planId, windowId: closedId, effectiveFrom: "2026-03-01",
      }),
      (e: unknown) => {
        assert.ok(e instanceof BenefitsError, `expected BenefitsError, got ${String(e)}`);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /enrollment window is closed/);
        return true;
      },
    );
    // Electing with no window and no life event refuses the same way.
    await assert.rejects(
      electMyBenefit({
        orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmployment,
        planId, effectiveFrom: "2026-03-01",
      }),
      (e: unknown) => {
        assert.ok(e instanceof BenefitsError);
        assert.match(e.message, /no open window and no life event/);
        return true;
      },
    );
    // The hostile employment id: another person's employment never elects.
    const openId = await seedWindow(h.org.orgId, "open");
    await assert.rejects(
      electMyBenefit({
        orgId: h.org.orgId, actorId: h.workerId, employmentId: h.outsiderEmployment,
        planId, windowId: openId, effectiveFrom: "2026-03-01",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmAuthorizationError, `expected HrmAuthorizationError, got ${String(e)}`);
        assert.match(e.message, /only against your own employment/);
        return true;
      },
    );
    const none = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_benefit_enrollments where org_id = ${h.org.orgId}`)).rows[0]!.n;
    assert.equal(none, "0", "every refused elect wrote nothing");
    // A live election changes inside the window and refuses outside it.
    const elected = await electMyBenefit({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmployment,
      planId, windowId: openId, effectiveFrom: "2026-03-01",
    });
    await db.execute(sql`
      update hrm_enrollment_windows set status = 'closed' where id = ${openId}`);
    await assert.rejects(
      changeMyBenefit({ orgId: h.org.orgId, actorId: h.workerId, enrollmentId: elected.id, changeDate: "2026-04-01", reason: "family grows" }),
      (e: unknown) => {
        assert.ok(e instanceof SelfServiceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /no open enrollment window covers 2026-04-01/);
        return true;
      },
    );
    await db.execute(sql`
      update hrm_enrollment_windows set status = 'open' where id = ${openId}`);
    const changed = await changeMyBenefit({ orgId: h.org.orgId, actorId: h.workerId, enrollmentId: elected.id, changeDate: "2026-04-01", reason: "family grows" });
    assert.equal(changed.status, "active");
    const chain = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_benefit_enrollments
       where org_id = ${h.org.orgId} and employment_id = ${h.workerEmployment}`)).rows[0]!.n;
    assert.equal(chain, "2", "the change ends the old row and opens the new one");
    // Another person's enrollment never changes through this path.
    await assert.rejects(
      changeMyBenefit({ orgId: h.org.orgId, actorId: h.outsiderId, enrollmentId: changed.id, changeDate: "2026-05-01", reason: "spoof" }),
      (e: unknown) => {
        assert.ok(e instanceof SelfServiceError);
        assert.equal(e.code, "FORBIDDEN");
        return true;
      },
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("tab capabilities read facts: cycles and plans present here, absent on a fresh org", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    const caps = await selfWorkspaceCapabilities(h.org.orgId);
    assert.equal(caps.hasReviewCycles, true);
    assert.equal(caps.hasBenefitPlans, false);
    const fresh = await createScratchOrg();
    try {
      await enableHrm(fresh.orgId);
      assert.deepEqual(await selfWorkspaceCapabilities(fresh.orgId), { hasReviewCycles: false, hasBenefitPlans: false });
    } finally {
      await dropScratchOrg(fresh.orgId);
    }
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
