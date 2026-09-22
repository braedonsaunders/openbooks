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
} from "./architecture.ts";
import {
  compaRatioFor,
  createPayBand,
} from "./bands.ts";

/**
 * F15: band placement is a single-subject salary surface.
 *
 * compaRatioFor used to void actorId and return current salary/compaRatio
 * for any same-org employment, so an arbitrary employmentId under a broad
 * read grant leaked a scoped subsidiary's wage through compaRatio and the
 * band target. The read now rides the canonical per-employment
 * compensation gate (hrm.compensation.read plus the trusted
 * employer-subsidiary scope), with a fall-through to the actor's own
 * employment through hrm.self.read so a restricted HR lens never removes
 * self-service. Unknown, foreign, and hidden employments refuse with the
 * uniform not-visible message — never wage content.
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

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

/** Positioned employment (primary assignment on a level) plus its payroll-side wage. */
async function seedPlacedEmployment(
  orgId: string,
  hrId: string,
  subsidiaryId: string,
  levelId: string,
  rate: string,
  workerPartyId?: string,
): Promise<{ employmentId: string; workerPartyId: string }> {
  let party = workerPartyId;
  if (!party) {
    party = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${party}, ${orgId}, 'person', 'Placed Worker', true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${party}, ${subsidiaryId}, 1)
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
      job_title, department_id, fte, is_primary, effective_from, position_id)
    values (${orgId}, ${assignmentId}, ${employmentId}, 1,
      'Engineer', null, 1, true, '2020-01-01', ${positionId})
  `);
  const { withOrgTransaction } = await import("../../platform/db.ts");
  const { supersedeLaborCostRate } = await import("../../projects/labor-cost-rates.ts");
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId: hrId,
      scope: { employeePartyId: party, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: "2020-01-01",
      rate,
      currency: "CAD",
      basis: "year",
      annualHours: "2080",
      notes: null,
      reason: "test wage",
    });
  });
  return { employmentId, workerPartyId: party };
}

/** Exact refusal identity (code plus message): unknown, foreign, and hidden ids must match fully. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { code: typeof code === "string" ? code : (e as Error).name, message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

type Harness = {
  org: ScratchOrg;
  subB: string;
  hrId: string;
  analystId: string;
  readerAId: string;
  readerNoneId: string;
  ownerBId: string;
  mixedId: string;
  strangerId: string;
  empA: { employmentId: string; workerPartyId: string };
  empB: { employmentId: string; workerPartyId: string };
  ownB: { employmentId: string; workerPartyId: string };
  mixedOwn: { employmentId: string; workerPartyId: string };
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "Place HR", "place_hr");
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
  await linkPerson(org.orgId, hrId);
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
      from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  const family = await createJobFamily({ orgId: org.orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const level = await createJobLevel({
    orgId: org.orgId, actorId: hrId, familyId: family.id, code: "IC3", name: "Engineer III", rank: 3,
    equalValueCriteria: [{ criterion: "skills", weight: "3" }],
  });
  await createPayBand({
    orgId: org.orgId, actorId: hrId,
    scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
    currency: "CAD", basis: "annual", min: "80000", target: "100000", max: "120000",
    effectiveFrom: "2020-01-01", reason: "test band",
  });
  const empA = await seedPlacedEmployment(org.orgId, hrId, org.subsidiaryId, level.id, "90000");
  const empB = await seedPlacedEmployment(org.orgId, hrId, subB, level.id, "100000");
  // Unrestricted analyst: compensation read only, deliberately WITHOUT
  // hrm.employment.read — placement must not demand the record grant.
  const analystId = await createScratchUser(org.orgId, "Place Analyst", "place_analyst");
  await grantPermissions(org.orgId, analystId, ["hrm.compensation.read"]);
  await linkPerson(org.orgId, analystId);
  const readerAId = await createScratchUser(org.orgId, "Place Reader A", "place_reader_a");
  await scopeRole(org.orgId, "place_reader_a", ["hrm.compensation.read"], [org.subsidiaryId]);
  await linkPerson(org.orgId, readerAId);
  const readerNoneId = await createScratchUser(org.orgId, "Place Reader None", "place_reader_none");
  await scopeRole(org.orgId, "place_reader_none", ["hrm.compensation.read"], []);
  await linkPerson(org.orgId, readerNoneId);
  // Self-service owner whose own employment sits in subsidiary B.
  const ownerBId = await createScratchUser(org.orgId, "Place Owner B", "place_owner_b");
  await grantPermissions(org.orgId, ownerBId, ["hrm.self.read"]);
  const ownerParty = await linkPerson(org.orgId, ownerBId);
  const ownB = await seedPlacedEmployment(org.orgId, hrId, subB, level.id, "95000", ownerParty);
  // Mixed grants: restricted HR lens over A plus self.read, own in B.
  const mixedId = await createScratchUser(org.orgId, "Place Mixed", "place_mixed");
  await scopeRole(org.orgId, "place_mixed", ["hrm.compensation.read"], [org.subsidiaryId]);
  await grantPermissions(org.orgId, mixedId, ["hrm.self.read"]);
  const mixedParty = await linkPerson(org.orgId, mixedId);
  const mixedOwn = await seedPlacedEmployment(org.orgId, hrId, subB, level.id, "96000", mixedParty);
  const strangerId = await createScratchUser(org.orgId, "Place Stranger", "place_stranger");
  await linkPerson(org.orgId, strangerId);
  return { org, subB, hrId, analystId, readerAId, readerNoneId, ownerBId, mixedId, strangerId, empA, empB, ownB, mixedOwn };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  if (!DB) return;
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

const AS_OF = "2024-06-01";

test("F15 unrestricted analyst reads placement without employment.read", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const placed = await compaRatioFor(h.org.orgId, h.analystId, h.empA.employmentId, AS_OF);
    assert.equal(placed.placement, "in_range");
    assert.equal(placed.compaRatio, "0.9000000000");
    assert.equal(placed.currentRate, "90000.0000");
    // Unknown ids refuse as not-found through the same gate.
    await assert.rejects(
      compaRatioFor(h.org.orgId, h.analystId, randomUUID(), AS_OF),
      /not visible in this organization/,
    );
  });
});

test("F15 restricted lens hides another subsidiary as uniform not-found", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const seen = await compaRatioFor(h.org.orgId, h.readerAId, h.empA.employmentId, AS_OF);
    assert.equal(seen.compaRatio, "0.9000000000");
    const unknown = await refusalOf(compaRatioFor(h.org.orgId, h.readerAId, randomUUID(), AS_OF));
    const hidden = await refusalOf(compaRatioFor(h.org.orgId, h.readerAId, h.empB.employmentId, AS_OF));
    assert.deepEqual(hidden, unknown);
    assert.equal(hidden.code, "NOT_FOUND");
    // The refusal carries no wage content from either subsidiary.
    assert.ok(!hidden.message.includes("90000"));
    assert.ok(!hidden.message.includes("100000"));
  });
});

test("F15 empty lens refuses every employment identically", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const unknown = await refusalOf(compaRatioFor(h.org.orgId, h.readerNoneId, randomUUID(), AS_OF));
    assert.deepEqual(await refusalOf(compaRatioFor(h.org.orgId, h.readerNoneId, h.empA.employmentId, AS_OF)), unknown);
    assert.deepEqual(await refusalOf(compaRatioFor(h.org.orgId, h.readerNoneId, h.empB.employmentId, AS_OF)), unknown);
    assert.equal(unknown.code, "NOT_FOUND");
  });
});

test("F15 no-grant stranger is refused without learning existence or wages", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const unknown = await refusalOf(compaRatioFor(h.org.orgId, h.strangerId, randomUUID(), AS_OF));
    const real = await refusalOf(compaRatioFor(h.org.orgId, h.strangerId, h.empA.employmentId, AS_OF));
    // Same refusal for a real employment as for a fabricated id: the
    // stranger learns neither existence nor wage coverage, and the
    // message names the remedy that exists.
    assert.deepEqual(real, unknown);
    assert.equal(real.code, "REFUSED");
    assert.match(real.message, /hrm\.compensation\.read/);
    assert.ok(!real.message.includes("90000"));
  });
});

test("F15 self-read reaches own placement but not another employment", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const own = await compaRatioFor(h.org.orgId, h.ownerBId, h.ownB.employmentId, AS_OF);
    assert.equal(own.compaRatio, "0.9500000000");
    assert.equal(own.placement, "in_range");
    // Someone else's employment refuses exactly like a fabricated id
    // through the self-only shape — identity alone is never a grant.
    const missing = await refusalOf(compaRatioFor(h.org.orgId, h.ownerBId, randomUUID(), AS_OF));
    const foreign = await refusalOf(compaRatioFor(h.org.orgId, h.ownerBId, h.empA.employmentId, AS_OF));
    assert.deepEqual(foreign, missing);
    assert.equal(foreign.code, "REFUSED");
  });
});

test("F15 restricted HR keeps self-service for own employment outside the lens", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    // Own employment in B, outside the A-scoped HR lens, still reads.
    const own = await compaRatioFor(h.org.orgId, h.mixedId, h.mixedOwn.employmentId, AS_OF);
    assert.equal(own.compaRatio, "0.9600000000");
    // In-lens HR access still works.
    const seen = await compaRatioFor(h.org.orgId, h.mixedId, h.empA.employmentId, AS_OF);
    assert.equal(seen.compaRatio, "0.9000000000");
    // Another employment outside both the lens and identity stays hidden
    // with the uniform not-found identity.
    const unknown = await refusalOf(compaRatioFor(h.org.orgId, h.mixedId, randomUUID(), AS_OF));
    const hidden = await refusalOf(compaRatioFor(h.org.orgId, h.mixedId, h.empB.employmentId, AS_OF));
    assert.deepEqual(hidden, unknown);
    assert.equal(hidden.code, "NOT_FOUND");
  });
});

test("F15 cross-org employment is not visible", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const other = await createScratchOrg();
    try {
      const otherReader = await createScratchUser(other.orgId, "Other Reader", "other_reader");
      await grantPermissions(other.orgId, otherReader, ["hrm.compensation.read"]);
      await linkPerson(other.orgId, otherReader);
      // The other-org grant is meaningless here: in this org the actor
      // holds no grant and no identity, so every id — real or fabricated
      // — refuses with the identical remedy refusal, leaking neither
      // existence nor wage coverage.
      const unknown = await refusalOf(compaRatioFor(h.org.orgId, otherReader, randomUUID(), AS_OF));
      const foreign = await refusalOf(compaRatioFor(h.org.orgId, otherReader, h.empA.employmentId, AS_OF));
      assert.deepEqual(foreign, unknown);
      assert.equal(foreign.code, "REFUSED");
      assert.ok(!foreign.message.includes("90000"));
      // The reverse direction is the granted-actor shape: an in-org
      // analyst reads a foreign-org id as uniform not-found.
      await assert.rejects(
        compaRatioFor(other.orgId, otherReader, h.empA.employmentId, AS_OF),
        /not visible in this organization/,
      );
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});
