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
  setCompensationSettings,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import {
  createJobFamily,
  createJobLevel,
} from "./architecture.ts";
import { createPayBand } from "./bands.ts";
import {
  createPlan,
  createPlanLine,
  listPlanLines,
  listPlans,
} from "./headcount-plans.ts";

/**
 * F08 regression: headcount-plan reads ignored the actor's subsidiary
 * lens. listPlans/listPlanLines demanded hrm.compensation.read only, so a
 * reader scoped to one legal entity received every plan line's
 * estAnnualCost/costBasis org-wide — salary and staffing figures for
 * subsidiaries they must never see.
 *
 * Reads now resolve the actor's allowed employer set at the domain
 * boundary through requireAggregateCompensationRead (null =
 * unrestricted), never a caller-forged allowlist: plan discovery hides
 * plans scoped to a hidden subsidiary while unscoped/mixed plans stay
 * discoverable (headers carry no pay), and lines filter on the persisted
 * employer_subsidiary_id — an empty allowed set sees no lines at all.
 * Proofs are read back through the service, never from its internals.
 */


const headcountScopeSpecFor = (rolePrefix: string) => ({
  users: [
    { key: "hrId", name: "F08 HR", handle: `${rolePrefix}_hr`, permissions: ["hrm.compensation.read", "hrm.compensation.manage"] },
    { key: "readerA", name: "F08 Reader A", handle: `${rolePrefix}_reader_a` },
    { key: "readerB", name: "F08 Reader B", handle: `${rolePrefix}_reader_b` },
    { key: "readerSub", name: "F08 Reader Subtree", handle: `${rolePrefix}_reader_sub` },
    { key: "readerNone", name: "F08 Reader None", handle: `${rolePrefix}_reader_none` },
  ],
} as const);

async function setupHeadcountScopeHarness(rolePrefix: string) {
  return setupHarness(headcountScopeSpecFor(rolePrefix), async (base) => {
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
    const level = await createJobLevel({
      orgId: base.org.orgId,
      actorId: base.hrId,
      familyId: family.id,
      code: "IC3",
      name: "Engineer III",
      rank: 3,
      equalValueCriteria: [
        { criterion: "skills", weight: "3" },
        { criterion: "effort", weight: "2" },
        { criterion: "responsibility", weight: "3" },
        { criterion: "working_conditions", weight: "1" },
      ],
    });
    await createPayBand({
      orgId: base.org.orgId,
      actorId: base.hrId,
      scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
      currency: "CAD",
      basis: "annual",
      min: "80000",
      target: "100000",
      max: "120000",
      effectiveFrom: "2020-01-01",
      reason: "F08 band",
    });
    await setCompensationSettings(base.org.orgId, { burdenRate: "0" });
    const plan = await createPlan({
      orgId: base.org.orgId, actorId: base.hrId, name: "FY26 mixed plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    const lineA = await createPlanLine({
      orgId: base.org.orgId, actorId: base.hrId, planId: plan.id, kind: "create",
      title: "Engineer III A", employerSubsidiaryId: base.org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-03-01", currency: "CAD", reason: "growth A",
    });
    const lineB = await createPlanLine({
      orgId: base.org.orgId, actorId: base.hrId, planId: plan.id, kind: "create",
      title: "Engineer III B", employerSubsidiaryId: subB, jobLevelId: level.id,
      plannedFte: "0.5", startOn: "2026-03-01", currency: "CAD", reason: "growth B",
    });
    return { subB, planId: plan.id, lineAId: lineA.id, lineBId: lineB.id };
  });
}

