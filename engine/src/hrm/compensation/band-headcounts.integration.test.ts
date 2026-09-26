import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import {
  DB,
  grantPermissions,
  restrictRole,
  seedPositionedEmployment,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
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

const AS_OF = "2026-06-01";

/** Worker employment with one live version plus a primary positioned assignment. */
/** The pre-F16 loader shape: org/level/date only, no subsidiary lens. */
const bandHeadcountsSpecFor = (rolePrefix: string) => ({
  users: [
    { key: "hrId", name: "F16 HR", handle: `${rolePrefix}_hr`, permissions: ["hrm.compensation.read", "hrm.compensation.manage"] },
    { key: "readerA", name: "F16 Reader A", handle: `${rolePrefix}_reader_a` },
    { key: "readerB", name: "F16 Reader B", handle: `${rolePrefix}_reader_b` },
    { key: "readerSub", name: "F16 Reader Subtree", handle: `${rolePrefix}_reader_sub` },
    { key: "readerNone", name: "F16 Reader None", handle: `${rolePrefix}_reader_none` },
  ],
} as const);

async function setupBandHeadcountsHarness(rolePrefix: string) {
  return setupHarness(bandHeadcountsSpecFor(rolePrefix), async (base) => {
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${base.org.orgId}, ${base.org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${base.org.subsidiaryId} and org_id = ${base.org.orgId}`);
    await restrictRole(base.org.orgId, `${rolePrefix}_reader_a`, { mode: "list", subsidiaryIds: [base.org.subsidiaryId] }, ["hrm.compensation.read"]);
    await restrictRole(base.org.orgId, `${rolePrefix}_reader_b`, { mode: "list", subsidiaryIds: [subB] }, ["hrm.compensation.read"]);
    await restrictRole(base.org.orgId, `${rolePrefix}_reader_sub`, { mode: "subtree", subsidiaryId: base.org.subsidiaryId }, ["hrm.compensation.read"]);
    await restrictRole(base.org.orgId, `${rolePrefix}_reader_none`, { mode: "list", subsidiaryIds: [] }, ["hrm.compensation.read"]);
    const family = await createJobFamily({ orgId: base.org.orgId, actorId: base.hrId, code: "ENG", name: "Engineering" });
    const criteria = [
      { criterion: "skills", weight: "3" },
      { criterion: "effort", weight: "2" },
      { criterion: "responsibility", weight: "3" },
      { criterion: "working_conditions", weight: "1" },
    ];
    const level = await createJobLevel({
      orgId: base.org.orgId, actorId: base.hrId, familyId: family.id,
      code: "IC3", name: "Engineer III", rank: 3, equalValueCriteria: criteria,
    });
    const otherLevel = await createJobLevel({
      orgId: base.org.orgId, actorId: base.hrId, familyId: family.id,
      code: "IC4", name: "Engineer IV", rank: 4, equalValueCriteria: criteria,
    });
    await seedPositionedEmployment(base.org.orgId, base.org.subsidiaryId, { levelId: level.id, displayName: "Band Worker" });
    await seedPositionedEmployment(base.org.orgId, base.org.subsidiaryId, { levelId: level.id, displayName: "Band Worker" });
    await seedPositionedEmployment(base.org.orgId, base.org.subsidiaryId, { levelId: level.id, status: "on_leave", displayName: "Band Worker" });
    await seedPositionedEmployment(base.org.orgId, subB, { levelId: level.id, displayName: "Band Worker" });
    // Excluded rows: terminated at the level, a holder of the other
    // level, and an active employment with no positioned assignment.
    await seedPositionedEmployment(base.org.orgId, base.org.subsidiaryId, { levelId: level.id, status: "terminated", displayName: "Band Worker" });
    await seedPositionedEmployment(base.org.orgId, base.org.subsidiaryId, { levelId: otherLevel.id, displayName: "Band Worker" });
    await seedPositionedEmployment(base.org.orgId, base.org.subsidiaryId, { levelId: null, displayName: "Band Worker" });
    return {
      subB,
      levelId: level.id, otherLevelId: otherLevel.id,
    };
  });
}

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
  await withHarness(() => setupBandHeadcountsHarness("f16_lens"), async (h) => {
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
  await withHarness(() => setupBandHeadcountsHarness("f16_dates"), async (h) => {
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
