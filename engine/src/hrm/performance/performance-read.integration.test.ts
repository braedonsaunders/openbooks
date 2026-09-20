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
import { HrmPerformanceError } from "./errors.ts";
import { createCycle, openCycle } from "./review-cycles.ts";
import { acknowledgeReview, shareReview, submitReview } from "./reviews.ts";
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

/**
 * HR-7 privacy model and retention reads over the real 0196 tables —
 * DB-owned (they skip without OPENBOOKS_DB_URL, one file at a time).
 *
 * The privacy matrix: the subject reads only shared reviews, a peer reads
 * nothing, a manager reads only the reviews they author (never a report's
 * self review), HR reads everything, and a second org sees nothing. Every
 * unreadable id answers NOT_FOUND — never a refusal that confirms the row
 * exists. Turnover is proved on a fixed headcount series with leavers of
 * known tenure.
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

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function mkParty(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name) values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkVersion(
  orgId: string,
  employmentId: string,
  versionNo: number,
  from: string,
  status = "active",
  recordedAt: string | null = null,
): Promise<void> {
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at)
    values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date,
      ${recordedAt === null ? sql`now()` : sql`${recordedAt}::timestamptz`})`);
}

/**
 * Append one live version through the test-only canonical writer: the
 * prior live row closes with its evidence event in the same transaction,
 * exactly like the governed apply path. Raw version updates are refused
 * by the closure guard by design, so tests never write them either.
 */
async function addLiveVersion(
  orgId: string,
  employmentId: string,
  args: { status: string; from: string; to?: string | null; recordedAt?: string | null },
): Promise<void> {
  const maxRow = (await db.execute<{ n: number }>(sql`
    select coalesce(max(version_no), 0)::int as n from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
  `)).rows[0];
  const versionNo = (maxRow?.n ?? 0) + 1;
  await db.transaction(async (tx) => {
    await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`);
    // A fixture-recorded stamp (prompt recording, near effective) instead
    // of test-time now: turnover legs read as known at their own date, so
    // a now-stamped closure would hide the leaver from the start leg.
    const now = args.recordedAt ?? (await tx.execute<{ now: Date }>(sql`select now() as now`)).rows[0]!.now;
    const prior = (await tx.execute<{ id: string; version_no: number; before: unknown }>(sql`
      select id, version_no, to_jsonb(worker_employment_versions) as before
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
       order by version_no
    `)).rows;
    const newRevision = (await tx.execute<{ revision: number }>(sql`
      select revision from worker_employments where org_id = ${orgId} and id = ${employmentId}
    `)).rows[0]!.revision + 1;
    const changeId = (await tx.execute<{ id: string }>(sql`
      insert into employment_changes
        (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
         recorded_source, recorded_source_ref, closed_versions)
      values (${orgId}, ${employmentId}, ${newRevision},
              'corrected', '{}'::jsonb, 'test seed',
              'system', 'hr7-seed',
              ${JSON.stringify(prior.map((row) => ({
                table: "worker_employment_versions",
                identity: employmentId,
                version_no: row.version_no,
                row_id: row.id,
                before: row.before,
              })))}::jsonb)
      returning id
    `)).rows[0]!.id;
    for (const row of prior) {
      await tx.execute(sql`
        update worker_employment_versions
           set recorded_until = ${now}, superseded_by = ${versionNo}, closed_by_change_id = ${changeId}
         where id = ${row.id}
      `);
    }
    await tx.execute(sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${orgId}, ${employmentId}, ${versionNo}, ${args.status},
              ${args.from}::date, ${args.to ?? null}::date, ${now})
    `);
    await tx.execute(sql`
      update worker_employments set revision = ${newRevision}, updated_at = now()
       where org_id = ${orgId} and id = ${employmentId}
    `);
  });
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

