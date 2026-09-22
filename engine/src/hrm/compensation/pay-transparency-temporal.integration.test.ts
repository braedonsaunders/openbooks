import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import {
  createJobFamily,
  createJobLevel,
  updateJobLevel,
} from "./architecture.ts";
import {
  computeGapSnapshot,
  fulfilPayInformationRequest,
  requestPayInformation,
} from "./pay-transparency.ts";

/**
 * F14 DB coverage (integration partition): fulfilment answers from the
 * latest snapshot covering the worker's category AS OF THAT SNAPSHOT'S
 * DATE — never from the worker's current assignment.
 *
 * A later promotion (or an ended assignment) must not misjoin fulfilment
 * onto the current level: the category resolves through effective-dated
 * assignment and position rows at each candidate snapshot date, newest
 * snapshot first, and the first covering snapshot answers. Stored
 * evidence (response_snapshot_id plus the reason JSON) pins which
 * snapshot date and level answered, so the response stays
 * self-consistent after later moves.
 *
 * Proofs are read back from storage, never from the service's own
 * return values alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Person ${id.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${id} where id = ${userId} and org_id = ${orgId}`);
  return id;
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function setCompensationSettings(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from orgs where id = ${orgId}`)).rows[0]?.settings ?? {};
  const next = {
    ...(current as Record<string, unknown>),
    compensation: { ...((current as Record<string, unknown>).compensation as Record<string, unknown> ?? {}), ...patch },
  };
  await db.execute(sql`update orgs set settings = ${JSON.stringify(next)}::jsonb where id = ${orgId}`);
}

type Harness = {
  org: ScratchOrg;
  hrId: string;
  workerId: string;
  workerEmploymentId: string;
  ic3Id: string;
  ic4Id: string;
};

async function seedLevels(orgId: string, hrId: string): Promise<{ ic3Id: string; ic4Id: string }> {
  const family = await createJobFamily({ orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const criteria = [
    { criterion: "skills", weight: "3" },
    { criterion: "effort", weight: "2" },
    { criterion: "responsibility", weight: "3" },
    { criterion: "working_conditions", weight: "1" },
  ];
  const ic3 = await createJobLevel({
    orgId, actorId: hrId, familyId: family.id, code: "IC3", name: "Engineer III",
    rank: 3, equalValueCriteria: criteria,
  });
  const ic4 = await createJobLevel({
    orgId, actorId: hrId, familyId: family.id, code: "IC4", name: "Engineer IV",
    rank: 4, equalValueCriteria: criteria,
  });
  return { ic3Id: ic3.id, ic4Id: ic4.id };
}

async function seedWorker(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  levelId: string,
  group: string,
  workerPartyId?: string,
  // Pre-set end of the initial primary slice (INSERT-only history: live
  // rows are append-only, so a bounded first slice is seeded bounded).
  assignmentTo?: string,
): Promise<{ employmentId: string; workerPartyId: string }> {
  const partyId = workerPartyId ?? randomUUID();
  if (!workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${partyId}, ${orgId}, 'person', ${`W ${partyId.slice(0, 6)}`}, true,
              ${JSON.stringify({ eeo_group: group })}::jsonb)
    `);
  } else {
    await db.execute(sql`
      update parties set custom = ${JSON.stringify({ eeo_group: group })}::jsonb
       where id = ${partyId} and org_id = ${orgId}`);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  const positionId = randomUUID();
  await db.execute(sql`
    insert into positions (id, org_id, position_code, revision)
    values (${positionId}, ${orgId}, ${`POS-${positionId.slice(0, 6)}`}, 1)
  `);
  await db.execute(sql`
    insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
      employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
    values (${orgId}, ${positionId}, 1, 'Engineer', null, null,
      ${subsidiaryId}, 1, 'filled', '2020-01-01', ${levelId})
  `);
  const assignmentId = randomUUID();
  await db.execute(sql`
    insert into employment_assignments (id, org_id, employment_id, assignment_key)
    values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
  `);
  await db.execute(sql`
    insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
      job_title, department_id, fte, is_primary, effective_from, effective_to, position_id)
    values (${orgId}, ${assignmentId}, ${employmentId}, 1,
      'Engineer', null, 1, true, '2020-01-01', ${assignmentTo ?? null}::date, ${positionId})
  `);
  const { withOrgTransaction } = await import("../../platform/db.ts");
  const { supersedeLaborCostRate } = await import("../../projects/labor-cost-rates.ts");
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId,
      scope: { employeePartyId: partyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: "2020-01-01",
      rate: group === "G1" ? "100000" : "80000",
      currency: "CAD",
      basis: "year",
      annualHours: "2080",
      notes: null,
      reason: "test wage",
    });
  });
  return { employmentId, workerPartyId: partyId };
}

/** Promote an employment to a fresh position at a new level (INSERT-only: the first slice was seeded ending `effectiveFrom`). */
async function promoteWorker(
  orgId: string,
  subsidiaryId: string,
  employmentId: string,
  newLevelId: string,
  effectiveFrom: string,
): Promise<void> {
  const slot = (await db.execute<{ assignment_id: string }>(sql`
    select id as assignment_id from employment_assignments
     where org_id = ${orgId} and employment_id = ${employmentId}`)).rows[0];
  assert.ok(slot, "primary assignment slot exists");
  const first = (await db.execute<{ effective_to: string | null }>(sql`
    select effective_to::text as effective_to from employment_assignment_versions
     where org_id = ${orgId} and assignment_id = ${slot.assignment_id}
       and is_primary and recorded_until is null and version_no = 1`)).rows[0];
  assert.equal(first?.effective_to, effectiveFrom, "the first slice was seeded ending at the promotion date");
  const positionId = randomUUID();
  await db.execute(sql`
    insert into positions (id, org_id, position_code, revision)
    values (${positionId}, ${orgId}, ${`POS-${positionId.slice(0, 6)}`}, 1)
  `);
  await db.execute(sql`
    insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
      employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
    values (${orgId}, ${positionId}, 1, 'Senior Engineer', null, null,
      ${subsidiaryId}, 1, 'filled', ${effectiveFrom}::date, ${newLevelId})
  `);
  await db.execute(sql`
    insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
      job_title, department_id, fte, is_primary, effective_from, position_id)
    values (${orgId}, ${slot.assignment_id}, ${employmentId}, 2,
      'Senior Engineer', null, 1, true, ${effectiveFrom}::date, ${positionId})
  `);
}

