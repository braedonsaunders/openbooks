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
} from "../testing/fixtures.ts";
import {
  DB,
  grantPermissions,
  linkPerson,
  seedComponent,
  seedEmployment,
  seedPlan,
  seededContributionTerms,
  seedWindow,
  setupHarness,
  withHarness,
} from "../testing/hrm-harness.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { decideGate } from "../flows/gates.ts";
import {
  createChangeRequestDraft,
  submitChangeRequest,
} from "./change-requests.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { BenefitsError } from "./benefits/errors.ts";
import {
  cancelEnrollment,
  changeEnrollment,
  electEnrollment,
  endEnrollment,
  endEnrollmentsForTermination,
  waiveEnrollment,
  withdrawUnusedEnrollment,
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
  listEnrollments,
  myEnrollments,
} from "./benefits/benefits-read.ts";
import { installEngineSeams } from "../composition/install.ts";

// Gate releases and post_document run through the installed engine
// seams; without this the gates strand on a not-registered
// refusal instead of releasing.
installEngineSeams();

/**
 * HR-8 DB coverage (integration partition — run at the integration gate;
 * skips without OPENBOOKS_DB_URL): migration 0197 bootstraps plus RLS,
 * every named refusal through the real code path, the termination hook
 * through the real change-request apply path (and its rollback),
 * fixed and policy-following native contribution elections, the RLS
 * second-org case, and the self-service scope.
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone; every refusal asserts the writes that must NOT exist.
 */

const BENEFITS_SPEC = {
  users: [
    { key: "adminId", name: "Benefits Admin", handle: "benefits_admin", permissions: ["hrm.benefits.read", "hrm.benefits.manage"], link: true },
    { key: "employeeId", name: "Benefits Employee", handle: "benefits_employee", permissions: ["hrm.benefits.read"] },
    { key: "outsiderId", name: "Benefits Outsider", handle: "benefits_outsider", link: true },
  ],
} as const;

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
  await withHarness(() => setupHarness(BENEFITS_SPEC), async () => {
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

test("elect happy path stores fixed contribution terms and evidences activation", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
      windowId,
      effectiveFrom: "2026-03-01",
    });
    assert.equal(dto.status, "active");
    assert.equal(dto.currency, "USD");
    const stored = (await db.execute<{ employee: string; employer: string }>(sql`
      select employee_amount_per_period::text as employee, employer_amount_per_period::text as employer
        from hrm_benefit_enrollments where id = ${dto.id}
    `)).rows[0]!;
    assert.equal(stored.employee, null);
    assert.equal(stored.employer, null);
    const terms = (await db.execute<{ rate: string; mode: string }>(sql`select elected_rate::text as rate,election_mode as mode from hrm_benefit_enrollment_terms where enrollment_id=${dto.id} order by elected_rate`)).rows;
    assert.deepEqual(terms.map(t => [t.rate,t.mode]), [['250.0000000000','fixed'],['500.0000000000','fixed']]);
    assert.deepEqual((await eventsOf(dto.id)).map((e) => e.kind), ["elected", "activated"]);
  });
});

