import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
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

async function enableOneOnOnes(orgId: string): Promise<void> {
  for (const feature of ["hrm", "hrmPerformance", "hrmOneOnOnes"]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}, 'true'::jsonb, true)
       where id = ${orgId}`);
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
       set permissions = '["hrm.performance.read", "hrm.performance.manage", "hrm.self.read"]'::jsonb,
           subsidiary_restriction = ${subsidiaryIds === null ? JSON.stringify({ mode: "all" }) : JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
  return userId;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkSecondSubsidiary(orgId: string, parentId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

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
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from)
    values (${orgId}, ${reportEmploymentId}, ${managerEmploymentId}, 'line', ${randomUUID()}, 1, '2020-01-01'::date)
  `);
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

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableOneOnOnes(org.orgId);
  const subB = await mkSecondSubsidiary(org.orgId, org.subsidiaryId);
  const hrFull = await mkHr(org.orgId, "HR Full", "one2one_hr_full", null);
  const hrA = await mkHr(org.orgId, "HR A", "one2one_hr_a", [org.subsidiaryId]);
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
  const h = await setupHarness();
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
  const h = await setupHarness();
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
        assert.equal(e.code, "FORBIDDEN");
        assert.match(e.message, /outside your allowed subsidiaries/);
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
        assert.equal(e.code, "FORBIDDEN");
        assert.match(e.message, /outside your allowed subsidiaries/);
        return true;
      },
    );
    assert.equal((await holdOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneA })).status, "held");
    await assert.rejects(
      skipOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneB, reason: "away" }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "FORBIDDEN");
        return true;
      },
    );
    await assert.rejects(
      cancelOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: h.oneB }),
      (e: unknown) => {
        assert.ok(e instanceof HrmPerformanceError);
        assert.equal(e.code, "FORBIDDEN");
        return true;
      },
    );
    await cancelOneOnOne({ orgId: h.orgId, actorId: h.hrA, id: scheduled.id });
  } finally {
    await dropScratchOrg(h.orgId);
  }
});

test("a restricted HR's schedule directory covers only their subsidiaries", { skip: !DB }, async () => {
  const h = await setupHarness();
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
  const h = await setupHarness();
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
