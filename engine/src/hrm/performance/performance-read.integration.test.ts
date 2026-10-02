import { sql } from "drizzle-orm";
import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg
} from "../../testing/fixtures.ts";
import {
  addLiveVersion,
  enableHrm,
  grant, mkEmployment,
  mkParty, mkVersion, performanceRefusal, setupPerformanceHarness, withHarness
} from "../../testing/hrm-harness.ts";
import { recordExit } from "./exits.ts";
import {
  getCycleDetail,
  getRetentionOverview,
  getReviewDetail,
  getTurnover,
  listCycleProgress,
  listGoals,
  listMyReviews,
} from "./performance-read.ts";
import { acknowledgeReview, shareReview, submitReview } from "./reviews.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const setupReadHarness = () => setupPerformanceHarness({ prefix: "Read", hrRole: "hrm_read_hr", permissions: ["hrm.performance.read", "hrm.performance.manage", "hrm.retention.read", "hrm.employment.read"], peer: true, template: { name: "Annual", scaleLabels: [] }, version: { versionNo: 1, from: "2020-01-01", status: "active", recordedAt: "2020-01-01T09:00:00Z" } });

async function answerId(orgId: string, reviewId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    select id from hrm_review_answers where org_id = ${orgId} and review_id = ${reviewId} order by position limit 1`)).rows[0]!.id;
}

test("the subject reads only shared reviews, a peer reads nothing", { skip: !DB }, async () => {
  await withHarness(() => setupReadHarness(), async (h) => {
    // Before sharing: the subject's own self review is submittable but the
    // manager review is invisible — NOT_FOUND, not forbidden.
    await assert.rejects(
      getReviewDetail({ orgId: h.org.orgId, actorId: h.workerUserId, reviewId: h.managerReviewId }),
      performanceRefusal("NOT_FOUND"),
    );
    await assert.rejects(
      getReviewDetail({ orgId: h.org.orgId, actorId: h.peerUserId, reviewId: h.managerReviewId }),
      performanceRefusal("NOT_FOUND"),
    );
    // Submit + share the manager review, then the subject reads it.
    await submitReview({
      orgId: h.org.orgId,
      actorId: h.managerUserId,
      reviewId: h.managerReviewId,
      answers: [{ answerId: await answerId(h.org.orgId, h.managerReviewId), rating: "4", text: "strong" }],
    });
    await shareReview({ orgId: h.org.orgId, actorId: h.managerUserId, reviewId: h.managerReviewId });
    const read = await getReviewDetail({ orgId: h.org.orgId, actorId: h.workerUserId, reviewId: h.managerReviewId });
    assert.equal(read.review.status, "shared");
    assert.equal(read.answers.length, 1);
    assert.equal(read.answers[0]!.rating, "4.0000");
    // The peer still reads nothing after sharing.
    await assert.rejects(
      getReviewDetail({ orgId: h.org.orgId, actorId: h.peerUserId, reviewId: h.managerReviewId }),
      performanceRefusal("NOT_FOUND"),
    );
    // HR reads everything, shared or not.
    const hrRead = await getReviewDetail({ orgId: h.org.orgId, actorId: h.hrId, reviewId: h.selfReviewId });
    assert.equal(hrRead.review.kind, "self");
  });
});

test("a manager reads only the reviews they author, never a report's self review", { skip: !DB }, async () => {
  await withHarness(() => setupReadHarness(), async (h) => {
    await submitReview({
      orgId: h.org.orgId,
      actorId: h.workerUserId,
      reviewId: h.selfReviewId,
      answers: [{ answerId: await answerId(h.org.orgId, h.selfReviewId), rating: "5", text: "great year" }],
    });
    // The manager did not author the self review and is not its subject:
    // invisible, even though it is their report's.
    await assert.rejects(
      getReviewDetail({ orgId: h.org.orgId, actorId: h.managerUserId, reviewId: h.selfReviewId }),
      performanceRefusal("NOT_FOUND"),
    );
    // Their own authored manager review reads fine while pending.
    const authored = await getReviewDetail({
      orgId: h.org.orgId,
      actorId: h.managerUserId,
      reviewId: h.managerReviewId,
    });
    assert.equal(authored.review.status, "pending");
    // The ungranted manager still gets the tab: the cycle lists with their
    // slice only — the manager review they author plus their OWN self
    // review (authored by them), never the report's self review.
    const cycles = await listCycleProgress({ orgId: h.org.orgId, actorId: h.managerUserId });
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0]!.scoped, true);
    assert.equal(cycles[0]!.totalManager, 1);
    assert.equal(cycles[0]!.totalSelf, 1);
    // A second manager of nobody sees no cycles at all.
    const cyclesPeer = await listCycleProgress({ orgId: h.org.orgId, actorId: h.peerUserId });
    assert.deepEqual(cyclesPeer, []);
  });
});

test("my reviews splits subject and reviewer inboxes", { skip: !DB }, async () => {
  await withHarness(() => setupReadHarness(), async (h) => {
    await submitReview({
      orgId: h.org.orgId,
      actorId: h.managerUserId,
      reviewId: h.managerReviewId,
      answers: [{ answerId: await answerId(h.org.orgId, h.managerReviewId), rating: "4", text: "strong" }],
    });
    await shareReview({ orgId: h.org.orgId, actorId: h.managerUserId, reviewId: h.managerReviewId });
    await acknowledgeReview({ orgId: h.org.orgId, actorId: h.workerUserId, reviewId: h.managerReviewId });
    const mine = await listMyReviews({ orgId: h.org.orgId, actorId: h.workerUserId });
    assert.equal(mine.asSubject.length, 1);
    assert.equal(mine.asSubject[0]!.status, "acknowledged");
    const mgr = await listMyReviews({ orgId: h.org.orgId, actorId: h.managerUserId });
    assert.ok(mgr.asReviewer.some((r) => r.id === h.managerReviewId));
    // Goals: the subject's own list, the manager's reports, HR's scope.
    const { createGoal } = await import("./goals.ts");
    await createGoal({
      orgId: h.org.orgId,
      actorId: h.workerUserId,
      employmentId: h.workerEmploymentId,
      title: "Learn calibration",
    });
    const own = await listGoals({ orgId: h.org.orgId, actorId: h.workerUserId });
    assert.equal(own.length, 1);
    const managed = await listGoals({ orgId: h.org.orgId, actorId: h.managerUserId });
    assert.equal(managed.length, 1);
    const peerGoals = await listGoals({ orgId: h.org.orgId, actorId: h.peerUserId });
    assert.deepEqual(peerGoals, []);
  });
});

test("an HR reader with an empty subsidiary scope sees no cycle reviews", { skip: !DB }, async () => {
  await withHarness(() => setupReadHarness(), async (h) => {
    await db.execute(sql`
      update app_roles
         set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb
       where org_id = ${h.org.orgId} and key = 'hrm_read_hr'
    `);
    const detail = await getCycleDetail({ orgId: h.org.orgId, actorId: h.hrId, cycleId: h.cycleId });
    assert.deepEqual(detail.reviews, []);
    assert.equal(detail.totalSelf, 0);
    assert.equal(detail.submittedSelf, 0);
    assert.equal(detail.totalManager, 0);
    assert.equal(detail.submittedManager, 0);
  });
});

test("turnover divides terminations by average headcount per period", { skip: !DB }, async () => {
  await withHarness(() => setupReadHarness(), async (h) => {
    // Fixed series: manager + worker in service from 2020; a leaver
    // terminated 2026-03-15 with service from 2024-03-15 (tenure 730 days:
    // two non-leap spans), voluntary + regrettable resignation with an
    // exit record. The termination closes through the canonical writer —
    // the closure guard refuses raw version updates by design.
    const leaverParty = await mkParty(h.org.orgId, "Leaver");
    const leaverEmployment = await mkEmployment(h.org.orgId, leaverParty, h.org.subsidiaryId);
    await mkVersion(h.org.orgId, leaverEmployment, {
      versionNo: 1, from: "2024-03-15", status: "active", recordedAt: "2024-03-15T09:00:00Z",
    });
    await addLiveVersion(h.org.orgId, leaverEmployment, {
      status: "terminated",
      from: "2026-03-15",
      recordedAt: "2026-03-16T09:00:00Z",
      sourceRef: "hr7-seed",
    });
    await recordExit({
      orgId: h.org.orgId,
      actorId: h.hrId,
      employmentId: leaverEmployment,
      reasonKind: "resignation",
      isVoluntary: true,
      isRegrettable: true,
    });
    const turnover = await getTurnover({
      orgId: h.org.orgId,
      actorId: h.hrId,
      periods: [{ start: "2026-01-01", end: "2026-06-30" }],
    });
    // Dept is null (no assignments): one row. Headcount 3 → 2 (average
    // 2.5), 1 voluntary regrettable leaver, tenure 731 days.
    assert.equal(turnover.periods.length, 1);
    const row = turnover.periods[0]!;
    assert.equal(row.headcountStart, 3);
    assert.equal(row.headcountEnd, 2);
    assert.equal(row.terminations, 1);
    assert.equal(row.voluntary, 1);
    assert.equal(row.involuntary, 0);
    assert.equal(row.regrettable, 1);
    assert.equal(row.turnoverRate, 1 / 2.5);
    assert.equal(row.regrettableShare, 1);
    assert.equal(row.medianTenureDays, 730);
    assert.equal(row.exitCoverage, 1);
    const missingParty = await mkParty(h.org.orgId, "Named Missing Exit");
    const missingEmployment = await mkEmployment(h.org.orgId, missingParty, h.org.subsidiaryId);
    await mkVersion(h.org.orgId, missingEmployment, {
      versionNo: 1, from: "2024-01-01", status: "active", recordedAt: "2024-01-01T09:00:00Z",
    });
    await addLiveVersion(h.org.orgId, missingEmployment, {
      status: "terminated",
      from: "2026-04-01",
      recordedAt: "2026-04-02T09:00:00Z",
      sourceRef: "hr7-seed",
    });
    const departmentId = (await db.execute<{ id: string }>(sql`
      insert into departments (org_id, name, subsidiary_id)
      values (${h.org.orgId}, 'Retention Department', ${h.org.subsidiaryId}) returning id
    `)).rows[0]!.id;
    const assignmentId = (await db.execute<{ id: string }>(sql`
      insert into employment_assignments (org_id, employment_id, assignment_key)
      values (${h.org.orgId}, ${missingEmployment}, 'primary') returning id
    `)).rows[0]!.id;
    await db.execute(sql`
      insert into employment_assignment_versions
        (org_id, assignment_id, employment_id, version_no, department_id, is_primary, effective_from)
      values (${h.org.orgId}, ${assignmentId}, ${missingEmployment}, 1, ${departmentId}, true, '2020-01-01')
    `);
    // Retention overview: trailing twelve months plus the gaps.
    const overview = await getRetentionOverview({ orgId: h.org.orgId, actorId: h.hrId });
    assert.equal(overview.regrettableLeavers, 1);
    assert.equal(overview.trailingTwelveMonths!.terminations, 2);
    assert.deepEqual(overview.missingExitRecords, [{
      employmentId: missingEmployment,
      workerPartyId: missingParty,
      workerName: "Named Missing Exit",
      departmentName: "Retention Department",
      terminatedFrom: "2026-04-01",
    }]);
    assert.deepEqual(overview.exitRecordsWithoutInterview.map((r) => r.employmentId), [leaverEmployment]);
  });
});

test("reads are invisible from a second organization", { skip: !DB }, async () => {
  const h = await setupReadHarness();
  const other = await createScratchOrg();
  try {
    await enableHrm(other.orgId);
    const otherHr = await createScratchUser(other.orgId, "Other HR", "other_hr");
    await grant(other.orgId, otherHr, ["hrm.performance.read", "hrm.retention.read", "hrm.employment.read"]);
    await assert.rejects(
      getReviewDetail({ orgId: other.orgId, actorId: otherHr, reviewId: h.managerReviewId }),
      performanceRefusal("NOT_FOUND"),
    );
    await assert.rejects(
      getCycleDetail({ orgId: other.orgId, actorId: otherHr, cycleId: h.cycleId }),
      performanceRefusal("NOT_FOUND"),
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
    await dropScratchOrg(other.orgId);
  }
});
