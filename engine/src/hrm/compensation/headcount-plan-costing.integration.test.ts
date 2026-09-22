import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { CompensationError } from "./errors.ts";
import {
  createJobFamily,
  createJobLevel,
} from "./architecture.ts";
import { createPayBand } from "./bands.ts";
import {
  applyBurden,
  composeFallbackBurdenRate,
  createPlan,
  createPlanLine,
  requireBurdenRate,
} from "./headcount-plans.ts";
import { mul } from "../../money/money.ts";

/**
 * F04 regression: a valid 14% burden crashed headcount plan costing.
 * `costLine` built its loader as `String(1 + Number("0.1400"))` =
 * "1.1400000000000001", which exact money rejects, and the labor-costing
 * fallback summed percents in floats. Costing now stays in the shared
 * exact-decimal primitives (`applyBurden` = base + base×rate via
 * `mulDecimal`; fallback percents composed exactly).
 *
 * Pure arithmetic cases run without a database; the service/record cases
 * prove the configured, fallback, zero, and refusal paths through storage.
 * Proofs are read back from storage, never from return values alone.
 */

test("F04: configured 14% burden on 60000 x 1 FTE costs 68400.0000", () => {
  // Production reproduction: this exact shape threw
  // `loses precision beyond 4 decimal places: "1.1400000000000001"`.
  assert.equal(applyBurden("60000.0000", "0.1400"), "68400.0000");
});

test("F04: fractional FTE scales exactly under burden", () => {
  const base = mul("60000.0000", "0.5");
  assert.equal(base, "30000.0000");
  assert.equal(applyBurden(base, "0.1400"), "34200.0000");
});

test("F04: zero burden is the unloaded base", () => {
  assert.equal(applyBurden("60000.0000", "0"), "60000.0000");
  assert.equal(composeFallbackBurdenRate([]), "0");
  assert.equal(applyBurden("60000.0000", composeFallbackBurdenRate([])), "60000.0000");
});

test("F04: fallback composes percent components exactly, skipping unusable ones", () => {
  assert.equal(composeFallbackBurdenRate([10, 4]), "0.140000");
  assert.equal(composeFallbackBurdenRate([7.65, "2.35"]), "0.100000");
  assert.equal(composeFallbackBurdenRate(["abc", 0, -5, 10]), "0.100000");
  assert.equal(applyBurden("60000.0000", composeFallbackBurdenRate([10, 4])), "68400.0000");
});

test("F04: fractional fallback percents keep full precision to the fraction", () => {
  // Arbiter: 0.005% is a 0.00005 fraction, invisible at 4 money decimals —
  // a 4dp-rounded fraction (0.0001) would double the charge to 6.0000.
  assert.equal(composeFallbackBurdenRate(["0.005"]), "0.000050");
  assert.equal(applyBurden("60000.0000", composeFallbackBurdenRate(["0.005"])), "60003.0000");
  // Multiple fractional components compose exactly in percent space.
  assert.equal(composeFallbackBurdenRate([0.005, "0.015", 10]), "0.100200");
  assert.equal(applyBurden("60000.0000", composeFallbackBurdenRate([0.005, "0.015", 10])), "66012.0000");
});

test("F04: high-precision fractions apply exactly, never silently rounded", () => {
  // "0.1412345678" survives validation unchanged and prices to the
  // independently computed Decimal value 11412.3457.
  assert.equal(requireBurdenRate("0.1412345678"), "0.1412345678");
  assert.equal(applyBurden("10000.0000", "0.1412345678"), "11412.3457");
});

test("F04: invalid and overprecision burden rates refuse by name", () => {
  for (const bad of ["abc", "", "-0.14", "14%"]) {
    assert.throws(() => requireBurdenRate(bad), (e: unknown) => {
      assert.ok(e instanceof CompensationError);
      assert.match(e.message, /not a decimal fraction/);
      assert.match(e.message, /compensation settings/);
      return true;
    });
  }
  assert.throws(() => requireBurdenRate("0.14123456789"), (e: unknown) => {
    assert.ok(e instanceof CompensationError);
    assert.match(e.message, /more than 10 decimal places/);
    assert.match(e.message, /compensation settings/);
    return true;
  });
});

type Harness = { org: ScratchOrg; hrId: string };

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${org.orgId}`);
  const hrId = await createScratchUser(org.orgId, "F04 HR", "f04_hr");
  for (const permission of ["hrm.compensation.read", "hrm.compensation.manage"]) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${org.orgId}, ${hrId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
  return { org, hrId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
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

async function setLaborCostingComponents(orgId: string, components: Record<string, unknown>[]): Promise<void> {
  const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from orgs where id = ${orgId}`)).rows[0]?.settings ?? {};
  const next = {
    ...(current as Record<string, unknown>),
    laborCosting: { mode: "off", hoursPerDay: 8, annualHours: 2080, components },
  };
  await db.execute(sql`update orgs set settings = ${JSON.stringify(next)}::jsonb where id = ${orgId}`);
}