async function setupHarness(workerAssignmentTo?: string): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "Temporal HR", "temporal_hr");
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
  await linkPerson(org.orgId, hrId);
  await setCompensationSettings(org.orgId, {
    comparisonAttributeKey: "eeo_group",
    gapThresholdPct: 5,
    responseDays: 30,
  });
  const { ic3Id, ic4Id } = await seedLevels(org.orgId, hrId);
  const workerId = await createScratchUser(org.orgId, "Temporal Worker", "temporal_worker");
  await grantPermissions(org.orgId, workerId, ["hrm.self.request"]);
  const workerParty = await linkPerson(org.orgId, workerId);
  const workerEmp = await seedWorker(org.orgId, hrId, org.subsidiaryId, ic3Id, "G1", workerParty, workerAssignmentTo);
  return { org, hrId, workerId, workerEmploymentId: workerEmp.employmentId, ic3Id, ic4Id };
}

async function withHarness(fn: (h: Harness) => Promise<void>, workerAssignmentTo?: string): Promise<void> {
  if (!DB) return;
  const h = await setupHarness(workerAssignmentTo);
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function storedRequest(
  orgId: string,
  requestId: string,
): Promise<{ status: string; response_snapshot_id: string | null; reason: string | null }> {
  const row = (await db.execute<{ status: string; response_snapshot_id: string | null; reason: string | null }>(sql`
    select status, response_snapshot_id::text as response_snapshot_id, reason
      from hrm_pay_information_requests where org_id = ${orgId} and id = ${requestId}`)).rows[0];
  assert.ok(row, "request row is readable from storage");
  return row;
}

test("F14 a promotion after the snapshot answers the historical category, not the current one", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    // Both levels price both comparison sides, so the snapshot covers
    // IC3 and IC4 — the old code would answer the worker's CURRENT
    // level (IC4) from this same snapshot.
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G1");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G2");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic4Id, "G1");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic4Id, "G2");
    const snapshot = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    // Promoted AFTER the snapshot date: at the snapshot date the worker
    // was IC3, so the frozen IC3 averages answer — never today's IC4.
    await promoteWorker(h.org.orgId, h.org.subsidiaryId, h.workerEmploymentId, h.ic4Id, "2024-10-01");
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    const done = await fulfilPayInformationRequest({
      orgId: h.org.orgId, actorId: h.hrId, requestId: req.id,
    });
    assert.equal(done.status, "fulfilled");
    assert.equal(done.responseSnapshotId, snapshot.id);
    const averages = done.categoryAverages as Record<string, unknown>;
    assert.equal(averages.levelCode, "IC3");
    assert.equal(averages.levelId, h.ic3Id);
    assert.equal(averages.snapshotAsOf, "2024-06-01");
    // Stored evidence pins the same snapshot date and level identity.
    const stored = await storedRequest(h.org.orgId, req.id);
    assert.equal(stored.status, "fulfilled");
    assert.equal(stored.response_snapshot_id, snapshot.id);
    const reason = JSON.parse(stored.reason!) as Record<string, unknown>;
    assert.equal(reason.snapshotId, snapshot.id);
    assert.equal(reason.snapshotAsOf, "2024-06-01");
    assert.equal(reason.levelId, h.ic3Id);
    assert.equal(reason.levelCode, "IC3");
  }, "2024-10-01");
});

