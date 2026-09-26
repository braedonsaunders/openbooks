import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import {
  enableHrm,
  linkPerson,
  mkEmployment,
  mkHr,
  mkReporting,
  mkSecondSubsidiary,
} from "../../testing/hrm-harness.ts";
import { HrmPerformanceError } from "./errors.ts";
import {
  cancelOneOnOne,
  getOneOnOne,
  holdOneOnOne,
  listOneOnOneDirectory,
  listOneOnOnes,
  scheduleOneOnOne,
  skipOneOnOne,
} from "./one-on-ones.ts";

/**
 * AUTHZ-ROUTE-2: a 1:1 belongs to the report's employer subsidiary, and
 * the HR grant alone is never enough — every HR read and write applies
 * the actor's allowed subsidiary set to the report employment.
 * DB-owned (skips without OPENBOOKS_DB_URL, one file at a time).
 *
 * Every refusal asserts its code AND its message: the message is the
 * entire product of a failing check.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

// Shared HRM seeding helpers (feature flags, person links, scoped HR users,
// employments, reporting lines, second subsidiaries) live in
// engine/src/testing/hrm-harness.ts; only the pair seeder below stays local.

const ONE_ON_ONE_HR_PERMISSIONS = [
  "hrm.performance.read",
  "hrm.performance.manage",
  "hrm.self.read",
];

type Pair = {
  managerUserId: string;
  managerEmploymentId: string;
  reportUserId: string;
  reportEmploymentId: string;
};

async function mkPair(orgId: string, label: string, subsidiaryId: string): Promise<Pair> {
  const managerUserId = await createScratchUser(orgId, `Manager ${label}`, `one2one_manager_${label}`);
  const managerPartyId = await linkPerson(orgId, managerUserId);
  const managerEmploymentId = await mkEmployment(orgId, managerPartyId, subsidiaryId);
  const reportUserId = await createScratchUser(orgId, `Report ${label}`, `one2one_report_${label}`);
  const reportPartyId = await linkPerson(orgId, reportUserId);
  const reportEmploymentId = await mkEmployment(orgId, reportPartyId, subsidiaryId);
  await mkReporting(orgId, reportEmploymentId, managerEmploymentId);
  return { managerUserId, managerEmploymentId, reportUserId, reportEmploymentId };
}

type Harness = {
  orgId: string;
  subB: string;
  hrFull: string;
  hrA: string;
  a: Pair;
  b: Pair;
  oneA: string;
  oneB: string;
};

async function setupOneOnOneHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId, "hrmPerformance", "hrmOneOnOnes");
  const subB = await mkSecondSubsidiary(org.orgId, org.subsidiaryId);
  const hrFull = await mkHr(org.orgId, "HR Full", "one2one_hr_full", null, ONE_ON_ONE_HR_PERMISSIONS);
  const hrA = await mkHr(org.orgId, "HR A", "one2one_hr_a", [org.subsidiaryId], ONE_ON_ONE_HR_PERMISSIONS);
  const a = await mkPair(org.orgId, "a", org.subsidiaryId);
  const b = await mkPair(org.orgId, "b", subB);
  const oneA = (await scheduleOneOnOne({
    orgId: org.orgId, actorId: hrFull,
    managerEmploymentId: a.managerEmploymentId, reportEmploymentId: a.reportEmploymentId,
    scheduledAt: "2026-03-01T10:00:00Z",
  })).id;
  const oneB = (await scheduleOneOnOne({
    orgId: org.orgId, actorId: hrFull,
    managerEmploymentId: b.managerEmploymentId, reportEmploymentId: b.reportEmploymentId,
    scheduledAt: "2026-03-01T11:00:00Z",
  })).id;
  return { orgId: org.orgId, subB, hrFull, hrA, a, b, oneA, oneB };
}

test("a restricted HR lists and reads only the pairs they cover", { skip: !DB }, async () => {
  const h = await setupOneOnOneHarness();
  try {
    // The privileged list returns every 1:1 in the org only for
    // unrestricted HR; HR-A sees exactly the A pair.
    assert.deepEqual(
      (await listOneOnOnes({ orgId: h.orgId, actorId: h.hrA })).map((one) => one.id),
      [h.oneA],
    );
    assert.deepEqual(
      (await listOneOnOnes({ orgId: h.orgId, actorId: h.hrFull })).map((one) => one.id).sort(),
      [h.oneA, h.oneB].sort(),
    );
    // A cross-scope single read answers as missing, never as refused.
    await assert.rejects(
      getOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneB }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        return true;
      },
    );
    assert.equal((await getOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneA })).id, h.oneA);
    // The pair itself reads its own 1:1 without the grant.
    assert.equal((await getOneOnOne({ orgId: h.orgId, actorId: h.a.reportUserId, id: h.oneA })).id, h.oneA);
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("a restricted HR writes only the pairs they cover", { skip: !DB }, async () => {
  const h = await setupOneOnOneHarness();
  try {
    // Scheduling for a B report is refused by name; for an A report it lands.
    await assert.rejects(
      scheduleOneOnOne({
        orgId: h.orgId, actorId: h.hrA,
        managerEmploymentId: h.b.managerEmploymentId, reportEmploymentId: h.b.reportEmploymentId,
        scheduledAt: "2026-03-08T10:00:00Z",
      }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        assert.match(e.message, /not found/);
        return true;
      },
    );
    const scheduled = await scheduleOneOnOne({
      orgId: h.orgId, actorId: h.hrA,
      managerEmploymentId: h.a.managerEmploymentId, reportEmploymentId: h.a.reportEmploymentId,
      scheduledAt: "2026-03-08T10:00:00Z",
    });
    assert.equal(scheduled.reportEmploymentId, h.a.reportEmploymentId);
    // Hold, skip and cancel follow the same fence.
    await assert.rejects(
      holdOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneB }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        assert.match(e.message, /not found/);
        return true;
      },
    );
    assert.equal((await holdOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneA })).status, "held");
    await assert.rejects(
      skipOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneB, reason: "away" }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        assert.match(e.message, /not found/);
        return true;
      },
    );
    await assert.rejects(
      cancelOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneB }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "NOT_FOUND");
        assert.match(e.message, /not found/);
        return true;
      },
    );
    await cancelOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: scheduled.id });
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("a 1:1 write waits for the report employment scope lock", { skip: !DB }, async () => {
  const h = await setupOneOnOneHarness();
  let releaseHolder!: () => void;
  let reportLocked!: () => void;
  const hold = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
  const holder = withOrgTransaction(h.orgId, async () => {
    await db.execute(sql`
      select id from worker_employments
       where org_id = ${h.orgId} and id = ${h.a.reportEmploymentId}
       for update`);
    reportLocked();
    await hold;
  });
  try {
    await locked;
    let finished = false;
    const writing = holdOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneA }).finally(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(finished, false, "the write must wait until the report's locked employer has been rechecked");
    releaseHolder();
    await holder;
    assert.equal((await writing).status, "held");
  } finally {
    releaseHolder();
    await holder;
    await dropScratchOrg(h.orgId);
  }
});

test("a restricted HR's schedule directory covers only their subsidiaries", { skip: !DB }, async () => {
  const h = await setupOneOnOneHarness();
  try {
    const directory = await listOneOnOneDirectory({ orgId: h.orgId, actorId: h.hrA });
    const ids = new Set(directory.employments.map((row) => row.id));
    assert.ok(ids.has(h.a.managerEmploymentId));
    assert.ok(ids.has(h.a.reportEmploymentId));
    assert.ok(!ids.has(h.b.managerEmploymentId));
    assert.ok(!ids.has(h.b.reportEmploymentId));
    const full = await listOneOnOneDirectory({ orgId: h.orgId, actorId: h.hrFull });
    assert.equal(full.employments.length >= 4, true);
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("the self-service report filter shows nothing for a foreign employment", { skip: !DB }, async () => {
  const h = await setupOneOnOneHarness();
  try {
    // The /me page forwards ?report= straight into listOneOnOnes as an
    // employment filter: a manager probing another manager's report, or
    // a restricted HR probing across scope, lists nothing.
    assert.deepEqual(
      await listOneOnOnes({ orgId: h.orgId, actorId: h.a.managerUserId, employmentId: h.b.reportEmploymentId }),
      [],
    );
    assert.deepEqual(
      (await listOneOnOnes({ orgId: h.orgId, actorId: h.a.managerUserId, employmentId: h.a.reportEmploymentId })).map((one) => one.id),
      [h.oneA],
    );
    assert.deepEqual(
      await listOneOnOnes({ orgId: h.orgId, actorId: h.hrA, employmentId: h.b.reportEmploymentId }),
      [],
    );
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("a recurring 1:1 follows its weekday and local time across daylight saving", { skip: !DB }, async () => {
  const h = await setupOneOnOneHarness();
  try {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{timeZone}', '"America/New_York"'::jsonb, true)
       where id = ${h.orgId}`);
    const scheduled = await scheduleOneOnOne({
      orgId: h.orgId,
      actorId: h.hrFull,
      managerEmploymentId: h.a.managerEmploymentId,
      reportEmploymentId: h.a.reportEmploymentId,
      scheduledAt: "2026-03-02T15:00:00Z",
      recurrence: { every_weeks: 2, weekday: 3, time: "16:30" },
    });

    await skipOneOnOne({ orgId: h.orgId, actorId: h.hrFull, id: scheduled.id, reason: "reschedule" });
    const next = (await db.execute<{ scheduled_at: string }>(sql`
      select scheduled_at::text from hrm_one_on_ones
       where org_id = ${h.orgId} and series_id = ${scheduled.id} and status = 'scheduled'
    `)).rows[0];
    assert.ok(next, "skipping a recurring occurrence creates its next occurrence");
    assert.equal(new Date(next.scheduled_at).toISOString(), "2026-03-18T20:30:00.000Z");
  } finally {
    await dropScratchOrg(h.orgId);
  }
});