test("unused coverage withdrawal preserves approved evidence and permits a newly approved replacement", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async h => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const terms = await seededContributionTerms(h.org.orgId, planId);
    const first = await electEnrollment({ orgId: h.org.orgId, actorId: h.adminId, employmentId, planId,
      effectiveFrom: "2026-03-01", lifeEventReason: "Contribution election", contributionTerms: terms });
    const evidence = async () => (await db.execute(sql`select submission_snapshot,decision_snapshot,effective_from,effective_to
      from hrm_benefit_enrollments where org_id=${h.org.orgId} and id=${first.id}`)).rows[0];
    const original = await evidence();
    await assertStorageRefusal(db.execute(sql`update hrm_benefit_enrollments set status='cancelled',ended_reason='Correction',updated_by=${h.adminId}
      where org_id=${h.org.orgId} and id=${first.id}`), /lifecycle transition/i);
    for (const [context, actor] of [["wrong-context", h.adminId], [`${h.org.orgId}:${first.id}:${h.adminId}`, null]] as const) {
      await assertStorageRefusal(db.transaction(async tx => {
        await tx.execute(sql`select set_config('openbooks.hrm_benefit_withdrawal',${context},true)`);
        await tx.execute(sql`update hrm_benefit_enrollments set status='cancelled',ended_reason='Correction',updated_by=${actor}
          where org_id=${h.org.orgId} and id=${first.id}`);
      }), /lifecycle transition/i);
    }
    const result = await withdrawUnusedEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: first.id,
      reason: "Incorrect contribution basis" });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(await evidence(), original);
    assert.match((await eventsOf(first.id)).at(-1)!.reason, /Incorrect contribution basis/);
    await assert.rejects(withdrawUnusedEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: first.id,
      reason: "Repeated withdrawal" }), /Only active or ended unused coverage/);
    await db.execute(sql`update hrm_benefit_plans set approval_mode='flows' where org_id=${h.org.orgId} and id=${planId}`);
    await seedApprovalFlow(h.org.orgId, { subjectKind: 'hrm_benefit_enrollment', assignees: [{ type: 'user', userId: h.adminId }], mode: 'any', preventSelfApproval: false });
    const replacement = await electEnrollment({ orgId: h.org.orgId, actorId: h.adminId, employmentId, planId,
      effectiveFrom: "2026-03-01", lifeEventReason: "Corrected contribution basis", contributionTerms: terms });
    assert.equal(replacement.status, "pending_approval");
  });
});

test("unused coverage withdrawal preserves legacy pending and voided payroll input history", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async h => {
    for (const status of ["pending", "voided"] as const) {
      const { employmentId, workerPartyId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
      const { planId } = await seedPlan(h.org.orgId);
      const first = await electEnrollment({ orgId: h.org.orgId, actorId: h.adminId, employmentId, planId,
        effectiveFrom: "2026-03-01", lifeEventReason: "Contribution election", contributionTerms: await seededContributionTerms(h.org.orgId, planId) });
      const component = (await db.execute<{ id: string }>(sql`select pay_component_id as id from hrm_benefit_contribution_rules
        where org_id=${h.org.orgId} and plan_id=${planId} and kind='employee_deduction' limit 1`)).rows[0]!;
      // Reconstruct pre-retirement evidence only in the disposable fixture transaction.
      // The exact trigger lock prevents other writers from observing its suspension.
      await db.transaction(async tx => {
        const scratch = (await tx.execute(sql`select id from orgs where id=${h.org.orgId} and name like 'Scratch %' for update`)).rows;
        assert.equal(scratch.length, 1);
        await tx.execute(sql`alter table public.hrm_benefit_payroll_inputs disable trigger benefit_monthly_queue_retired_trigger`);
        await tx.execute(sql`insert into hrm_benefit_payroll_inputs
          (org_id,enrollment_id,employee_party_id,employment_id,kind,pay_component_id,amount,currency,coverage_from,coverage_to,status)
          values (${h.org.orgId},${first.id},${workerPartyId},${employmentId},'benefit_deduction',${component.id},25,'USD','2026-03-01','2026-03-31',${status})`);
        await tx.execute(sql`set constraints all immediate`);
        await tx.execute(sql`alter table public.hrm_benefit_payroll_inputs enable trigger benefit_monthly_queue_retired_trigger`);
      });
      const evidence = async () => (await db.execute(sql`select * from hrm_benefit_payroll_inputs where org_id=${h.org.orgId} and enrollment_id=${first.id}`)).rows;
      const original = await evidence();
      await assert.rejects(withdrawUnusedEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: first.id,
        reason: "Contribution correction" }), /legacy payroll input history/);
      await assertStorageRefusal(db.transaction(async tx => {
        await tx.execute(sql`select set_config('openbooks.hrm_benefit_withdrawal',${`${h.org.orgId}:${first.id}:${h.adminId}`},true)`);
        await tx.execute(sql`update hrm_benefit_enrollments set status='cancelled',ended_reason='Correction',updated_by=${h.adminId}
          where org_id=${h.org.orgId} and id=${first.id}`);
      }), /lifecycle transition/i);
      assert.deepEqual(await evidence(), original);
      assert.equal((await enrollmentsOf(h.org.orgId, employmentId))[0]!.status, "active");
      assert.deepEqual((await eventsOf(first.id)).map(e => e.kind), ["life_event", "activated"]);
    }
  });
});

