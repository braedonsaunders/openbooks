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
import { createPayBand } from "./bands.ts";
import { countBandHolders } from "./band-headcounts.ts";

/**
 * F16 regression: the compensation home per-band holders count filtered
 * only by org/level/date, so a reader with an empty subsidiary scope
 * still received whole-org worker counts through a read grant alone.
 *
 * Counts now resolve the actor's allowed employer set at the domain
 * boundary through requireAggregateCompensationRead (null =
 * unrestricted), never a caller-forged allowlist, and filter on the
 * persisted worker_employments.employer_subsidiary_id — an empty
 * allowed set sees zero. Band configuration stays visible; only the
 * employee headcount is fenced. Effective-dated primary
 * active/on_leave semantics are preserved.
 *
 * Proofs are read back through the service, never from its internals;
 * the legacy unfenced shape is replayed inline once to prove the red.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;
const AS_OF = "2026-06-01";

type Harness = {
  org: ScratchOrg;
  subB: string;
  hrId: string;
  readerA: string;
  readerB: string;
  readerSub: string;
  readerNone: string;
  levelId: string;
  otherLevelId: string;
};

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function restrictRole(orgId: string, roleKey: string, restriction: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.compensation.read"]'::jsonb,
           subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

/** Worker employment with one live version plus a primary positioned assignment. */
async function seedPositionedEmployment(
  orgId: string,
  subsidiaryId: string,
  opts: { status?: string; from?: string; levelId?: string | null },
): Promise<string> {
  const workerPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Band Worker', true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, ${opts.status ?? "active"}, ${opts.from ?? "2020-01-01"}::date, null, now())
  `);
  if (opts.levelId !== undefined && opts.levelId !== null) {
    const positionId = randomUUID();
    await db.execute(sql`
      insert into positions (id, org_id, position_code, revision)
      values (${positionId}, ${orgId}, ${`POS-${positionId.slice(0, 6)}`}, 1)
    `);
    await db.execute(sql`
      insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
        employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
      values (${orgId}, ${positionId}, 1, 'Engineer', null, null,
        ${subsidiaryId}, 1, 'filled', '2020-01-01', ${opts.levelId})
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
  }
  return employmentId;
}