test("F14 an ended assignment still fulfils from historical coverage", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G1");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G2");
    const oldSnapshot = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    // The worker holds no assignment today — the old code refused — but
    // the assignment covered the older snapshot date, which still answers.
    // (The first slice was seeded ending 2024-07-01: an ended assignment
    // with no successor.)
    const newSnapshot = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-09-01", groupA: "G1", groupB: "G2",
    });
    assert.notEqual(newSnapshot.id, oldSnapshot.id);
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    const done = await fulfilPayInformationRequest({
      orgId: h.org.orgId, actorId: h.hrId, requestId: req.id,
    });
    assert.equal(done.status, "fulfilled");
    assert.equal(done.responseSnapshotId, oldSnapshot.id);
    assert.equal((done.categoryAverages as Record<string, unknown>).levelCode, "IC3");
    const stored = await storedRequest(h.org.orgId, req.id);
    assert.equal(stored.response_snapshot_id, oldSnapshot.id);
  }, "2024-07-01");
});

test("F14 the newest covering snapshot wins when the latest covers nothing of the worker", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G1");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G2");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic4Id, "G1");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic4Id, "G2");
    const oldSnapshot = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    // Retire IC3: the newer snapshot cannot cover it, so fulfilment
    // must fall back to the older covering snapshot — the old code
    // read only the latest row and refused.
    await updateJobLevel({
      orgId: h.org.orgId, actorId: h.hrId, levelId: h.ic3Id, isActive: false, reason: "test retire",
    });
    const newSnapshot = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-09-01", groupA: "G1", groupB: "G2",
    });
    assert.notEqual(newSnapshot.id, oldSnapshot.id);
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    const done = await fulfilPayInformationRequest({
      orgId: h.org.orgId, actorId: h.hrId, requestId: req.id,
    });
    assert.equal(done.status, "fulfilled");
    assert.equal(done.responseSnapshotId, oldSnapshot.id);
    assert.equal((done.categoryAverages as Record<string, unknown>).levelCode, "IC3");
  });
});

test("F14 same-as-of snapshots answer from the latest generated row", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G1");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic3Id, "G2");
    const first = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    const second = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    assert.notEqual(second.id, first.id);
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    const done = await fulfilPayInformationRequest({
      orgId: h.org.orgId, actorId: h.hrId, requestId: req.id,
    });
    assert.equal(done.status, "fulfilled");
    assert.equal(done.responseSnapshotId, second.id, "tied as-of dates resolve deterministically");
    const stored = await storedRequest(h.org.orgId, req.id);
    assert.equal(stored.response_snapshot_id, second.id);
  });
});

test("F14 an uncovered level refuses by name with the remedy and writes nothing", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic4Id, "G1");
    await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, h.ic4Id, "G2");
    // IC3 retires before the only snapshot: the worker's IC3 category
    // appears in no snapshot, so fulfilment refuses naming the level
    // and the existing remedy.
    await updateJobLevel({
      orgId: h.org.orgId, actorId: h.hrId, levelId: h.ic3Id, isActive: false, reason: "test retire",
    });
    await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    await assert.rejects(
      fulfilPayInformationRequest({ orgId: h.org.orgId, actorId: h.hrId, requestId: req.id }),
      /no snapshot covers this worker's category.*IC3.*compute a snapshot including their level/,
    );
    const stored = await storedRequest(h.org.orgId, req.id);
    assert.equal(stored.status, "open", "the refused fulfil wrote nothing");
    assert.equal(stored.response_snapshot_id, null);
  });
});