async function seedBand(orgId: string, hrId: string, subsidiaryId: string) {
  const family = await createJobFamily({ orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const level = await createJobLevel({
    orgId,
    actorId: hrId,
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
    orgId,
    actorId: hrId,
    scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
    currency: "CAD",
    basis: "annual",
    min: "48000",
    target: "60000",
    max: "72000",
    effectiveFrom: "2020-01-01",
    reason: "F04 band",
  });
  return { level };
}

test("F04: configured 14% burden costs end to end with audit evidence", async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedBand(org.orgId, h.hrId, org.subsidiaryId);
    await setCompensationSettings(org.orgId, { burdenRate: "0.1400" });
    const plan = await createPlan({
      orgId: org.orgId, actorId: h.hrId, name: "FY26 plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    const line = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
      title: "Engineer III", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-03-01", currency: "CAD", reason: "growth",
    });
    // 60000 target x 1.0 FTE x 1.14 burden, with its inputs explainable.
    assert.equal(line.estAnnualCost, "68400.0000");
    assert.deepEqual(line.costBasis, {
      basis: "band_target", annual_target: "60000.0000", planned_fte: "1",
      burden_rate: "0.1400", burden_source: "compensation_settings",
    });
    const stored = (await db.execute<{ est_annual_cost: string; cost_basis: Record<string, unknown> }>(sql`
      select est_annual_cost::text as est_annual_cost, cost_basis
        from hrm_headcount_plan_lines where org_id = ${org.orgId} and id = ${line.id}`)).rows[0];
    assert.equal(stored?.est_annual_cost, "68400.0000");
    assert.deepEqual(stored?.cost_basis, line.costBasis);
    // Fractional FTE under the same burden.
    const half = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
      title: "Engineer III half", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "0.5", startOn: "2026-03-01", currency: "CAD",
    });
    assert.equal(half.estAnnualCost, "34200.0000");
    // Zero burden is the unloaded base.
    await setCompensationSettings(org.orgId, { burdenRate: "0" });
    const bare = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
      title: "Engineer III bare", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-03-01", currency: "CAD",
    });
    assert.equal(bare.estAnnualCost, "60000.0000");
  });
});

test("F04: fallback labor-costing percents cost end to end, empty means zero", async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedBand(org.orgId, h.hrId, org.subsidiaryId);
    await setCompensationSettings(org.orgId, { burdenRate: null });
    await setLaborCostingComponents(org.orgId, [
      { key: "stat", kind: "percent_of_wage", name: "Statutory", value: 10 },
      { key: "wc", kind: "worker_comp", name: "Worker comp", value: 4 },
      { key: "per_diem", kind: "per_day", name: "Per diem", value: 50 },
    ]);
    const plan = await createPlan({
      orgId: org.orgId, actorId: h.hrId, name: "FY26 fallback plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    // Only the wage-percentage kinds compose: (10 + 4)% = 0.14.
    const line = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
      title: "Engineer III", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-03-01", currency: "CAD",
    });
    assert.equal(line.estAnnualCost, "68400.0000");
    assert.deepEqual(line.costBasis, {
      basis: "band_target", annual_target: "60000.0000", planned_fte: "1",
      burden_rate: "0.140000", burden_source: "labor_costing_components",
    });
    const stored = (await db.execute<{ est_annual_cost: string }>(sql`
      select est_annual_cost::text as est_annual_cost
        from hrm_headcount_plan_lines where org_id = ${org.orgId} and id = ${line.id}`)).rows[0];
    assert.equal(stored?.est_annual_cost, "68400.0000");
    // No wage-percentage components: zero burden, unloaded base.
    await setLaborCostingComponents(org.orgId, []);
    const bare = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
      title: "Engineer III bare", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-03-01", currency: "CAD",
    });
    assert.equal(bare.estAnnualCost, "60000.0000");
    assert.equal((bare.costBasis as Record<string, unknown>).burden_rate, "0");
    // A fractional percent prices exactly through the service path too.
    await setLaborCostingComponents(org.orgId, [
      { key: "micro", kind: "percent_of_wage", name: "Micro levy", value: 0.005 },
    ]);
    const micro = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
      title: "Engineer III micro", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-03-01", currency: "CAD",
    });
    assert.equal(micro.estAnnualCost, "60003.0000");
    assert.deepEqual(micro.costBasis, {
      basis: "band_target", annual_target: "60000.0000", planned_fte: "1",
      burden_rate: "0.000050", burden_source: "labor_costing_components",
    });
    const microStored = (await db.execute<{ est_annual_cost: string }>(sql`
      select est_annual_cost::text as est_annual_cost
        from hrm_headcount_plan_lines where org_id = ${org.orgId} and id = ${micro.id}`)).rows[0];
    assert.equal(microStored?.est_annual_cost, "60003.0000");
  });
});

test("F04: undeclared burden rate refuses by name and writes nothing", async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedBand(org.orgId, h.hrId, org.subsidiaryId);
    await setCompensationSettings(org.orgId, { burdenRate: "fourteen-percent" });
    const plan = await createPlan({
      orgId: org.orgId, actorId: h.hrId, name: "FY26 refused plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    await assert.rejects(
      createPlanLine({
        orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
        title: "Engineer III refused", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
        plannedFte: "1", startOn: "2026-03-01", currency: "CAD",
      }),
      /not a decimal fraction/,
    );
    const rows = (await db.execute<{ id: string }>(sql`
      select id from hrm_headcount_plan_lines
       where org_id = ${org.orgId} and plan_id = ${plan.id}`)).rows;
    assert.equal(rows.length, 0);
  });
});