test("unused coverage withdrawal refuses an outstanding successor proposal", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async h => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const { planId } = await seedPlan(h.org.orgId);
    const first = await electEnrollment({ orgId: h.org.orgId, actorId: h.adminId, employmentId, planId,
      effectiveFrom: "2026-03-01", lifeEventReason: "Contribution election", contributionTerms: await seededContributionTerms(h.org.orgId, planId) });
    await db.execute(sql`update hrm_benefit_plans set approval_mode='flows' where org_id=${h.org.orgId} and id=${planId}`);
    await seedApprovalFlow(h.org.orgId, { subjectKind: 'hrm_benefit_enrollment', assignees: [{ type: 'user', userId: h.adminId }], mode: 'any', preventSelfApproval: false });
    await changeEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: first.id,
      changeDate: "2026-04-01", reason: "Contribution change" });
    await assert.rejects(withdrawUnusedEnrollment({ orgId: h.org.orgId, actorId: h.adminId, enrollmentId: first.id,
      reason: "Incorrect contribution basis" }), /successor election awaits approval/);
    assert.equal((await enrollmentsOf(h.org.orgId, employmentId)).find(e => e.id === first.id)!.status, "active");
  });
});

test("native Flows authorize a successor without interrupting prior coverage", {skip: !DB}, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC),async h=>{
    const {employmentId}=await seedEmployment(h.org.orgId,h.org.subsidiaryId);
    const {planId}=await seedPlan(h.org.orgId);
    const windowId=await seedWindow(h.org.orgId);
    const first=await electEnrollment({orgId:h.org.orgId,actorId:h.adminId,employmentId,planId,windowId,effectiveFrom:'2026-03-01',contributionTerms:await seededContributionTerms(h.org.orgId,planId)});
    await db.execute(sql`update hrm_benefit_plans set approval_mode='flows' where org_id=${h.org.orgId} and id=${planId}`);
    await seedApprovalFlow(h.org.orgId,{subjectKind:'hrm_benefit_enrollment',assignees:[{type:'user',userId:h.adminId}],mode:'any',preventSelfApproval:false});
    const next=await changeEnrollment({orgId:h.org.orgId,actorId:h.adminId,enrollmentId:first.id,changeDate:'2026-04-01',reason:'Contribution election changed',contributionTerms:(await seededContributionTerms(h.org.orgId,planId)).map(t=>({...t,electedRate:'300'}))});
    assert.equal(next.status,'pending_approval');
    assert.equal((await enrollmentsOf(h.org.orgId,employmentId)).find(e=>e.id===first.id)?.status,'active');
    await assertStorageRefusal(db.execute(sql`update hrm_benefit_enrollment_terms set elected_rate=400 where org_id=${h.org.orgId} and enrollment_id=${next.id}`),/submitted contribution elections are immutable/i);
    const gate=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${h.org.orgId} and subject_kind='hrm_benefit_enrollment' and subject_id=${next.id} and status='pending'`)).rows[0]!;
    await assertStorageRefusal(db.transaction(async tx=>{
      await tx.execute(sql`update flow_gates set status='approved',decided_by=${h.adminId},decided_at=now() where org_id=${h.org.orgId} and id=${gate.id}`);
      await tx.execute(sql`update hrm_benefit_enrollments set status='ended',effective_to='2026-03-31' where org_id=${h.org.orgId} and id=${first.id}`);
      await tx.execute(sql`update hrm_benefit_enrollments set status='active',updated_by=${h.adminId},decision_snapshot=jsonb_build_object('outcome','approved','mode','human','runId',flow_run_id) where org_id=${h.org.orgId} and id=${next.id}`);
    }),/approval stages remain incomplete|assigned native Flow decision/i);
    await decideGate({gateId:gate.id,decision:'approved',userId:h.adminId});
    assert.deepEqual((await enrollmentsOf(h.org.orgId,employmentId)).map(e=>[e.status,e.effective_to]),[['ended','2026-03-31'],['active',null]]);
    await assertStorageRefusal(db.execute(sql`update hrm_benefit_enrollments set class_key='other' where org_id=${h.org.orgId} and id=${next.id}`),/submitted benefit evidence is immutable/i);
  });
});

test("elect refusals leave no rows: plan, employment, window, tier, component", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const base = {
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
      windowId,
      effectiveFrom: "2026-03-01",
    };
    const count = () => enrollmentCount(h.org.orgId);

    await assertBenefitsRefusal(
      () => electEnrollment({ ...base, effectiveFrom: "2000-01-01" }),
      /no employment episode covers/,
      count,
    );
    const { employmentId: terminatedId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { status: "terminated", displayName: "Benefits Worker" });
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

    const tiered = await seedPlan(h.org.orgId, { classes: true });
    const tierTerms = await seededContributionTerms(h.org.orgId, tiered.planId);
    const afterLife = await enrollmentCount(h.org.orgId);
    const sinceLife = async () => (await enrollmentCount(h.org.orgId)) - afterLife;
    await assertBenefitsRefusal(() => electEnrollment({ ...base, planId: tiered.planId, contributionTerms: undefined }), /record the contribution elections/i, sinceLife);
    await assertBenefitsRefusal(() => electEnrollment({ ...base, planId: tiered.planId, contributionTerms: tierTerms, classKey: 'platinum' }), /selected contribution class is not on this plan/i, sinceLife);
    await assertBenefitsRefusal(() => electEnrollment({ ...base, planId: tiered.planId, contributionTerms: [{ ...tierTerms[0]!, electedRate: '-1' }] }), /must be non-negative/, sinceLife);
    await electEnrollment({ ...base, planId: tiered.planId, contributionTerms: tierTerms, classKey: 'family' });
    await assertBenefitsRefusal(() => electEnrollment({ ...base, planId: tiered.planId, contributionTerms: tierTerms, classKey: 'single' }), /already holds this plan/, async () => (await enrollmentCount(h.org.orgId)) - 2);
    const noRules = await seedPlan(h.org.orgId);
    await db.execute(sql`delete from hrm_benefit_contribution_rules where org_id=${h.org.orgId} and plan_id=${noRules.planId}`);
    await assertBenefitsRefusal(() => electEnrollment({ ...base, planId: noRules.planId }), /add effective contribution rules/i, async () => (await enrollmentCount(h.org.orgId)) - 2);
    const badEmployer = await seedPlan(h.org.orgId);
    const wrongKind = await seedComponent(h.org.orgId, { kind: 'deduction' });
    await db.execute(sql`update hrm_benefit_contribution_rules set pay_component_id=${wrongKind} where org_id=${h.org.orgId} and plan_id=${badEmployer.planId} and kind='employer_contribution'`);
    await assertBenefitsRefusal(() => electEnrollment({ ...base, planId: badEmployer.planId }), /Link an active user payroll component.*employer contribution/, async () => (await enrollmentCount(h.org.orgId)) - 2);
  });
});

test("waive evidences decline; reason required", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
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
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    const { planId } = await seedPlan(h.org.orgId, { classes: true });
    const windowId = await seedWindow(h.org.orgId);
    const first = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
      windowId,
      classKey: "single",
      effectiveFrom: "2026-01-01",
    });
    const second = await changeEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      enrollmentId: first.id,
      changeDate: "2026-04-01",
      classKey: "family",
      contributionTerms: (await seededContributionTerms(h.org.orgId, planId)).map(t => ({...t,electedRate: t.electedRate.startsWith("250.") ? "600" : "900"})),
      reason: "new child",
    });
    const changedTerms = (await db.execute<{ rate: string }>(sql`select elected_rate::text as rate from hrm_benefit_enrollment_terms where enrollment_id=${second.id} order by elected_rate`)).rows;
    assert.deepEqual(changedTerms.map(t => t.rate), ['600.0000000000','900.0000000000']);
    assert.equal(second.effectiveFrom, "2026-04-01");
    const rows = await enrollmentsOf(h.org.orgId, employmentId);
    assert.deepEqual(rows.map((r) => [r.status, r.effective_to]), [
      ["ended", "2026-03-31"],
      ["active", null],
    ]);
    assert.deepEqual((await eventsOf(second.id)).map((e) => e.kind), ["elected", "changed", "activated"]);
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
    const pendingPlan = await seedPlan(h.org.orgId, { approval_mode: "flows" });
    await seedApprovalFlow(h.org.orgId,{subjectKind:"hrm_benefit_enrollment",assignees:[{type:"user",userId:h.adminId}],mode:"any",preventSelfApproval:false});
    const pending = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: pendingPlan.planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, pendingPlan.planId),
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
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
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
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    const { planId } = await seedPlan(h.org.orgId, { approval_mode: "flows" });
    await seedApprovalFlow(h.org.orgId,{subjectKind:"hrm_benefit_enrollment",assignees:[{type:"user",userId:h.adminId}],mode:"any",preventSelfApproval:false});
    const pending = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
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

test("dependents link within one employment and refuse across it", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
    const empA = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    const empB = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const election = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId: empA.employmentId,
      planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
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
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
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
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
      windowId,
      effectiveFrom: "2026-02-01",
    });
    // A lapsed election keeps its history untouched by the hook.
    const lapsed = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: otherPlan.planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, otherPlan.planId),
      windowId,
      effectiveFrom: "2026-03-01",
      effectiveTo: "2026-06-30",
    });
    const future = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId: otherPlan.planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, otherPlan.planId),
      windowId,
      effectiveFrom: "2026-12-01",
    });
    await assertStorageRefusal(db.execute(sql`update hrm_benefit_enrollments set status='cancelled' where org_id=${h.org.orgId} and id=${future.id}`),/lifecycle transition is not permitted/i);
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
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
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
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const mine = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.employeeId,
      employmentId,
      planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
      windowId,
      effectiveFrom: "2026-03-01",
      selfService: true,
    });
    assert.equal(mine.status, "active");
    const { employmentId: otherId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    await assert.rejects(
      electEnrollment({
        orgId: h.org.orgId,
        actorId: h.employeeId,
        employmentId: otherId,
        planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
        windowId,
        effectiveFrom: "2026-03-01",
        selfService: true,
      }),
      (e: unknown) => e instanceof HrmAuthorizationError && /your own employment/.test(e.message),
    );
    const own = await withOrgTransaction(h.org.orgId, () => myEnrollments(db, h.org.orgId, h.employeeId));
    assert.deepEqual(own.map((e) => e.id), [mine.id]);
    await assert.rejects(
      withOrgTransaction(h.org.orgId, () => listEnrollments(db, h.org.orgId, h.outsiderId)),
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

test("storage guards refuse event rewrites and history deletes", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BENEFITS_SPEC), async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Benefits Worker" });
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId);
    const dto = await electEnrollment({
      orgId: h.org.orgId,
      actorId: h.adminId,
      employmentId,
      planId,
      contributionTerms: await seededContributionTerms(h.org.orgId, planId),
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
