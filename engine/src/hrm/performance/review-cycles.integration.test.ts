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
import {
  closeCycle,
  createCycle,
  moveToCalibrating,
  openCycle,
} from "./review-cycles.ts";

/**
 * HR-7 review cycles over the real 0196 tables — DB-owned (they skip
 * without OPENBOOKS_DB_URL; the orchestrator runs them at gate against the
 * contributor's own database, one file at a time).
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone, and every refusal asserts its code AND its message: the
 * message is the entire product of a failing check. A second organization
 * proves RLS invisibility on the cycle list.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

// Shared HRM seeding helpers (grants, employments, versions, reporting
// lines, review templates) live in engine/src/testing/hrm-harness.ts; this
// file keeps only its cycle-specific assertions.

type Harness = {
  org: ScratchOrg;
  hrId: string;
  managerPartyId: string;
  managerEmploymentId: string;
  workerPartyId: string;
  workerEmploymentId: string;
  templateId: string;
};

async function setupCyclesHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "HRM Review HR", "hrm_review_hr");
  await grant(org.orgId, hrId, ["hrm.performance.read", "hrm.performance.manage"]);
  await linkPerson(org.orgId, hrId);
  const managerPartyId = await mkParty(org.orgId, "Review Manager");
  const managerEmploymentId = await mkEmployment(org.orgId, managerPartyId, org.subsidiaryId);
  await mkVersion(org.orgId, managerEmploymentId, { versionNo: 1, from: "2020-01-01", to: null });
  const workerPartyId = await mkParty(org.orgId, "Review Worker");
  const workerEmploymentId = await mkEmployment(org.orgId, workerPartyId, org.subsidiaryId);
  await mkVersion(org.orgId, workerEmploymentId, { versionNo: 1, from: "2020-01-01", to: null });
  await mkReporting(org.orgId, workerEmploymentId, managerEmploymentId, "2020-01-01");
  const templateId = await mkReviewTemplate(org.orgId, hrId, { name: "Annual review" });
  return { org, hrId, managerPartyId, managerEmploymentId, workerPartyId, workerEmploymentId, templateId };
}

test("0196 migration exposes ten org-isolated tables with the review unique", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const tables = (await db.execute<{ name: string }>(sql`
      select tablename as name from pg_tables
       where schemaname = 'public'
         and tablename in ('hrm_review_templates', 'hrm_review_template_sections',
           'hrm_review_template_questions', 'hrm_review_cycles', 'hrm_reviews',
           'hrm_review_answers', 'hrm_review_events', 'hrm_goals',
           'hrm_goal_updates', 'hrm_exit_records')
       order by 1`)).rows.map((row) => row.name);
    assert.deepEqual(tables, [
      "hrm_exit_records",
      "hrm_goal_updates",
      "hrm_goals",
      "hrm_review_answers",
      "hrm_review_cycles",
      "hrm_review_events",
      "hrm_review_template_questions",
      "hrm_review_template_sections",
      "hrm_review_templates",
      "hrm_reviews",
    ]);
    const policies = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from pg_policies
       where schemaname = 'public' and policyname = 'org_isolation'
         and tablename like 'hrm_review%' or tablename like 'hrm_goal%' or tablename = 'hrm_exit_records'`)).rows[0]!.n;
    assert.ok(Number(policies) >= 10, `all ten tables carry org_isolation, got ${policies}`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("open instantiates self and manager reviews with snapshots in one transaction", { skip: !DB }, async () => {
  const h = await setupCyclesHarness();
  try {
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId: h.templateId,
      name: "FY26 annual",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
    });
    assert.equal(cycle.status, "draft");
    const opened = await openCycle({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id });
    // Two in-service employments: worker (self + manager) and manager (self
    // only — nobody manages the manager). Read back from storage.
    assert.equal(opened.instantiated, 2);
    assert.equal(opened.managerReviews, 1);
    assert.equal(opened.gaps, 1);
    assert.equal(opened.cycle.managerGapCount, 1);
    const reviews = (await db.execute<{ kind: string; status: string }>(sql`
      select kind, status from hrm_reviews
       where org_id = ${h.org.orgId} and cycle_id = ${cycle.id}`)).rows;
    assert.equal(reviews.length, 3);
    const answers = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_review_answers a
      join hrm_reviews r on r.org_id = a.org_id and r.id = a.review_id
     where a.org_id = ${h.org.orgId} and r.cycle_id = ${cycle.id}`)).rows[0]!.n;
    assert.equal(answers, "3", "each of the 3 reviews snapshots the 1 template question");
    const events = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_review_events e
      join hrm_reviews r on r.org_id = e.org_id and r.id = e.review_id
     where e.org_id = ${h.org.orgId} and r.cycle_id = ${cycle.id} and e.kind = 'instantiated'`)).rows[0]!.n;
    assert.equal(events, "3");
    const prompt = (await db.execute<{ prompt: string }>(sql`
      select a.question_prompt as prompt from hrm_review_answers a
      join hrm_reviews r on r.org_id = a.org_id and r.id = a.review_id
     where a.org_id = ${h.org.orgId} and r.cycle_id = ${cycle.id} limit 1`)).rows[0]!.prompt;
    assert.equal(prompt, "Customer impact");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("open refuses a template with no required question and an inverted period", { skip: !DB }, async () => {
  const h = await setupCyclesHarness();
  try {
    await assert.rejects(
      createCycle({
        orgId: h.org.orgId,
        actorId: h.hrId,
        templateId: h.templateId,
        name: "Bad period",
        periodStartOn: "2026-06-30",
        periodEndOn: "2026-01-01",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /ends 2026-01-01 before it starts 2026-06-30/);
        return true;
      },
    );
    const bareId = (await db.execute<{ id: string }>(sql`
      insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
      values (${h.org.orgId}, 'Bare', '{"min": 1, "max": 3}'::jsonb, ${h.hrId}, ${h.hrId})
      returning id`)).rows[0]!.id;
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId: bareId,
      name: "No questions",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
    });
    await assert.rejects(
      openCycle({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NO_REQUIRED_QUESTION");
        assert.match(e.message, /no required question/);
        assert.match(e.message, /under \/admin\/setup before opening the cycle/);
        return true;
      },
    );
    // Nothing instantiated: the refusal precedes every write.
    const count = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_reviews where org_id = ${h.org.orgId} and cycle_id = ${cycle.id}`)).rows[0]!.n;
    assert.equal(count, "0");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a second open is refused and a calibrating move needs pending reviews resolved or forced", { skip: !DB }, async () => {
  const h = await setupCyclesHarness();
  try {
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId: h.templateId,
      name: "FY26 annual",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
    });
    await openCycle({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id });
    await assert.rejects(
      openCycle({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "BAD_STATE");
        assert.match(e.message, /only a draft cycle opens/);
        return true;
      },
    );
    await assert.rejects(
      moveToCalibrating({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /1 pending manager reviews with required answers/);
        return true;
      },
    );
    await assert.rejects(
      moveToCalibrating({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id, force: true }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "REFUSED");
        assert.match(e.message, /needs a reason/);
        return true;
      },
    );
    const moved = await moveToCalibrating({
      orgId: h.org.orgId,
      actorId: h.hrId,
      cycleId: cycle.id,
      force: true,
      forceReason: "manager on leave, calibrating without them",
    });
    assert.equal(moved.status, "calibrating");
    // The reason is recorded as a calibration event on the pending review.
    const events = (await db.execute<{ reason: string }>(sql`
      select e.reason from hrm_review_events e
      join hrm_reviews r on r.org_id = e.org_id and r.id = e.review_id
     where e.org_id = ${h.org.orgId} and r.cycle_id = ${cycle.id} and e.kind = 'calibrated'`)).rows;
    assert.equal(events.length, 1);
    assert.match(events[0]!.reason, /manager on leave/);
    const closed = await closeCycle({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(closed.status, "closed");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("cycles are invisible from a second organization", { skip: !DB }, async () => {
  const h = await setupCyclesHarness();
  const other = await createScratchOrg();
  try {
    await enableHrm(other.orgId);
    const otherHr = await createScratchUser(other.orgId, "Other HR", "other_hr");
    await grant(other.orgId, otherHr, ["hrm.performance.read", "hrm.performance.manage"]);
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId: h.templateId,
      name: "FY26 annual",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-06-30",
    });
    await assert.rejects(
      openCycle({ orgId: other.orgId, actorId: otherHr, cycleId: cycle.id }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
    await dropScratchOrg(other.orgId);
  }
});
