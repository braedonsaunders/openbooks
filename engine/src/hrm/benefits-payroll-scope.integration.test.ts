import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { BenefitsError } from "./benefits/errors.ts";
import { electEnrollment } from "./benefits/enrollments.ts";
import {
  generateBenefitPayrollInputs,
  voidBenefitPayrollInput,
} from "./benefits/benefits-payroll.ts";

/**
 * H-BENEFIT-PAYINPUT regression: benefit payroll-input generation and
 * voiding ignored the actor's subsidiary lens. generateBenefitPayrollInputs
 * demanded hrm.benefits.manage only, scanned every active org enrollment
 * for the month, and materialized plus returned deduction rows for B's
 * employees to an A-scoped manager. voidBenefitPayrollInput updated any
 * B input by org/id.
 *
 * Generation now reads through the actor's employer lens — out-of-scope
 * enrollments are neither materialized nor returned — and void locks its
 * row and rechecks the employment's scope inside the write transaction,
 * refusing a B input uniformly as NOT_FOUND. Proofs are read back from
 * storage (the inputs table), never from the service's return alone.
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

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function seedEmployment(orgId: string, subsidiaryId: string): Promise<string> {
  const party = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${party}, ${orgId}, 'person', 'Benefits Worker', true, '{}'::jsonb)`);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${party}, ${subsidiaryId}, 1)`);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())`);
  return employmentId;
}

async function seedComponent(orgId: string, code: string, kind: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, is_active)
    values (${id}, ${orgId}, ${code}, ${code}, ${kind}, true)`);
  return id;
}

async function seedPlan(orgId: string): Promise<string> {
  const employeeComponentId = await seedComponent(orgId, `DED_${randomUUID().slice(0, 6)}`, "deduction");
  const employerComponentId = await seedComponent(orgId, `ER_${randomUUID().slice(0, 6)}`, "employer_contribution");
  const planId = randomUUID();
  const code = `MED_${randomUUID().slice(0, 6)}`;
  await db.execute(sql`
    insert into hrm_benefit_plans
      (id, org_id, code, name, kind, currency, employee_cost_basis, employee_cost,
       employer_cost_basis, employer_cost, employee_pay_component_id,
       employer_pay_component_id, proration_basis, waiting_period_days,
       requires_approval, is_active, effective_from)
    values (${planId}, ${orgId}, ${code}, ${code}, 'health', 'USD',
            'per_month', '250.0000', 'per_month', '500.0000',
            ${employeeComponentId}, ${employerComponentId},
            'full_month', 0, false, true, '2020-01-01')`);
  return planId;
}

async function seedWindow(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into hrm_enrollment_windows
      (id, org_id, name, kind, opens_on, closes_on, plan_year_start_on, applies_to, status)
    values (${id}, ${orgId}, ${`Window ${id.slice(0, 6)}`},
            'open_enrollment', '2026-01-01'::date, '2026-12-31'::date, '2026-01-01'::date,
            '{}'::jsonb, 'open')`);
  return id;
}

async function inputsForMonth(orgId: string, enrollmentId: string, coverageFrom: string): Promise<string[]> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from hrm_benefit_payroll_inputs
     where org_id = ${orgId} and enrollment_id = ${enrollmentId} and coverage_from = ${coverageFrom}::date
  `)).rows;
  return rows.map((r) => r.id);
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof BenefitsError, `expected BenefitsError, got ${String(e)}`);
    return { code: e.code, message: e.message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("H-BENEFIT-PAYINPUT: generation and void stay inside the actor's lens", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const adminId = await createScratchUser(org.orgId, "Benefits Admin", "payinput_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.benefits.read", "hrm.benefits.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empA = await seedEmployment(org.orgId, org.subsidiaryId);
    const empB = await seedEmployment(org.orgId, subB);
    const planId = await seedPlan(org.orgId);
    const windowId = await seedWindow(org.orgId);
    const electA = await electEnrollment({
      orgId: org.orgId, actorId: adminId, employmentId: empA,
      planId, windowId, effectiveFrom: "2026-01-01",
    });
    const electB = await electEnrollment({
      orgId: org.orgId, actorId: adminId, employmentId: empB,
      planId, windowId, effectiveFrom: "2026-01-01",
    });

    const managerA = await createScratchUser(org.orgId, "Benefits Manager A", "payinput_mgr_a");
    await scopeRole(org.orgId, "payinput_mgr_a", ["hrm.benefits.manage"], [org.subsidiaryId]);

    // The unrestricted admin materializes both employees' rows.
    const full = await generateBenefitPayrollInputs({ orgId: org.orgId, actorId: adminId, coverageMonth: "2026-03" });
    assert.equal(full.length, 4);
    const bInputId = full.find((r) => r.employmentId === empB)!.id;

    // The A-scoped manager's month holds only A's rows — B's enrollments
    // are neither materialized in storage nor returned.
    const scoped = await generateBenefitPayrollInputs({ orgId: org.orgId, actorId: managerA, coverageMonth: "2026-04" });
    assert.equal(scoped.length, 2);
    assert.ok(scoped.every((r) => r.employmentId === empA));
    assert.deepEqual(await inputsForMonth(org.orgId, electB.id, "2026-04-01"), [], "no B row materialized");
    assert.equal((await inputsForMonth(org.orgId, electA.id, "2026-04-01")).length, 2);

    // Voiding B's input refuses exactly like a fabricated id — the
    // A-scoped actor can neither void B's money nor probe its ids.
    const hidden = await refusalOf(
      voidBenefitPayrollInput({ orgId: org.orgId, actorId: managerA, inputId: bInputId, reason: "probe" }),
    );
    const fabricated = await refusalOf(
      voidBenefitPayrollInput({ orgId: org.orgId, actorId: managerA, inputId: randomUUID(), reason: "probe" }),
    );
    assert.deepEqual(hidden, fabricated);
    assert.equal(hidden.code, "NOT_FOUND");

    // The in-scope void still lands with its reason.
    const aInputId = (await inputsForMonth(org.orgId, electA.id, "2026-04-01"))[0]!;
    const voided = await voidBenefitPayrollInput({
      orgId: org.orgId, actorId: managerA, inputId: aInputId, reason: "duplicate month",
    });
    assert.equal(voided.status, "voided");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
