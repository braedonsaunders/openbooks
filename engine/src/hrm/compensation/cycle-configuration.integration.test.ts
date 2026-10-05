import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { DB, seedLevel, seedPositionedEmployment, seedWage, setFeatures, setupHarness, withHarness } from "../../testing/hrm-harness.ts";
import { createCycle, listCycleLines, openCycle } from "./cycles.ts";
import { createPayBand } from "./bands.ts";
import { CompensationError } from "./errors.ts";

const specification = {
  features: ["hrm", "payroll"],
  users: [{ key: "hrId", name: "Compensation administrator", handle: "compensation_admin", permissions: ["hrm.compensation.read", "hrm.compensation.manage"], link: true }],
} as const;

test("cycle currency refusal preserves the draft register and names the enabled-currency remedy", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(specification), async ({ org, hrId }) => {
    await setFeatures(org.orgId, { multiCurrency: false });
    const query = { orgId: org.orgId, actorId: hrId, name: "Foreign-currency merit", kind: "merit" as const, effectiveOn: "2026-04-01", currency: "USD", guidelineKind: "formula" as const, guideline: { expr: "3" } };
    await assert.rejects(createCycle(query), (error: unknown) => error instanceof CompensationError && error.code === "REFUSED"
      && /choose an enabled currency for the cycle employer.*Company Settings → Features → Multi-currency/.test(error.message));
    const refused = (await db.execute<{ count: string }>(sql`select count(*)::text as count from hrm_comp_cycles where org_id = ${org.orgId} and name = ${query.name}`)).rows[0];
    assert.equal(refused?.count, "0");
    await setFeatures(org.orgId, { multiCurrency: true });
    const accepted = await createCycle(query);
    assert.equal(accepted.currency, "USD");
    const stored = (await db.execute<{ currency: string }>(sql`select currency from hrm_comp_cycles where org_id = ${org.orgId} and id = ${accepted.id}`)).rows[0];
    assert.equal(stored?.currency, "USD");
    await assert.rejects(createCycle({ ...query, name: "Unconfigured formula", guideline: { expr: "unknown_salary * 0.1" } }), /names "unknown_salary".*available inputs are rating, compa_ratio, tenure_years/);
    await assert.rejects(createCycle({ ...query, name: "Boolean guideline", guideline: { expr: "compa_ratio < 1" } }), /must produce a numeric percent/);
    const invalid = (await db.execute<{ count: string }>(sql`select count(*)::text as count from hrm_comp_cycles where org_id = ${org.orgId} and name in ('Unconfigured formula', 'Boolean guideline')`)).rows[0];
    assert.equal(invalid?.count, "0");
  });
});

test("a cycle uses its own legal entity's base currency when multi-currency is disabled", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(specification), async ({ org, hrId }) => {
    await setFeatures(org.orgId, { multiCurrency: false });
    assert.equal((await db.execute(sql`update subsidiaries set base_currency = 'EUR' where org_id = ${org.orgId} and id = ${org.subsidiaryId} returning id`)).rows.length, 1);
    const query = { orgId: org.orgId, actorId: hrId, name: "Employer currency", kind: "merit" as const, effectiveOn: "2026-04-01", currency: "EUR", guidelineKind: "formula" as const, guideline: { expr: "3" }, scope: { employerSubsidiaryId: org.subsidiaryId } };
    assert.equal((await createCycle(query)).currency, "EUR");
    await assert.rejects(createCycle({ ...query, name: "Wrong employer currency", currency: "CAD" }), /choose an enabled currency for the cycle employer/);
    const orgWide = await createCycle({ ...query, name: "Organization currency", currency: "CAD", scope: {} });
    assert.equal(orgWide.currency, "CAD");
  });
});

test("opening a formula cycle stores exact, conditional six-place guideline snapshots", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(specification), async ({ org, hrId }) => {
    const levelId = await seedLevel(org.orgId, hrId);
    await createPayBand({ orgId: org.orgId, actorId: hrId, scope: { familyId: null, levelId, employerSubsidiaryId: null, locationId: null },
      currency: "CAD", basis: "annual", min: "80000", target: "100000", max: "120000", effectiveFrom: "2020-01-01", reason: "Declared compensation guideline basis" });
    const below = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId, displayName: "Below target" });
    const atTarget = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId, displayName: "At target" });
    await seedWage(org.orgId, hrId, below.workerPartyId, "95000");
    await seedWage(org.orgId, hrId, atTarget.workerPartyId, "100000");
    const cycle = await createCycle({ orgId: org.orgId, actorId: hrId, name: "Conditional merit", kind: "merit", effectiveOn: "2026-04-01", currency: "CAD",
      guidelineKind: "formula", guideline: { expr: "if(compa_ratio < 1, 1 / 3 * 3, 1.2345675)" } });
    await openCycle({ orgId: org.orgId, actorId: hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: hrId, cycleId: cycle.id });
    assert.equal(lines.length, 2);
    assert.equal(lines.find((line) => line.employmentId === below.employmentId)?.guidelineMinPct, "1.000000");
    assert.equal(lines.find((line) => line.employmentId === atTarget.employmentId)?.guidelineMaxPct, "1.234568");
    const stored = (await db.execute<{ employment_id: string; minimum: string; maximum: string }>(sql`
      select employment_id, guideline_min_pct::text as minimum, guideline_max_pct::text as maximum
        from hrm_comp_cycle_lines where org_id = ${org.orgId} and cycle_id = ${cycle.id}`)).rows;
    assert.equal(stored.length, 2);
    assert.ok(stored.every((line) => line.minimum === line.maximum));
    assert.equal(stored.find((line) => line.employment_id === atTarget.employmentId)?.minimum, "1.234568");
  });
});
