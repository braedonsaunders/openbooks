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
  enableHrm,
  grantPermissions,
  linkPerson,
  refusalOf,
  scopeRole,
  seedPositionedEmployment,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
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


/** Positioned employment (primary assignment on a level) plus its payroll-side wage. */
/** Exact refusal identity (code plus message): unknown, foreign, and hidden ids must match fully. */
const BANDS_PLACEMENT_SPEC = {
  users: [
    { key: "hrId", name: "Place HR", handle: "place_hr", permissions: ["hrm.compensation.read", "hrm.compensation.manage"], link: true },
    { key: "analystId", name: "Place Analyst", handle: "place_analyst", permissions: ["hrm.compensation.read"], link: true },
    { key: "readerAId", name: "Place Reader A", handle: "place_reader_a", permissions: ["hrm.compensation.read"], link: true },
    { key: "readerNoneId", name: "Place Reader None", handle: "place_reader_none", permissions: ["hrm.compensation.read"], link: true },
    { key: "ownerBId", name: "Place Owner B", handle: "place_owner_b", permissions: ["hrm.self.read"] },
    { key: "mixedId", name: "Place Mixed", handle: "place_mixed", permissions: ["hrm.compensation.read", "hrm.self.read"] },
    { key: "strangerId", name: "Place Stranger", handle: "place_stranger", link: true },
  ],
} as const;

const AS_OF = "2024-06-01";

async function setupBandsPlacementHarness() {
  return setupHarness(BANDS_PLACEMENT_SPEC, async (base) => {
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${base.org.orgId}, ${base.org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${base.org.subsidiaryId} and org_id = ${base.org.orgId}`);
    const family = await createJobFamily({ orgId: base.org.orgId, actorId: base.hrId, code: "ENG", name: "Engineering" });
    const level = await createJobLevel({
      orgId: base.org.orgId, actorId: base.hrId, familyId: family.id, code: "IC3", name: "Engineer III", rank: 3,
      equalValueCriteria: [{ criterion: "skills", weight: "3" }],
    });
    await createPayBand({
      orgId: base.org.orgId, actorId: base.hrId,
      scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
      currency: "CAD", basis: "annual", min: "80000", target: "100000", max: "120000",
      effectiveFrom: "2020-01-01", reason: "test band",
    });
    const empA = await seedPositionedEmployment(base.org.orgId, base.org.subsidiaryId, { levelId: level.id, displayName: "Placed Worker", wage: { actorId: base.hrId, rate: "90000" } });
    const empB = await seedPositionedEmployment(base.org.orgId, subB, { levelId: level.id, displayName: "Placed Worker", wage: { actorId: base.hrId, rate: "100000" } });
    await scopeRole(base.org.orgId, "place_reader_a", ["hrm.compensation.read"], [base.org.subsidiaryId]);
    await scopeRole(base.org.orgId, "place_reader_none", ["hrm.compensation.read"], []);
    // Self-service owner whose own employment sits in subsidiary B.
    const ownerParty = await linkPerson(base.org.orgId, base.ownerBId);
    const ownB = await seedPositionedEmployment(base.org.orgId, subB, { levelId: level.id, displayName: "Placed Worker", wage: { actorId: base.hrId, rate: "95000" }, workerPartyId: ownerParty });
    // Mixed grants: restricted HR lens over A plus self.read, own in B.
    await scopeRole(base.org.orgId, "place_mixed", ["hrm.compensation.read"], [base.org.subsidiaryId]);
    const mixedParty = await linkPerson(base.org.orgId, base.mixedId);
    const mixedOwn = await seedPositionedEmployment(base.org.orgId, subB, { levelId: level.id, displayName: "Placed Worker", wage: { actorId: base.hrId, rate: "96000" }, workerPartyId: mixedParty });
    return { subB, empA, empB, ownB, mixedOwn };
  });
}

test("F15 unrestricted analyst reads placement without employment.read", { skip: !DB }, async () => {
  await withHarness(() => setupBandsPlacementHarness(), async (h) => {
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
  await withHarness(() => setupBandsPlacementHarness(), async (h) => {
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
  await withHarness(() => setupBandsPlacementHarness(), async (h) => {
    const unknown = await refusalOf(compaRatioFor(h.org.orgId, h.readerNoneId, randomUUID(), AS_OF));
    assert.deepEqual(await refusalOf(compaRatioFor(h.org.orgId, h.readerNoneId, h.empA.employmentId, AS_OF)), unknown);
    assert.deepEqual(await refusalOf(compaRatioFor(h.org.orgId, h.readerNoneId, h.empB.employmentId, AS_OF)), unknown);
    assert.equal(unknown.code, "NOT_FOUND");
  });
});

test("F15 no-grant stranger is refused without learning existence or wages", { skip: !DB }, async () => {
  await withHarness(() => setupBandsPlacementHarness(), async (h) => {
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
  await withHarness(() => setupBandsPlacementHarness(), async (h) => {
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
  await withHarness(() => setupBandsPlacementHarness(), async (h) => {
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

test("F16 an unordered band is refused by name even when floats cannot tell the figures apart", { skip: !DB }, async () => {
  // 999999999999999.9999 and 999999999999999.9998 round to the SAME double,
  // so a Number comparison reads min <= target and stores a band nobody can
  // sit in; the exact comparison refuses it with the named remedy. The
  // storage CHECK hrm_pay_bands_ordered would also stop it, but only as a
  // raw storage failure — the operator deserves the domain refusal.
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const hrId = await createScratchUser(org.orgId, "Band HR", "band_hr");
    await grantPermissions(org.orgId, hrId, ["hrm.compensation.manage"]);
    await linkPerson(org.orgId, hrId);
    const family = await createJobFamily({ orgId: org.orgId, actorId: hrId, code: "ENG", name: "Engineering" });
    const level = await createJobLevel({
      orgId: org.orgId, actorId: hrId, familyId: family.id, code: "IC3", name: "Engineer III", rank: 3,
      equalValueCriteria: [{ criterion: "skills", weight: "3" }],
    });
    const scope = { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null };
    await assert.rejects(
      createPayBand({
        orgId: org.orgId, actorId: hrId, scope, currency: "CAD", basis: "annual",
        min: "999999999999999.9999", target: "999999999999999.9998", max: "999999999999999.9999",
        effectiveFrom: "2020-01-01", reason: "unordered band probe",
      }),
      /not ordered min <= target <= max/,
    );
    const ordered = await createPayBand({
      orgId: org.orgId, actorId: hrId, scope, currency: "CAD", basis: "annual",
      min: "999999999999999.9998", target: "999999999999999.9999", max: "999999999999999.9999",
      effectiveFrom: "2020-01-01", reason: "ordered band probe",
    });
    assert.ok(ordered.id, "an exactly ordered band still stores");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("F15 cross-org employment is not visible", { skip: !DB }, async () => {
  await withHarness(() => setupBandsPlacementHarness(), async (h) => {
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