async function setupHarness(rolePrefix: string): Promise<Harness> {
  const org = await createScratchOrg();
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${org.orgId}`);
  const hrId = await createScratchUser(org.orgId, "F16 HR", `${rolePrefix}_hr`);
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
  // A second legal entity under the same org.
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
      from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  // Readers holding the read grant under different subsidiary lenses.
  const readerA = await createScratchUser(org.orgId, "F16 Reader A", `${rolePrefix}_reader_a`);
  await restrictRole(org.orgId, `${rolePrefix}_reader_a`, { mode: "list", subsidiaryIds: [org.subsidiaryId] });
  const readerB = await createScratchUser(org.orgId, "F16 Reader B", `${rolePrefix}_reader_b`);
  await restrictRole(org.orgId, `${rolePrefix}_reader_b`, { mode: "list", subsidiaryIds: [subB] });
  const readerSub = await createScratchUser(org.orgId, "F16 Reader Subtree", `${rolePrefix}_reader_sub`);
  await restrictRole(org.orgId, `${rolePrefix}_reader_sub`, { mode: "subtree", subsidiaryId: org.subsidiaryId });
  const readerNone = await createScratchUser(org.orgId, "F16 Reader None", `${rolePrefix}_reader_none`);
  await restrictRole(org.orgId, `${rolePrefix}_reader_none`, { mode: "list", subsidiaryIds: [] });
  // One level priced by a band plus a second level whose holders must
  // never leak into this band's count.
  const family = await createJobFamily({ orgId: org.orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const criteria = [
    { criterion: "skills", weight: "3" },
    { criterion: "effort", weight: "2" },
    { criterion: "responsibility", weight: "3" },
    { criterion: "working_conditions", weight: "1" },
  ];
  const level = await createJobLevel({
    orgId: org.orgId, actorId: hrId, familyId: family.id,
    code: "IC3", name: "Engineer III", rank: 3, equalValueCriteria: criteria,
  });
  const otherLevel = await createJobLevel({
    orgId: org.orgId, actorId: hrId, familyId: family.id,
    code: "IC4", name: "Engineer IV", rank: 4, equalValueCriteria: criteria,
  });
  await createPayBand({
    orgId: org.orgId, actorId: hrId,
    scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
    currency: "CAD", basis: "annual",
    min: "80000", target: "100000", max: "120000",
    effectiveFrom: "2020-01-01", reason: "F16 band",
  });
  // Holders at the band's level: two active in A, one on_leave in A
  // (still counted), one active in B.
  await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
  await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
  await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id, status: "on_leave" });
  await seedPositionedEmployment(org.orgId, subB, { levelId: level.id });
  // Excluded rows: terminated at the level, a holder of the other
  // level, and an active employment with no positioned assignment.
  await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id, status: "terminated" });
  await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: otherLevel.id });
  await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: null });
  return {
    org, subB, hrId, readerA, readerB, readerSub, readerNone,
    levelId: level.id, otherLevelId: otherLevel.id,
  };
}

async function withHarness(rolePrefix: string, fn: (h: Harness) => Promise<void>): Promise<void> {
  if (!DB) return;
  const h = await setupHarness(rolePrefix);
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

/** The pre-F16 loader shape: org/level/date only, no subsidiary lens. */
async function legacyUnfencedCount(orgId: string, levelId: string, asOf: string): Promise<number> {
  const row = (await db.execute<{ n: string }>(sql`
    select count(distinct aav.employment_id)::text as n
      from employment_assignment_versions aav
      join position_versions pv on pv.org_id = aav.org_id and pv.position_id = aav.position_id
       and pv.job_level_id = ${levelId}
       and pv.effective_from <= ${asOf}::date
       and (pv.effective_to is null or pv.effective_to >= ${asOf}::date)
       and pv.recorded_until is null
      join worker_employment_versions ev on ev.org_id = aav.org_id and ev.employment_id = aav.employment_id
       and ev.effective_from <= ${asOf}::date
       and (ev.effective_to is null or ev.effective_to >= ${asOf}::date)
       and ev.recorded_until is null and ev.status in ('active', 'on_leave')
     where aav.org_id = ${orgId} and aav.is_primary
       and aav.effective_from <= ${asOf}::date
       and (aav.effective_to is null or aav.effective_to >= ${asOf}::date)
       and aav.recorded_until is null`)).rows[0];
  return Number(row?.n ?? "0");
}

test("F16: band holder counts match the caller lens, empty sees zero", { skip: !DB }, async () => {
  await withHarness("f16_lens", async (h) => {
    const q = { orgId: h.org.orgId, levelId: h.levelId, asOf: AS_OF };
    // Red proof: the legacy shape exposes the whole-org total (4) to
    // anyone who can run it — the count no reader with an empty scope
    // may receive.
    assert.equal(await legacyUnfencedCount(h.org.orgId, h.levelId, AS_OF), 4);
    // The unrestricted reader still sees every in-service holder at the
    // level: two active plus one on_leave in A, one active in B.
    assert.equal(await countBandHolders({ ...q, actorId: h.hrId }), 4);
    // Restricted readers see only their own legal entity's holders.
    assert.equal(await countBandHolders({ ...q, actorId: h.readerA }), 3);
    assert.equal(await countBandHolders({ ...q, actorId: h.readerB }), 1);
    // A forged allowlist smuggled into the call changes nothing: the
    // lens resolves inside the domain boundary, never from caller input.
    const forged = await countBandHolders({
      ...q,
      actorId: h.readerA,
      ...({ allowedSubsidiaryIds: [h.subB] } as Record<string, unknown>),
    } as { orgId: string; actorId: string; levelId: string; asOf: string });
    assert.equal(forged, 3);
    // A subtree rooted at A covers its descendant B: the full count.
    assert.equal(await countBandHolders({ ...q, actorId: h.readerSub }), 4);
    // An actor with zero allowed subsidiaries sees zero — never the
    // whole-org count.
    assert.equal(await countBandHolders({ ...q, actorId: h.readerNone }), 0);
    // The other level counts only its own single holder for every lens.
    const other = { orgId: h.org.orgId, levelId: h.otherLevelId, asOf: AS_OF };
    assert.equal(await countBandHolders({ ...other, actorId: h.hrId }), 1);
    assert.equal(await countBandHolders({ ...other, actorId: h.readerA }), 1);
    assert.equal(await countBandHolders({ ...other, actorId: h.readerB }), 0);
    assert.equal(await countBandHolders({ ...other, actorId: h.readerNone }), 0);
  });
});

test("F16: band holder counts respect dates and org isolation", { skip: !DB }, async () => {
  await withHarness("f16_dates", async (h) => {
    const q = { orgId: h.org.orgId, levelId: h.levelId };
    // Before any employment starts, every lens — including
    // unrestricted — sees zero.
    assert.equal(await countBandHolders({ ...q, actorId: h.hrId, asOf: "2019-01-01" }), 0);
    assert.equal(await countBandHolders({ ...q, actorId: h.readerA, asOf: "2019-01-01" }), 0);
    // Cross-org: a reader from a second org cannot count this org's
    // holders — the permission gate fires, never a headcount.
    const other = await createScratchOrg();
    try {
      const otherReader = await createScratchUser(other.orgId, "F16 Other Reader", "f16_dates_other");
      await grantPermissions(other.orgId, otherReader, ["hrm.compensation.read"]);
      await assert.rejects(
        countBandHolders({ ...q, actorId: otherReader, asOf: AS_OF }),
        /hrm\.compensation\.read/,
      );
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});