type Harness = {
  org: ScratchOrg;
  hrId: string;
  managerUserId: string;
  managerEmploymentId: string;
  workerUserId: string;
  workerPartyId: string;
  workerEmploymentId: string;
  peerUserId: string;
  cycleId: string;
  selfReviewId: string;
  managerReviewId: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "HRM Read HR", "hrm_read_hr");
  await grant(org.orgId, hrId, [
    "hrm.performance.read",
    "hrm.performance.manage",
    "hrm.retention.read",
    "hrm.employment.read",
  ]);
  await linkPerson(org.orgId, hrId);
  const managerUserId = await createScratchUser(org.orgId, "Read Manager", "read_manager");
  const managerPartyId = await linkPerson(org.orgId, managerUserId);
  const managerEmploymentId = await mkEmployment(org.orgId, managerPartyId, org.subsidiaryId);
  await mkVersion(org.orgId, managerEmploymentId, 1, "2020-01-01", "active", "2020-01-01T09:00:00Z");
  const workerUserId = await createScratchUser(org.orgId, "Read Worker", "read_worker");
  const workerPartyId = await linkPerson(org.orgId, workerUserId);
  const workerEmploymentId = await mkEmployment(org.orgId, workerPartyId, org.subsidiaryId);
  await mkVersion(org.orgId, workerEmploymentId, 1, "2020-01-01", "active", "2020-01-01T09:00:00Z");
  await mkReporting(org.orgId, workerEmploymentId, managerEmploymentId);
  const peerUserId = await createScratchUser(org.orgId, "Read Peer", "read_peer");
  await linkPerson(org.orgId, peerUserId);
  const templateId = await mkTemplate(org.orgId, hrId);
  const cycle = await createCycle({
    orgId: org.orgId,
    actorId: hrId,
    templateId,
    name: "FY26",
    periodStartOn: "2026-01-01",
    periodEndOn: "2026-06-30",
  });
  await openCycle({ orgId: org.orgId, actorId: hrId, cycleId: cycle.id });
  const selfReviewId = (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${org.orgId} and cycle_id = ${cycle.id}
       and employment_id = ${workerEmploymentId} and kind = 'self'`)).rows[0]!.id;
  const managerReviewId = (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${org.orgId} and cycle_id = ${cycle.id}
       and employment_id = ${workerEmploymentId} and kind = 'manager'`)).rows[0]!.id;
  return {
    org, hrId, managerUserId, managerEmploymentId, workerUserId, workerPartyId,
    workerEmploymentId, peerUserId, cycleId: cycle.id, selfReviewId, managerReviewId,
  };
}

async function answerId(orgId: string, reviewId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    select id from hrm_review_answers where org_id = ${orgId} and review_id = ${reviewId} order by position limit 1`)).rows[0]!.id;
}

test("the subject reads only shared reviews, a peer reads nothing", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    // Before sharing: the subject's own self review is submittable but the
    // manager review is invisible — NOT_FOUND, not forbidden.
    await assert.rejects(
      getReviewDetail({ orgId: h.org.orgId, actorId: h.workerUserId, reviewId: h.managerReviewId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
    await assert.rejects(
      getReviewDetail({ orgId: h.org.orgId, actorId: h.peerUserId, reviewId: h.managerReviewId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
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
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
    // HR reads everything, shared or not.
    const hrRead = await getReviewDetail({ orgId: h.org.orgId, actorId: h.hrId, reviewId: h.selfReviewId });
    assert.equal(hrRead.review.kind, "self");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a manager reads only the reviews they author, never a report's self review", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
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
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
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
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("my reviews splits subject and reviewer inboxes", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
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
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("turnover divides terminations by average headcount per period", { skip: !DB }, async () => {
  const h = await setupHarness();
  try {
    // Fixed series: manager + worker in service from 2020; a leaver
    // terminated 2026-03-15 with service from 2024-03-15 (tenure 730 days:
    // two non-leap spans), voluntary + regrettable resignation with an
    // exit record. The termination closes through the canonical writer —
    // the closure guard refuses raw version updates by design.
    const leaverParty = await mkParty(h.org.orgId, "Leaver");
    const leaverEmployment = await mkEmployment(h.org.orgId, leaverParty, h.org.subsidiaryId);
    await mkVersion(h.org.orgId, leaverEmployment, 1, "2024-03-15", "active", "2024-03-15T09:00:00Z");
    await addLiveVersion(h.org.orgId, leaverEmployment, {
      status: "terminated",
      from: "2026-03-15",
      recordedAt: "2026-03-16T09:00:00Z",
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
    // Retention overview: trailing twelve months plus the gaps.
    const overview = await getRetentionOverview({ orgId: h.org.orgId, actorId: h.hrId });
    assert.equal(overview.regrettableLeavers, 1);
    assert.equal(overview.trailingTwelveMonths!.terminations, 1);
    assert.deepEqual(overview.missingExitRecords, []);
    assert.deepEqual(overview.exitRecordsWithoutInterview.map((r) => r.employmentId), [leaverEmployment]);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("reads are invisible from a second organization", { skip: !DB }, async () => {
  const h = await setupHarness();
  const other = await createScratchOrg();
  try {
    await enableHrm(other.orgId);
    const otherHr = await createScratchUser(other.orgId, "Other HR", "other_hr");
    await grant(other.orgId, otherHr, ["hrm.performance.read", "hrm.retention.read", "hrm.employment.read"]);
    await assert.rejects(
      getReviewDetail({ orgId: other.orgId, actorId: otherHr, reviewId: h.managerReviewId }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
    await assert.rejects(
      getCycleDetail({ orgId: other.orgId, actorId: otherHr, cycleId: h.cycleId }),
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
