import { validateBenefitContributionConfiguration } from "../hrm/benefits/contributions.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { seedHourlyPayrollOrg as payrollOrg, seedHourlyPayrollEmployee as employee, type HourlyPayrollFixture as Fixture } from "../testing/payroll-hourly-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { sum } from "../money/money.ts";
import { errorChainMatches } from "../testing/error-chain.ts";

/** Per-hour benefit contributions counted over an explicit component list. */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function earningComponent(fx: Fixture, code: string, kind = 'earning'): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
    tax_treatment,payment_kind,expense_account_id,liability_account_id)
    values(${id},${fx.orgId},${code},${code},${kind},'CA',true,true,true,true,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
  return id;
}

test('selected-components hours count signed earning hours and ignore quantity units', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId, employmentId } = await employee(fx, 'Selected Hours Employee');
    // Counted earning components; trips is the quantity unit and stays unlisted.
    const regular = await earningComponent(fx, 'REGULAR');
    const overtime = await earningComponent(fx, 'OVERTIME');
    const doubletime = await earningComponent(fx, 'DOUBLE');
    const stat = await earningComponent(fx, 'STAT8');
    const deposit = await earningComponent(fx, 'BANKDEPOSIT');
    const trips = await earningComponent(fx, 'TRIPS');
    await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,deposit_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${randomUUID()},${fx.orgId},'SELECTED_BANK','Banked selected hours','hours','accrue','manual',${deposit},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
    const planId = randomUUID(), enrollmentId = randomUUID();
    await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${planId},${fx.orgId},'PENSION','Pension plan','retirement','CAD',${fx.subsidiaryId},'2026-01-01')`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
    const employerRuleId = randomUUID(), employeeRuleId = randomUUID(), cashRuleId = randomUUID();
    const cashComponentId = await earningComponent(fx, 'HOURS_INCENTIVE');
    const employerComponentId = randomUUID(), employeeComponentId = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
      tax_treatment,payment_kind,expense_account_id,liability_account_id)
      values(${employerComponentId},${fx.orgId},'PENSION_ER','Pension employer','employer_contribution','CA',true,true,true,false,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
      tax_treatment,payment_kind,expense_account_id,liability_account_id)
      values(${employeeComponentId},${fx.orgId},'PENSION_EE','Pension employee','deduction','CA',true,true,true,false,'pension_f','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
    for (const [ruleId, code, role, componentId] of [
      [employerRuleId, 'PENSION_ER', 'employer_contribution', employerComponentId],
      [employeeRuleId, 'PENSION_EE', 'employee_deduction', employeeComponentId],
      [cashRuleId, 'HOURS_INCENTIVE', 'cash_earning', cashComponentId],
    ] as const) {
      await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,hours_basis,
        proration,effective_from,run_applicability)
        values(${ruleId},${fx.orgId},${planId},${code},${code},${role},${componentId},'per_hour',0,'elected_rate','selected_components','none','2026-01-01','all_pay_runs')`);
      for (const counted of role === 'cash_earning' ? [overtime, doubletime] : [regular, overtime, doubletime, stat, deposit]) {
        await db.execute(sql`insert into hrm_benefit_contribution_rule_components(org_id,plan_id,rule_id,pay_component_id)
          values(${fx.orgId},${planId},${ruleId},${counted})`);
      }
      const rate = role === 'cash_earning' ? '5' : code === 'PENSION_ER' ? '1.54' : '11.00';
      await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,source_decimal,provenance)
        values(${randomUUID()},${fx.orgId},${enrollmentId},${ruleId},'fixed',${rate},'2026-01-01',${rate},'{"source":"approved payroll election"}'::jsonb)`);
    }
    await assert.rejects(() => validateBenefitContributionConfiguration(db, fx.orgId, 'benefit-contribution-rule-components',
      { planId, ruleId: cashRuleId, payComponentId: cashComponentId }), /cannot count its own output hours.*original earning components/);
    await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),
      submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),updated_by=${fx.actorId},
      decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active'
      where org_id=${fx.orgId} and id=${enrollmentId}`);
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    // 30 regular + 6 overtime + 4 double-time + 8 stat − 10 banked away; 3
    // trips carry money but no hours and are never counted.
    const inputs: [string, string | null, string][] = [
      [regular, '30', '900'], [overtime, '6', '270'], [doubletime, '4', '240'],
      [stat, '8', '240'], [deposit, '-10', '-300'], [trips, null, '90'],
    ];
    for (const [componentId, hours, amount] of inputs) {
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
        values(${fx.orgId},${run.documentId},${partyId},'line',${componentId},${amount},${hours})`);
    }
    const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.deepEqual(result.errors, []);
    const rows = (await db.execute<{ code: string; amount: string }>(sql`select c.code,l.amount::text as amount
      from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id join pay_components c on c.org_id=l.org_id and c.id=l.component_id
      where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and c.code in ('PENSION_ER','PENSION_EE')`)).rows;
    const amounts = new Map(rows.map(l => [l.code, l.amount]));
    assert.equal(amounts.get('PENSION_ER'), '58.5200', '38 counted hours at 1.54');
    assert.equal(amounts.get('PENSION_EE'), '418.0000', '38 counted hours at 11.00');
    const incentive = (await db.execute<{ amount: string; hours: string | null; vacationable: boolean }>(sql`select l.amount::text,l.hours::text,c.vacationable from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      join pay_components c on c.org_id=l.org_id and c.id=l.component_id
      where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.component_id=${cashComponentId}`)).rows;
    assert.deepEqual(incentive, [{ amount: '50.0000', hours: null, vacationable: true }], 'Ten original overtime hours are valued once without duplicating worked hours');
    const allocation = (await db.execute<{ amount: string; source_snapshot: { basis: { hours: string; currencyMinorUnits: number }; rule: { kind: string } } }>(sql`select amount::text,source_snapshot from pay_run_benefit_allocations
      where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} and rule_id=${cashRuleId}`)).rows;
    assert.equal(allocation.length, 1);
    assert.equal(allocation[0]!.source_snapshot.basis.hours, '10.0000');
    assert.equal(allocation[0]!.source_snapshot.basis.currencyMinorUnits, 2);
    assert.equal(allocation[0]!.source_snapshot.rule.kind, 'cash_earning');
    const earningHours = (await db.execute<{ hours: string }>(sql`select l.hours::text from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.kind='earning' and l.hours is not null`)).rows;
    assert.equal(sum(earningHours.map(row => row.hours)), '38.0000');
    const replay = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.deepEqual(replay.errors, []);
    assert.equal((await db.execute(sql`select id from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} and rule_id=${cashRuleId}`)).rows.length, 1);
    // A provider amount and an elected native earning cannot both own the same payout.
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount) values(${fx.orgId},${run.documentId},${partyId},'line',${cashComponentId},'50')`);
    const duplicate = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.equal(duplicate.errors.length, 1);
    assert.match(duplicate.errors[0]!.message, /HOURS_INCENTIVE.*sole source.*never added twice/);
    assert.equal((await db.execute(sql`select id from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} and rule_id=${cashRuleId}`)).rows.length, 0, 'Refused calculation cannot retain a partial incentive allocation');
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('a selected-components rule with no listed components refuses with its remedy', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId, employmentId } = await employee(fx, 'Unlisted Hours Employee');
    const regular = await earningComponent(fx, 'REGULAR2');
    const planId = randomUUID(), enrollmentId = randomUUID(), ruleId = randomUUID(), termId = randomUUID();
    await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${planId},${fx.orgId},'PENSION2','Pension plan','retirement','CAD',${fx.subsidiaryId},'2026-01-01')`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
    const componentId = await earningComponent(fx, 'PENSION2_ER', 'employer_contribution');
    await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,hours_basis,
      proration,effective_from,run_applicability)
      values(${ruleId},${fx.orgId},${planId},'PENSION2_ER','Pension employer','employer_contribution',${componentId},'per_hour',0,'elected_rate','selected_components','none','2026-01-01','all_pay_runs')`);
    await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,source_decimal,provenance)
      values(${termId},${fx.orgId},${enrollmentId},${ruleId},'fixed','1.54','2026-01-01','1.54','{"source":"approved payroll election"}'::jsonb)`);
    await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),
      submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),updated_by=${fx.actorId},
      decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active'
      where org_id=${fx.orgId} and id=${enrollmentId}`);
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
      values(${fx.orgId},${run.documentId},${partyId},'line',${regular},'900','30')`);
    const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /PENSION2_ER.*counts selected components but none are listed/);
    // Setup refuses the non-earning link by name before the run ever sees it.
    const deductionId = await earningComponent(fx, 'DUESX');
    await db.execute(sql`update pay_components set kind='deduction' where org_id=${fx.orgId} and id=${deductionId}`);
    await assert.rejects(
      () => validateBenefitContributionConfiguration(db, fx.orgId, 'benefit-contribution-rule-components',
        { planId, ruleId, payComponentId: deductionId }),
      /DUESX.*is not an earning component/,
    );
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('period-end hourly policy counts paid units once while default coverage retains its dated slice', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId, employmentId } = await employee(fx, 'Period-end Hours Employee');
    const units = await earningComponent(fx, 'PAID_UNITS');
    const planId = randomUUID(), enrollmentId = randomUUID();
    await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${planId},${fx.orgId},'PERIOD_END','Period-end contribution','retirement','CAD',${fx.subsidiaryId},'2026-01-01')`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,effective_to,currency)
      values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-07-18','2026-07-18','CAD')`);
    const rules: { id: string; componentId: string; mode: string }[] = [];
    for (const mode of ['earned_dates', 'pay_period_end']) {
      const componentId = await earningComponent(fx, `CONTRIBUTION_${mode}`, 'employer_contribution');
      const ruleId = randomUUID();
      const body = { planId, ruleKey: mode, name: mode, kind: 'employer_contribution', payComponentId: componentId,
        basis: 'per_hour', rate: '1.54', rateFormula: 'elected_rate', hoursBasis: 'selected_components', hoursCoverage: mode,
        proration: 'none', runApplicability: 'all_pay_runs', unpaidPeriodTreatment: 'charge', effectiveFrom: '2026-01-01' };
      await validateBenefitContributionConfiguration(db, fx.orgId, 'benefit-contribution-rules', body);
      await assert.rejects(() => validateBenefitContributionConfiguration(db, fx.orgId, 'benefit-contribution-rules',
        { ...body, hoursCoverage: 'unknown' }), /Declare hour eligibility/);
      await assert.rejects(() => validateBenefitContributionConfiguration(db, fx.orgId, 'benefit-contribution-rules',
        { ...body, basis: 'per_period', hoursCoverage: 'pay_period_end' }), /requires a per-hour basis/);
      await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,hours_basis,hours_coverage,proration,effective_from,run_applicability)
        values(${ruleId},${fx.orgId},${planId},${mode},${mode},'employer_contribution',${componentId},'per_hour','1.54','elected_rate','selected_components',${mode},'none','2026-01-01','all_pay_runs')`);
      await db.execute(sql`insert into hrm_benefit_contribution_rule_components(org_id,plan_id,rule_id,pay_component_id)
        values(${fx.orgId},${planId},${ruleId},${units})`);
      await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,effective_to)
        values(${randomUUID()},${fx.orgId},${enrollmentId},${ruleId},'fixed','1.54','2026-07-18','2026-07-18')`);
      rules.push({ id: ruleId, componentId, mode });
    }
    await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),
      submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),updated_by=${fx.actorId},
      decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active'
      where org_id=${fx.orgId} and id=${enrollmentId}`);
    const submission = (await db.execute<{ source: { contributions: { hoursCoverage: string }[] } }>(sql`select submission_snapshot as source from hrm_benefit_enrollments where org_id=${fx.orgId} and id=${enrollmentId}`)).rows[0]!.source;
    assert.deepEqual(submission.contributions.map(row => row.hoursCoverage).sort(), ['earned_dates', 'pay_period_end'], 'Native approval evidence includes the selected hour eligibility');
    await assert.rejects(() => db.transaction(async tx => {
      await tx.execute(sql`update hrm_benefit_contribution_rules set hours_coverage='pay_period_end' where org_id=${fx.orgId} and id=${rules[0]!.id}`);
    }), error => errorChainMatches(error, /submitted election evidence/));
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
      values(${fx.orgId},${run.documentId},${partyId},'line',${units},'700','14')`);
    const before = (await db.execute(sql`select id,amount::text,hours::text from pay_run_adjustments where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} order by id`)).rows;
    for (let pass = 0; pass < 2; pass++) {
      const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.deepEqual(result.errors, []);
      const allocations = (await db.execute<{ rule_id: string; amount: string; source_snapshot: { basis: { hours: string }; coverage: { earningsFrom: string; earningsTo: string } } }>(sql`
        select rule_id,amount::text,source_snapshot from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`)).rows;
      assert.equal(allocations.length, 2, 'Recalculation records each elected contribution once');
      for (const rule of rules) {
        const allocation = allocations.find(row => row.rule_id === rule.id)!;
        assert.equal(allocation.amount, rule.mode === 'pay_period_end' ? '21.5600' : '3.0800');
        assert.equal(allocation.source_snapshot.basis.hours, rule.mode === 'pay_period_end' ? '14.0000' : '2.0000');
        assert.equal(allocation.source_snapshot.coverage.earningsFrom, rule.mode === 'pay_period_end' ? '2026-07-12' : '2026-07-18');
      }
    }
    assert.deepEqual((await db.execute(sql`select id,amount::text,hours::text from pay_run_adjustments where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} order by id`)).rows, before, 'Policy selection never rewrites paid units');
    const next = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-19', periodEnd: '2026-07-25' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
      values(${fx.orgId},${next.documentId},${partyId},'line',${units},'700','14')`);
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: next.documentId })).errors, []);
    assert.equal((await db.execute(sql`select id from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${next.documentId}`)).rows.length, 0, 'An ended election is not reused for a later period');
  } finally { await dropScratchOrgReporting(fx.orgId); }
});
