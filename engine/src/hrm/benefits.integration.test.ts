import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { decideGate } from "../flows/gates.ts";
import {
  createChangeRequestDraft,
  submitChangeRequest,
} from "./change-requests.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { BenefitsError } from "./benefits/errors.ts";
import {
  approveEnrollment,
  cancelEnrollment,
  changeEnrollment,
  electEnrollment,
  endEnrollment,
  endEnrollmentsForTermination,
  waiveEnrollment,
} from "./benefits/enrollments.ts";
import {
  linkDependent,
  unlinkDependent,
  createDependent,
  deactivateDependent,
} from "./benefits/dependents.ts";
import {
  closeEnrollmentWindow,
  openEnrollmentWindow,
} from "./benefits/windows.ts";
import {
  generateBenefitPayrollInputs,
  voidBenefitPayrollInput,
} from "./benefits/benefits-payroll.ts";
import {
  listEnrollments,
  myEnrollments,
} from "./benefits/benefits-read.ts";

/**
 * HR-8 DB coverage (integration partition — run by the integrator at gate;
 * skips without OPENBOOKS_DB_URL): migration 0197 bootstraps plus RLS,
 * every named refusal through the real code path, the termination hook
 * through the real change-request apply path (and its rollback),
 * idempotent input generation with the consumed/voided refusals, the RLS
 * second-org case, and the self-service scope.
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone; every refusal asserts the writes that must NOT exist.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  adminId: string;
  employeeId: string;
  outsiderId: string;
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

async function linkPerson(orgId: string, userId: string, partyId?: string): Promise<string> {
  const id = partyId ?? randomUUID();
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

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const adminId = await createScratchUser(org.orgId, "Benefits Admin", "benefits_admin");
  const employeeId = await createScratchUser(org.orgId, "Benefits Employee", "benefits_employee");
  const outsiderId = await createScratchUser(org.orgId, "Benefits Outsider", "benefits_outsider");
  await grantPermissions(org.orgId, adminId, ["hrm.benefits.read", "hrm.benefits.manage"]);
  await grantPermissions(org.orgId, employeeId, ["hrm.benefits.read"]);
  await linkPerson(org.orgId, adminId);
  await linkPerson(org.orgId, outsiderId);
  return { org, adminId, employeeId, outsiderId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedEmployment(
  orgId: string,
  subsidiaryId: string,
  opts: { workerPartyId?: string; status?: string; from?: string; to?: string | null } = {},
): Promise<{ employmentId: string; workerPartyId: string }> {
  const workerPartyId = opts.workerPartyId ?? randomUUID();
  if (!opts.workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerPartyId}, ${orgId}, 'person', 'Benefits Worker', true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, ${opts.status ?? "active"}, ${opts.from ?? "2020-01-01"}::date, ${opts.to ?? null}::date, now())
  `);
  return { employmentId, workerPartyId };
}

async function seedComponent(orgId: string, code: string, kind: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, is_active)
    values (${id}, ${orgId}, ${code}, ${code}, ${kind}, true)
  `);
  return id;
}

interface PlanSeed {
  readonly planId: string;
  readonly employeeComponentId: string;
  readonly employerComponentId: string;
}

async function seedPlan(
  orgId: string,
  overrides: Record<string, unknown> = {},
): Promise<PlanSeed> {
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
            'full_month', 0, false, true, '2020-01-01')
  `);
  if (overrides.levels === true) {
    await db.execute(sql`
      insert into hrm_benefit_plan_levels (org_id, plan_id, level_key, label, employee_cost, employer_cost, position)
      values (${orgId}, ${planId}, 'single', 'Employee only', '250.0000', '500.0000', 0),
             (${orgId}, ${planId}, 'family', 'Family', '600.0000', '900.0000', 1)
    `);
  }
  for (const [column, value] of Object.entries(overrides)) {
    if (column === "levels") continue;
    await db.execute(sql`
      update hrm_benefit_plans set ${sql.identifier(column)} = ${value as string}
       where org_id = ${orgId} and id = ${planId}
    `);
  }
  return { planId, employeeComponentId, employerComponentId };
}

async function seedWindow(
  orgId: string,
  overrides: { status?: string; kind?: string; opensOn?: string; closesOn?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into hrm_enrollment_windows
      (id, org_id, name, kind, opens_on, closes_on, plan_year_start_on, applies_to, status)
    values (${id}, ${orgId}, ${`Window ${id.slice(0, 6)}`},
            ${overrides.kind ?? "open_enrollment"}, ${overrides.opensOn ?? "2026-01-01"}::date,
            ${overrides.closesOn ?? "2026-12-31"}::date, '2026-01-01'::date,
            '{}'::jsonb, ${overrides.status ?? "open"})
  `);
  return id;
}

async function seedSchedule(orgId: string, periodsPerYear: number): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
    values (${id}, ${orgId}, ${`Sched ${id.slice(0, 6)}`}, 'biweekly', ${periodsPerYear}, '2026-01-01'::date)
  `);
  return id;
}

async function stampProfile(orgId: string, employmentId: string, workerPartyId: string, scheduleId: string): Promise<void> {
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id, country, province)
    values (${orgId}, ${workerPartyId}, ${employmentId}, ${scheduleId}, 'US', 'TX')
  `);
}

async function enrollmentsOf(orgId: string, employmentId: string): Promise<Array<{ id: string; status: string; effective_to: string | null }>> {
  const rows = (await db.execute<{ id: string; status: string; effective_to: string | null }>(sql`
    select id, status, effective_to::text as effective_to from hrm_benefit_enrollments
     where org_id = ${orgId} and employment_id = ${employmentId} order by effective_from
  `)).rows;
  return rows;
}

async function eventsOf(enrollmentId: string): Promise<Array<{ kind: string; reason: string }>> {
  const rows = (await db.execute<{ kind: string; reason: string }>(sql`
    select kind, reason from hrm_benefit_events where enrollment_id = ${enrollmentId} order by recorded_at
  `)).rows;
  return rows;
}

async function inputsOf(enrollmentId: string): Promise<Array<{ kind: string; amount: string; currency: string; from: string; to: string; status: string; component: string }>> {
  const rows = (await db.execute<{ kind: string; amount: string; currency: string; from: string; to: string; status: string; component: string }>(sql`
    select kind, amount::text as amount, currency, coverage_from::text as "from",
           coverage_to::text as "to", status, pay_component_id::text as component
      from hrm_benefit_payroll_inputs where enrollment_id = ${enrollmentId}
      order by kind, coverage_from
  `)).rows;
  return rows;
}

async function assertBenefitsRefusal(
  fn: () => Promise<unknown>,
  pattern: RegExp,
  absent: () => Promise<number>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof BenefitsError, `expected a BenefitsError, got ${String(error)}`);
    assert.match((error as Error).message, pattern);
    assert.equal(await absent(), 0, "a refused write leaves no rows behind");
    return;
  }
  assert.fail("expected a refusal");
}

async function assertStorageRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (e: unknown) => {
    const text = e instanceof Error ? `${e.message} ${(e as { cause?: unknown }).cause ?? ""}` : String(e);
    return pattern.test(text);
  });
}

async function enrollmentCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_benefit_enrollments where org_id = ${orgId}
  `)).rows;
  return rows[0]!.n;
}

test("migration 0197 bootstraps: eight tables, RLS forced, 0194 intact", { skip: !DB }, async () => {
  await withHarness(async () => {
    const tables = [
      "hrm_benefit_plans",
      "hrm_benefit_plan_levels",
      "hrm_enrollment_windows",
      "hrm_benefit_enrollments",
      "hrm_benefit_dependents",
      "hrm_enrollment_dependents",
      "hrm_benefit_events",
      "hrm_benefit_payroll_inputs",
    ];
    for (const table of tables) {
      const reg = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = ${table}
      `)).rows[0]!.n;
      assert.equal(reg, 1, `${table} exists`);
      const rls = (await db.execute<{ rowsecurity: boolean; forcerowsecurity: boolean }>(sql`
        select c.relrowsecurity as rowsecurity, c.relforcerowsecurity as forcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ${table}
      `)).rows[0]!;
      assert.equal(rls.rowsecurity, true, `${table} has RLS`);
      assert.equal(rls.forcerowsecurity, true, `${table} forces RLS`);
    }
    const uniques = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_constraint
       where conname = 'hrm_benefit_payroll_inputs_enrollment_kind_month_unique'
    `)).rows[0]!.n;
    assert.equal(uniques, 1, "monthly idempotency unique exists");
    const pcUnique = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_constraint where conname = 'pay_components_org_id_id_unique'
    `)).rows[0]!.n;
    assert.equal(pcUnique, 1, "pay_components carries the additive tenant unique");
    // 0194 intact: its tables, kind check, and no amount column.
    const leaveTables = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_tables where schemaname = 'public'
        and tablename in ('hrm_leave_types', 'hrm_leave_policies', 'hrm_leave_requests', 'hrm_absences', 'hrm_payroll_inputs')
    `)).rows[0]!.n;
    assert.equal(leaveTables, 5, "0194 tables intact");
    const amountCol = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'public' and table_name = 'hrm_payroll_inputs' and column_name = 'amount'
    `)).rows[0]!.n;
    assert.equal(amountCol, 0, "0194 inputs carry no amount column");
  });
});

test("elect happy path stores basis amounts and evidences activation", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-03-01",
    });
    assert.equal(dto.status, "active");
    assert.equal(dto.employeeAmountPerPeriod, "250.0000");
    assert.equal(dto.employerAmountPerPeriod, "500.0000");
    assert.equal(dto.currency, "USD");
    const stored = (await db.execute<{ employee: string; employer: string }>(sql`
      select employee_amount_per_period::text as employee, employer_amount_per_period::text as employer
        from hrm_benefit_enrollments where id = ${dto.id}
    `)).rows[0]!;
    assert.equal(stored.employee, "250.0000");
    assert.equal(stored.employer, "500.0000");
    assert.deepEqual((await eventsOf(dto.id)).map((e) => e.kind), ["elected", "activated"]);
  });
});

test("approval-required plans pend then approve; double approve refused", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId, { requires_approval: true });
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-03-01",
    });
    assert.equal(dto.status, "pending_approval");
    const approved = await approveEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: dto.id });
    assert.equal(approved.status, "active");
    assert.deepEqual((await eventsOf(dto.id)).map((e) => e.kind), ["elected", "approved"]);
    await assert.rejects(
      approveEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: dto.id }),
      (e: unknown) => e instanceof BenefitsError && /only a pending approval is approved/.test(e.message),
    );
  });
});

test("elect refusals leave no rows: plan, employment, window, tier, component", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const base = {
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-03-01",
    };
    const count = () => enrollmentCount(h.org.orgId);

    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, effectiveFrom: "2000-01-01" }),
      /no employment episode covers/,
      count,
    );
    const { employmentId: terminatedId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { status: "terminated" });
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, employmentId: terminatedId }),
      /is terminated on/,
      count,
    );
    const retired = await seedPlan(h.org.orgId, { is_active: false });
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: retired.planId }),
      /is retired/,
      count,
    );
    const future = await seedPlan(h.org.orgId, {});
    await db.execute(sql`update hrm_benefit_plans set effective_from = '2027-01-01'::date where id = ${future.planId}`);
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: future.planId }),
      /is not offered from/,
      count,
    );
    const otherSub = randomUUID();
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country) values (${otherSub}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'Other', 'USD', 'US')`);
    const scoped = await seedPlan(h.org.orgId, {});
    await db.execute(sql`update hrm_benefit_plans set employer_subsidiary_id = ${otherSub} where id = ${scoped.planId}`);
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: scoped.planId }),
      /not offered to this employment's employer subsidiary/,
      count,
    );
    const waiting = await seedPlan(h.org.orgId, { waiting_period_days: 90 });
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: waiting.planId, effectiveFrom: "2020-02-01" }),
      /needs 90 days of service/,
      count,
    );
    const draftWindow = await seedWindow(h.org.orgId, { status: "draft" });
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, windowId: draftWindow }),
      /is draft/,
      count,
    );
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, windowId: null }),
      /no open window and no life event/,
      count,
    );
    // Life-event path admits without a window.
    const life = await electEnrollment({
      ...base,
      windowId: null,
      lifeEventReason: "marriage",
    });
    assert.equal(life.status, "active");
    assert.deepEqual((await eventsOf(life.id)).map((e) => e.kind), ["life_event", "activated"]);

    // Tiers.
    const tiered = await seedPlan(h.org.orgId, { levels: true });
    const afterLife = await enrollmentCount(h.org.orgId);
    const sinceLife = async () => (await enrollmentCount(h.org.orgId)) - afterLife;
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: tiered.planId }),
      /prices tiers \(single, family\)/,
      sinceLife,
    );
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: tiered.planId, coverageLevelKey: "platinum" }),
      /is not a tier of plan/,
      sinceLife,
    );
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, coverageLevelKey: "single" }),
      /prices no coverage tiers/,
      sinceLife,
    );
    // Overlap: elect family tier, then elect again over the same dates.
    await electEnrollment({ ...base, planId: tiered.planId, coverageLevelKey: "family" });
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: tiered.planId, coverageLevelKey: "single" }),
      /already holds this plan/,
      async () => (await enrollmentCount(h.org.orgId)) - 2,
    );
    // Components.
    const noComponent = await seedPlan(h.org.orgId, {});
    await db.execute(sql`update hrm_benefit_plans set employee_pay_component_id = null where id = ${noComponent.planId}`);
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: noComponent.planId }),
      /names no employee pay component/,
      async () => (await enrollmentCount(h.org.orgId)) - 2,
    );
    const wrongKind = await seedComponent(h.org.orgId, `W_${randomUUID().slice(0, 6)}`, "deduction");
    const badEmployer = await seedPlan(h.org.orgId, {});
    await db.execute(sql`update hrm_benefit_plans set employer_pay_component_id = ${wrongKind} where id = ${badEmployer.planId}`);
    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, planId: badEmployer.planId }),
      /must be kind employer_contribution/,
      async () => (await enrollmentCount(h.org.orgId)) - 2,
    );
  });
});

test("waive evidences decline; reason required", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const dto = await waiveEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-03-01",
      reason: "covered by spouse",
    });
    assert.equal(dto.status, "waived");
    assert.equal(dto.employeeAmountPerPeriod, null);
    assert.deepEqual((await eventsOf(dto.id)).map((e) => e.kind), ["waived"]);
    await assert.rejects(
      waiveEnrollment({
        orgId: h.org.orgId,
        actorId: h.adminId,
        employmentId,
        planId,
        windowId,
        effectiveFrom: "2026-04-01",
        reason: "  ",
      }),
      (e: unknown) => e instanceof BenefitsError && /needs a reason/.test(e.message),
    );
  });
});

test("change ends and opens anew; end and cancel hold their boundaries", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId, { levels: true });
    const windowId = await seedWindow(h.org.orgId);
    const first = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      coverageLevelKey: "single",
      effectiveFrom: "2026-01-01",
    });
    const second = await changeEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      enrollmentId: first.id,
      changeDate: "2026-04-01",
      coverageLevelKey: "family",
      reason: "new child",
    });
    assert.equal(second.coverageLevelKey, "family");
    assert.equal(second.employeeAmountPerPeriod, "600.0000");
    assert.equal(second.effectiveFrom, "2026-04-01");
    const rows = await enrollmentsOf(h.org.orgId, employmentId);
    assert.deepEqual(rows.map((r) => [r.status, r.effective_to]), [
      ["ended", "2026-03-31"],
      ["active", null],
    ]);
    assert.deepEqual((await eventsOf(second.id)).map((e) => e.kind), ["elected", "changed"]);
    await assert.rejects(
      changeEnrollment({
        orgId: h.org.orgId,
        actorId: h.adminId,
        enrollmentId: first.id,
        changeDate: "2026-05-01",
        reason: "again",
      }),
      (e: unknown) => e instanceof BenefitsError && /only an active enrolment is changed/.test(e.message),
    );
    // End the survivor.
    const ended = await endEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      enrollmentId: second.id,
      endedOn: "2026-06-15",
      reason: "left plan",
    });
    assert.equal(ended.status, "ended");
    assert.equal(ended.effectiveTo, "2026-06-15");
    await assert.rejects(
      cancelEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: second.id, reason: "oops" }),
      (e: unknown) => e instanceof BenefitsError && /only a not-yet-active enrolment is cancelled/.test(e.message),
    );
    // Cancel a pending instead.
    const pendingPlan = await seedPlan(h.org.orgId, { requires_approval: true });
    const pending = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: pendingPlan.planId,
      windowId,
      effectiveFrom: "2026-07-01",
    });
    const cancelled = await cancelEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      enrollmentId: pending.id,
      reason: "withdrew",
    });
    assert.equal(cancelled.status, "cancelled");
  });
});

test("windows open with overlap refusal; close cancels pendings with events", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const draftId = await seedWindow(h.org.orgId, { status: "draft" });
    const opened = await openEnrollmentWindow({ orgId: h.org.orgId, actorId: h.adminId, windowId: draftId });
    assert.equal(opened.status, "open");
    await assert.rejects(
      openEnrollmentWindow({ orgId: h.org.orgId, actorId: h.adminId, windowId: draftId }),
      (e: unknown) => e instanceof BenefitsError && /only a draft opens/.test(e.message),
    );
    const clashId = await seedWindow(h.org.orgId, { status: "draft", opensOn: "2026-06-01", closesOn: "2026-09-30" });
    await assert.rejects(
      openEnrollmentWindow({ orgId: h.org.orgId, actorId: h.adminId, windowId: clashId }),
      (e: unknown) => e instanceof BenefitsError && /overlaps open window/.test(e.message),
    );
    // Pending election cancelled with its own event on close.
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId, { requires_approval: true });
    const pending = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId: draftId,
      effectiveFrom: "2026-03-01",
    });
    await assert.rejects(
      closeEnrollmentWindow({ orgId: h.org.orgId, actorId: h.adminId, windowId: draftId, reason: " " }),
      (e: unknown) => e instanceof BenefitsError && /needs a reason/.test(e.message),
    );
    const closed = await closeEnrollmentWindow({
      orgId: h.org.orgId,
      actorId: h.adminId,
      windowId: draftId,
      reason: "year ended",
    });
    assert.equal(closed.status, "closed");
    const rows = await enrollmentsOf(h.org.orgId, employmentId);
    assert.equal(rows[0]!.status, "cancelled");
    const events = await eventsOf(pending.id);
    assert.deepEqual(events.map((e) => e.kind), ["elected", "cancelled"]);
    assert.match(events[1]!.reason, /year ended/);
  });
});

test("generation writes monthly rows, prorates daily, idempotent on retry", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const seed = await seedPlan(h.org.orgId, {});
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: seed.planId,
      windowId,
      effectiveFrom: "2026-01-01",
    });
    const first = await generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" });
    assert.equal(first.length, 2);
    const again = await generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" });
    assert.deepEqual(again.map((r) => r.id).sort(), first.map((r) => r.id).sort(), "retry lands on the same rows");
    const stored = await inputsOf(dto.id);
    assert.deepEqual(stored.map((r) => [r.kind, r.amount, r.currency, r.from, r.to, r.status]), [
      ["benefit_deduction", "250.0000", "USD", "2026-03-01", "2026-03-31", "pending"],
      ["employer_contribution", "500.0000", "USD", "2026-03-01", "2026-03-31", "pending"],
    ]);
    assert.equal(stored[0]!.component, seed.employeeComponentId);
    assert.equal(stored[1]!.component, seed.employerComponentId);
    // Daily proration on a mid-month election.
    const daily = await seedPlan(h.org.orgId, { proration_basis: "daily" });
    const mid = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: daily.planId,
      windowId,
      effectiveFrom: "2026-04-11",
    });
    await generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-04" });
    const midRows = await inputsOf(mid.id);
    // 20 of 30 April days: 250*20/30 = 166.6667; 500*20/30 = 333.3333.
    assert.deepEqual(midRows.map((r) => [r.kind, r.amount, r.from, r.to]), [
      ["benefit_deduction", "166.6667", "2026-04-11", "2026-04-30"],
      ["employer_contribution", "333.3333", "2026-04-11", "2026-04-30"],
    ]);
  });
});

test("concurrent generators for one month share one row per kind without aborting", async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const seed = await seedPlan(h.org.orgId, {});
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: seed.planId,
      windowId,
      effectiveFrom: "2026-01-01",
    });
    // Two generators on two connections at once: the unique constraint
    // arbitrates, the loser re-reads the winner, and neither transaction
    // aborts (a 23505 caught inside the open transaction used to fail every
    // later statement with 25P02 and roll both generations back).
    const query = { orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" };
    const [first, second] = await Promise.all([
      generateBenefitPayrollInputs(query),
      generateBenefitPayrollInputs(query),
    ]);
    for (const [index, result] of [first, second].entries()) {
      assert.equal(result.length, 2, `generator ${index} returns both kinds`);
    }
    assert.deepEqual(first.map((r) => r.id).sort(), second.map((r) => r.id).sort(), "both generators land on the same rows");
    const stored = await inputsOf(dto.id);
    assert.equal(stored.length, 2, "exactly one row per kind survives the race");
    assert.deepEqual(stored.map((r) => [r.kind, r.amount, r.status]), [
      ["benefit_deduction", "250.0000", "pending"],
      ["employer_contribution", "500.0000", "pending"],
    ]);
  });
});

test("generation converts per_period by schedule and refuses guesses", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId, workerPartyId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const windowId = await seedWindow(h.org.orgId);
    const periodic = await seedPlan(h.org.orgId, { employee_cost_basis: "per_period", employer_cost_basis: "per_period" });
    await db.execute(sql`
      update hrm_benefit_plans set employee_cost = '100.0000', employer_cost = '50.0000'
       where id = ${periodic.planId}
    `);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: periodic.planId,
      windowId,
      effectiveFrom: "2026-01-01",
    });
    // No stamped schedule: refused by name, nothing written.
    await assert.rejects(
      generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" }),
      (e: unknown) => e instanceof BenefitsError && /no usable pay schedule/.test(e.message),
    );
    assert.equal((await inputsOf(dto.id)).length, 0);
    // 26-period schedule: 100*26/12 = 216.6667; 50*26/12 = 108.3333.
    const scheduleId = await seedSchedule(h.org.orgId, 26);
    await stampProfile(h.org.orgId, employmentId, workerPartyId, scheduleId);
    await generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" });
    assert.deepEqual((await inputsOf(dto.id)).map((r) => [r.kind, r.amount]), [
      ["benefit_deduction", "216.6667"],
      ["employer_contribution", "108.3333"],
    ]);
    // percent_of_pay: refused by name until the run supplies the basis.
    const pct = await seedPlan(h.org.orgId, { employee_cost_basis: "percent_of_pay", employer_cost_basis: "per_month" });
    await db.execute(sql`
      update hrm_benefit_plans set employee_cost = '6.0000' where id = ${pct.planId}
    `);
    const pctDto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: pct.planId,
      windowId,
      effectiveFrom: "2026-05-01",
    });
    await assert.rejects(
      generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-05" }),
      (e: unknown) => e instanceof BenefitsError && /has not supplied the pay basis/.test(e.message),
    );
    assert.equal((await inputsOf(pctDto.id)).length, 0, "a refused month writes no rows");
  });
});

test("consumed months refuse, voided months stay voided, void keeps the link", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-01-01",
    });
    await generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" });
    const runId = randomUUID();
    const deductionId = await inputIdOf(dto.id, "benefit_deduction");
    const contributionId = await inputIdOf(dto.id, "employer_contribution");
    // Void the still-pending contribution first: clean void, no run link.
    const voidedPending = await voidBenefitPayrollInput({
      orgId: h.org.orgId,
      actorId: h.adminId,
      inputId: contributionId,
      reason: "duplicated month",
    });
    assert.equal(voidedPending.status, "voided");
    // Consume the deduction, then void it: the run link must survive.
    await db.execute(sql`
      update hrm_benefit_payroll_inputs
         set status = 'consumed', consumed_by_run_document_id = ${runId}, consumed_at = now()
       where id = ${deductionId}
    `);
    await assert.rejects(
      generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" }),
      (e: unknown) => e instanceof BenefitsError && new RegExp(runId).test(e.message),
    );
    const voidedConsumed = await voidBenefitPayrollInput({
      orgId: h.org.orgId,
      actorId: h.adminId,
      inputId: deductionId,
      reason: "stale calc",
    });
    assert.equal(voidedConsumed.status, "voided");
    const kept = (await db.execute<{ run: string | null }>(sql`
      select consumed_by_run_document_id::text as run from hrm_benefit_payroll_inputs where id = ${deductionId}
    `)).rows[0]!;
    assert.equal(kept.run, runId, "voiding never clears the run link");
    // Regenerating a voided month is refused: corrections carry a new election.
    await assert.rejects(
      generateBenefitPayrollInputs({ orgId: h.org.orgId, actorId: h.adminId, coverageMonth: "2026-03" }),
      (e: unknown) => e instanceof BenefitsError && /stays voided/.test(e.message),
    );
    // Storage guards: clearing the link or deleting rows is refused.
    await assertStorageRefusal(
      db.execute(sql`
        update hrm_benefit_payroll_inputs set consumed_by_run_document_id = null
         where id = ${deductionId}
      `),
      /keeps that link/,
    );
    await assertStorageRefusal(
      db.execute(sql`delete from hrm_benefit_payroll_inputs where enrollment_id = ${dto.id}`),
      /retained as history/,
    );
  });
});

async function inputIdOf(enrollmentId: string, kind: string): Promise<string> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from hrm_benefit_payroll_inputs where enrollment_id = ${enrollmentId} and kind = ${kind}
  `)).rows;
  return rows[0]!.id;
}

test("dependents link within one employment and refuse across it", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const empA = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const empB = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const election = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId: empA.employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-03-01",
    });
    const dependent = await createDependent({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId: empA.employmentId,
      relationship: "spouse",
      displayName: "Alex Partner",
    });
    await linkDependent({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: election.id, dependentId: dependent.id });
    // Idempotent re-link.
    await linkDependent({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: election.id, dependentId: dependent.id });
    const other = await createDependent({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId: empB.employmentId,
      relationship: "child",
      displayName: "Sam Other",
    });
    await assert.rejects(
      linkDependent({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: election.id, dependentId: other.id }),
      (e: unknown) => e instanceof BenefitsError && /different employment/.test(e.message),
    );
    await unlinkDependent({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: election.id, dependentId: dependent.id });
    await assert.rejects(
      unlinkDependent({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: election.id, dependentId: dependent.id }),
      (e: unknown) => e instanceof BenefitsError && /not covered/.test(e.message),
    );
    const retired = await deactivateDependent({ orgId: h.org.orgId, actorId: h.adminId, dependentId: dependent.id });
    assert.equal(retired.isActive, false);
  });
});

test("termination ends live enrolments in the same transaction", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await grantPermissions(h.org.orgId, h.adminId, ["hrm.employment.read", "hrm.employment.manage", "hrm.employment.approve"]);
    const deciderId = await createScratchUser(h.org.orgId, "Benefits Decider", "benefits_decider");
    await grantPermissions(h.org.orgId, deciderId, ["hrm.employment.read", "hrm.employment.approve"]);
    await linkPerson(h.org.orgId, deciderId);
    await seedApprovalFlow(h.org.orgId, {
      subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
      assignees: [{ type: "user", userId: deciderId }],
      mode: "any",
    });
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { from: "2026-01-01" });
    const { planId } = await seedPlan(h.org.orgId);
    const otherPlan = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const live = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-02-01",
    });
    // A lapsed election keeps its history untouched by the hook.
    const lapsed = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: otherPlan.planId,
      windowId,
      effectiveFrom: "2026-03-01",
      effectiveTo: "2026-06-30",
    });
    const future = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: otherPlan.planId,
      windowId,
      effectiveFrom: "2026-12-01",
    });
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      payload: { kind: "termination", effectiveDate: "2026-10-31" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.adminId, requestId: draft.id, reason: "resigned" });
    const gates = (await db.execute<{ id: string }>(sql`
      select id from flow_gates where subject_id = ${draft.id} order by created_at
    `)).rows;
    await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: deciderId });
    const rows = await enrollmentsOf(h.org.orgId, employmentId);
    assert.deepEqual(rows.map((r) => [r.status, r.effective_to]), [
      ["ended", "2026-10-30"],
      ["active", "2026-06-30"],
      ["cancelled", null],
    ]);
    const liveEvents = await eventsOf(live.id);
    assert.match(liveEvents[liveEvents.length - 1]!.reason, /terminated 2026-10-31/);
    assert.deepEqual((await eventsOf(lapsed.id)).map((e) => e.kind), ["elected", "activated"], "lapsed history untouched");
    const futureEvents = await eventsOf(future.id);
    assert.deepEqual(futureEvents.map((e) => e.kind), ["elected", "activated", "cancelled"]);
    // Rollback: a throw after the hook leaves the enrolment live.
    const { employmentId: emp2 } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { from: "2026-01-01" });
    const survivor = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId: emp2,
      planId,
      windowId,
      effectiveFrom: "2026-02-01",
    });
    await assert.rejects(
      withOrgTransaction(h.org.orgId, async () => {
        await endEnrollmentsForTermination(db, {
          orgId: h.org.orgId,
          actorId: h.adminId,
          employmentId: emp2,
          terminatedOn: "2026-10-31",
        });
        throw new Error("boom after hook");
      }),
      /boom after hook/,
    );
    const after = await enrollmentsOf(h.org.orgId, emp2);
    assert.deepEqual(after.map((r) => r.status), ["active"], "rollback restores the live enrolment");
    assert.equal((await eventsOf(survivor.id)).length, 2, "rollback removes the hook events too");
  });
});

test("RLS isolates orgs and self scope holds", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const mine = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.employeeId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-03-01",
      selfService: true,
    });
    assert.equal(mine.status, "active");
    const { employmentId: otherId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    await assert.rejects(
      electEnrollment({
        orgId: h.org.orgId,
        actorId: h.employeeId,
        employmentId: otherId,
        planId,
        windowId,
        effectiveFrom: "2026-03-01",
        selfService: true,
      }),
      (e: unknown) => e instanceof HrmAuthorizationError && /your own employment/.test(e.message),
    );
    const own = await withOrgContext(h.org.orgId, () => myEnrollments(db, h.org.orgId, h.employeeId));
    assert.deepEqual(own.map((e) => e.id), [mine.id]);
    await assert.rejects(
      withOrgContext(h.org.orgId, () => listEnrollments(db, h.org.orgId, h.outsiderId)),
      (e: unknown) => e instanceof HrmAuthorizationError,
    );
    // Second org sees zero rows at the storage floor.
    const foreign = await createScratchOrg();
    try {
      const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
      await client.connect();
      try {
        await client.query("select set_config('app.current_org', $1, false)", [foreign.orgId]);
        const res = await client.query("select count(*)::int as n from hrm_benefit_enrollments where id = $1", [mine.id]);
        assert.equal(res.rows[0].n, 0, "a foreign org session sees zero rows");
      } finally {
        await client.end();
      }
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });
});

async function withOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, fn);
}

test("storage guards refuse event rewrites and history deletes", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      windowId,
      effectiveFrom: "2026-03-01",
    });
    const eventId = (await db.execute<{ id: string }>(sql`
      select id from hrm_benefit_events where enrollment_id = ${dto.id} order by recorded_at limit 1
    `)).rows[0]!.id;
    await assertStorageRefusal(
      db.execute(sql`update hrm_benefit_events set reason = 'rewritten' where id = ${eventId}`),
      /immutable evidence/,
    );
    await assertStorageRefusal(
      db.execute(sql`delete from hrm_benefit_enrollments where id = ${dto.id}`),
      /retained as history/,
    );
    await assertStorageRefusal(
      db.execute(sql`delete from hrm_benefit_events where enrollment_id = ${dto.id}`),
      /never deleted/,
    );
  });
});