test("F08: headcount plan lines fence salaries to the actor's subsidiary lens", { skip: !DB }, async () => {
  await withHarness(() => setupHeadcountScopeHarness("f08_lines"), async (h) => {
    const q = { orgId: h.org.orgId, planId: h.planId };
    // The unrestricted reader sees both staffing lines with their costed
    // figures and cost evidence.
    const full = await listPlanLines({ ...q, actorId: h.hrId });
    assert.equal(full.length, 2);
    const fullA = full.find((l) => l.id === h.lineAId)!;
    const fullB = full.find((l) => l.id === h.lineBId)!;
    assert.equal(fullA.estAnnualCost, "100000.0000");
    assert.equal(fullB.estAnnualCost, "50000.0000");
    assert.equal((fullA.costBasis as Record<string, unknown>).basis, "band_target");
    assert.equal((fullB.costBasis as Record<string, unknown>).basis, "band_target");
    // A reader scoped to subsidiary A sees only A's line: B's salary is
    // not observable through a read grant alone.
    const aLines = await listPlanLines({ ...q, actorId: h.readerA });
    assert.equal(aLines.length, 1);
    assert.equal(aLines[0]!.id, h.lineAId);
    assert.equal(aLines[0]!.employerSubsidiaryId, h.org.subsidiaryId);
    assert.equal(aLines[0]!.estAnnualCost, "100000.0000");
    assert.equal((aLines[0]!.costBasis as Record<string, unknown>).basis, "band_target");
    // The symmetric B reader sees only B's line.
    const bLines = await listPlanLines({ ...q, actorId: h.readerB });
    assert.equal(bLines.length, 1);
    assert.equal(bLines[0]!.id, h.lineBId);
    assert.equal(bLines[0]!.estAnnualCost, "50000.0000");
    // A forged allowlist smuggled into the call changes nothing: the
    // lens resolves inside the domain boundary, never from caller input.
    const forged = await listPlanLines({
      ...q,
      actorId: h.readerA,
      ...({ allowedSubsidiaryIds: [h.subB] } as Record<string, unknown>),
    } as { orgId: string; actorId: string; planId: string });
    assert.equal(forged.length, 1);
    assert.equal(forged[0]!.id, h.lineAId);
    // A subtree rooted at A covers its descendant B: both lines visible.
    const subLines = await listPlanLines({ ...q, actorId: h.readerSub });
    assert.equal(subLines.length, 2);
    // An actor with zero allowed subsidiaries never receives
    // salary/staffing lines.
    const noLines = await listPlanLines({ ...q, actorId: h.readerNone });
    assert.equal(noLines.length, 0);
    // Loader safety: the plan-detail total sums only visible lines, so a
    // restricted reader's total cannot carry hidden-subsidiary amounts.
    const totalFor = (lines: readonly { estAnnualCost: string }[]): number =>
      lines.reduce((sum, l) => sum + Number(l.estAnnualCost), 0);
    assert.equal(totalFor(full), 150000);
    assert.equal(totalFor(aLines), 100000);
    assert.equal(totalFor(noLines), 0);
  });
});

test("F08: plan discovery hides scoped plans but preserves mixed-plan partial reads", { skip: !DB }, async () => {
  await withHarness(() => setupHeadcountScopeHarness("f08_plans"), async (h) => {
    const orgId = h.org.orgId;
    // A plan scoped to subsidiary B through the 0222 scope shape.
    const scopedB = await createPlan({
      orgId, actorId: h.hrId, name: "B-only plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    await db.execute(sql`
      update hrm_headcount_plans
         set scope = ${JSON.stringify({ employer_subsidiary_id: h.subB })}::jsonb
       where org_id = ${orgId} and id = ${scopedB.id}`);
    // The mixed (unscoped) plan stays discoverable for every org reader
    // because headers carry no pay — partial reads survive scoping.
    const seenA = await listPlans({ orgId, actorId: h.readerA });
    assert.ok(seenA.some((p) => p.id === h.planId));
    assert.ok(!seenA.some((p) => p.id === scopedB.id));
    const seenB = await listPlans({ orgId, actorId: h.readerB });
    assert.ok(seenB.some((p) => p.id === h.planId));
    assert.ok(seenB.some((p) => p.id === scopedB.id));
    const seenNone = await listPlans({ orgId, actorId: h.readerNone });
    assert.ok(seenNone.some((p) => p.id === h.planId));
    assert.ok(!seenNone.some((p) => p.id === scopedB.id));
    const seenAll = await listPlans({ orgId, actorId: h.hrId });
    assert.ok(seenAll.some((p) => p.id === h.planId));
    assert.ok(seenAll.some((p) => p.id === scopedB.id));
    // The mixed plan's lines still fence per line for the partial reader.
    const aLines = await listPlanLines({ orgId, actorId: h.readerA, planId: h.planId });
    assert.equal(aLines.length, 1);
    assert.equal(aLines[0]!.id, h.lineAId);
    // Cross-org: a reader from a second org cannot list this org's plans
    // and cannot reach its lines — the permission gate fires, never a
    // salary row.
    const other = await createScratchOrg();
    try {
      const otherReader = await createScratchUser(other.orgId, "F08 Other Reader", "f08_plans_other");
      await grantPermissions(other.orgId, otherReader, ["hrm.compensation.read"]);
      await assert.rejects(
        listPlans({ orgId, actorId: otherReader }),
        /hrm\.compensation\.read/,
      );
      await assert.rejects(
        listPlanLines({ orgId, actorId: otherReader, planId: h.planId }),
        /hrm\.compensation\.read/,
      );
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});
