import { seedPayrollAccountingConfiguration } from '../testing/fixtures.ts';
import { validateBenefitContributionConfiguration } from "../hrm/benefits/contributions.ts";
import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson,
  seedPayrollProfile, seedPayrollWage, createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";

/** Per-hour benefit contributions counted over an explicit component list. */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string; subsidiaryId: string; actorId: string; scheduleId: string;
  accounts: { burdenExpense: string; otherPayable: string };
}

async function account(orgId: string, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into accounts(id,org_id,number,name,type,is_active) values(${id},${orgId},${number},${name},${type},true)`);
  return id;
}

async function payrollOrg(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const accounts = {
    wageExpense: await account(org.orgId, "6000", "Wages expense", "expense"),
    burdenExpense: await account(org.orgId, "6010", "Payroll burden", "expense"),
    netPayable: await account(org.orgId, "2300", "Wages payable", "liability_current"),
    craPayable: await account(org.orgId, "2310", "CRA payable", "liability_current"),
    vacationPayable: await account(org.orgId, "2320", "Vacation payable", "liability_current"),
    otherPayable: await account(org.orgId, "2330", "Other payable", "liability_current"),
  };
  await seedPayrollAccountingConfiguration(org.orgId, {
    wageExpenseAccountId: accounts.wageExpense,
    burdenExpenseAccountId: accounts.burdenExpense,
    netPayAccountId: accounts.netPayable,
    cppPayableAccountId: accounts.craPayable,
    eiPayableAccountId: accounts.craPayable,
    taxPayableAccountId: accounts.craPayable,
    vacationPayableAccountId: accounts.vacationPayable,
    wagesTo: "expense",
  });
  await seedPayrollComponents(org.orgId, actorId, "CA");
  await seedOntarioEhtFixture(org.orgId, actorId);
  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: 'Weekly', frequency: 'weekly', periodsPerYear: 52, anchorPeriodEnd: '2026-07-18',
    payDateOffsetDays: 3,
  });
  return { orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, scheduleId, accounts };
}

async function employee(fx: Fixture, name: string): Promise<{ partyId: string; employmentId: string }> {
  const id = randomUUID();
  await seedPayrollPerson(fx.orgId, id, name);
  await seedPayrollEmployeeRole(fx.orgId, id, { id: randomUUID(), workerCompGroupId: null, terminatedOn: null });
  await seedPayrollWage(fx.orgId, id, fx.actorId, {
    currency: "CAD", rate: "30", basis: "hour",
    annualHours: "2080", effectiveFrom: '2026-01-01',
  });
  const employmentId = await seedWorkerEmployment(fx.orgId, id, fx.subsidiaryId);
  await seedPayrollProfile(fx.orgId, id, employmentId, fx.scheduleId, fx.actorId, {
    country: 'CA', province: 'ON', payBasis: "hourly", federalClaimCode: 1,
    provincialClaimCode: 1,
  }, { percentFloor: "4", method: 'accrue' });
  return { partyId: id, employmentId };
}

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
    const planId = randomUUID(), enrollmentId = randomUUID();
    await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${planId},${fx.orgId},'PENSION','Pension plan','retirement','CAD',${fx.subsidiaryId},'2026-01-01')`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
    const employerRuleId = randomUUID(), employeeRuleId = randomUUID();
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
    ] as const) {
      await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,hours_basis,
        proration,effective_from,run_applicability)
        values(${ruleId},${fx.orgId},${planId},${code},${code},${role},${componentId},'per_hour',0,'elected_rate','selected_components','none','2026-01-01','all_pay_runs')`);
      for (const counted of [regular, overtime, doubletime, stat, deposit]) {
        await db.execute(sql`insert into hrm_benefit_contribution_rule_components(org_id,plan_id,rule_id,pay_component_id)
          values(${fx.orgId},${planId},${ruleId},${counted})`);
      }
      await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,source_decimal,provenance)
        values(${randomUUID()},${fx.orgId},${enrollmentId},${ruleId},'fixed',${code === 'PENSION_ER' ? '1.54' : '11.00'},'2026-01-01',${code === 'PENSION_ER' ? '1.54' : '11.00'},'{"source":"approved payroll election"}'::jsonb)`);
    }
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
