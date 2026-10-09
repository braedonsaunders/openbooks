import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { dropScratchOrgReporting } from '../testing/fixtures.ts';
import { seedHourlyPayrollOrg, seedHourlyPayrollEmployee } from '../testing/payroll-hourly-fixture.ts';
import { createPayRun, discardPayRun } from './run-lifecycle.ts';
import { calculatePayRun } from './run-calculation.ts';
import { mutatePayRunAdjustment } from './run-adjustments.ts';
import { withdrawUnusedEnrollment } from '../hrm/benefits/enrollments.ts';
import { enableFeatures, grantPermissions } from '../testing/hrm-harness.ts';

test('regular-only benefit premiums exclude supplemental and one-off runs while all-run premiums remain',
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedHourlyPayrollOrg();
    try {
      await enableFeatures(fx.orgId, ['payroll', 'hrm']);
      await grantPermissions(fx.orgId, fx.actorId, ['hrm.benefits.manage']);
      const { partyId, employmentId } = await seedHourlyPayrollEmployee(fx, 'Benefit Premium Employee');
      const planId = randomUUID(), enrollmentId = randomUUID();
      await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
        values(${planId},${fx.orgId},'PREMIUM','Employer premiums','other','CAD',${fx.subsidiaryId},'2026-01-01')`);
      await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
        values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
      const ruleIds: string[] = [];
      for (const [code, applicability] of [['REGULAR_PREMIUM', 'regular_only'], ['ALL_RUN_PREMIUM', 'all_pay_runs']] as const) {
        const componentId = randomUUID(), ruleId = randomUUID();
        ruleIds.push(ruleId);
        await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
          tax_treatment,payment_kind,expense_account_id,liability_account_id)
          values(${componentId},${fx.orgId},${code},${code},'employer_contribution','CA',false,false,false,false,
            'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
        await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,
          basis,rate,rate_formula,proration,effective_from,run_applicability)
          values(${ruleId},${fx.orgId},${planId},${code},${code},'employer_contribution',${componentId},
            'per_period',0,'elected_rate','none','2026-01-01',${applicability})`);
        await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,
          effective_from,source_decimal,provenance)
          values(${randomUUID()},${fx.orgId},${enrollmentId},${ruleId},'fixed','10','2026-01-01','10',
            '{"source":"approved employer premium"}'::jsonb)`);
      }
      await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),
        submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),updated_by=${fx.actorId},
        decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active'
        where org_id=${fx.orgId} and id=${enrollmentId}`);
      const base = (await db.execute<{ id: string }>(sql`select id from pay_components
        where org_id=${fx.orgId} and system_key='base_pay' and kind='earning'`)).rows[0]!;
      for (const runType of ['regular', 'supplemental', 'bonus', 'retro'] as const) {
        const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: '2026-07-12', periodEnd: '2026-07-18', runType });
        await mutatePayRunAdjustment({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId,
          mutation: { action: 'add', employeePartyId: partyId, componentId: base.id, amount: '1000', replaceComponent: true } });
        assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId })).errors, []);
        const allocations = (await db.execute<{ rule_id: string; amount: string }>(sql`select rule_id,amount::text
          from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}
          order by rule_id`)).rows;
        assert.deepEqual(new Map(allocations.map(row => [row.rule_id, row.amount])),
          new Map((runType === 'regular' ? ruleIds : ruleIds.slice(1)).map(id => [id, '10.0000'])), runType);
        await assert.rejects(withdrawUnusedEnrollment({ orgId: fx.orgId, actorId: fx.actorId,
          enrollmentId, reason: 'Contribution basis correction' }), /payroll allocation history/);
        assert.equal((await db.execute<{ status: string }>(sql`select status from hrm_benefit_enrollments
          where org_id=${fx.orgId} and id=${enrollmentId}`)).rows[0]!.status, 'active');
        await discardPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      }
      assert.equal((await withdrawUnusedEnrollment({ orgId: fx.orgId, actorId: fx.actorId,
        enrollmentId, reason: 'Unused contribution basis correction' })).status, 'cancelled');
    } finally { await dropScratchOrgReporting(fx.orgId); }
  });
