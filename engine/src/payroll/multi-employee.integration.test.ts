import { seedPayrollAccountingConfiguration } from '../testing/fixtures.ts';
import { validateBenefitContributionConfiguration } from "../hrm/benefits/contributions.ts";
import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollTime, seedPostingAccount,
  seedPayrollProfile, seedPayrollWage, createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { setPackSlotAccount } from "./packs.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { recurringBenefitSource } from "./benefit-plan-inputs.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";
import { upsertUnionFringe } from "./union.ts";
import { requestDocumentVoid } from '../ledger/document-void.ts';
import { postDocument } from '../ledger/posting-document.ts';

/** Native payroll preserves each employee's movements, currencies and job allocations independently. */

const DB = !!process.env.OPENBOOKS_DB_URL;

test('native recurring elections produce taxable non-cash, employer cost and employee deductions once, with immutable run linkage', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const worker = await employee(fx, 'Recurring Benefit Employee');
    const employmentId = (await db.execute<{ employment_id: string }>(sql`select employment_id from employee_payroll_profiles where org_id=${fx.orgId} and employee_party_id=${worker}`)).rows[0]!.employment_id;
    await hours(fx,worker,'2026-07-14','50');
    const clearing = await account(fx.orgId,'1460','Benefit provider clearing','asset_current_other');
    const planId = randomUUID(), enrollmentId = randomUUID();
    await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${planId},${fx.orgId},'RECURRING','Recurring coverage','health','CAD',${fx.subsidiaryId},'2026-01-01')`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
    const declarations = [
      ['RRSP_EE','employee_deduction','per_hour','2','pension_f'],
      ['RRSP_ER','taxable_non_cash','per_hour','1','none'],
      ['RRSP_TOPUP','employee_deduction','per_period','5','pension_f'],
      ['MDM_TAX','taxable_non_cash','per_month','56.3333333333','none'],
      ['MDM_ER','employer_contribution','per_month','108.3333333333','none'],
      ['MDM_EE','employee_deduction','per_month','43.3333333333','none'],
      ['TRUST_EE','employee_deduction','per_period','2','none'],
    ] as const;
    const rules = new Map<string,string>();
    for (const [code,role,basis,rate,treatment] of declarations) {
      const componentId=randomUUID(),ruleId=randomUUID(),termId=randomUUID();
      const nonCash=role==='taxable_non_cash';
      await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
        tax_treatment,payment_kind,non_cash_account_id,expense_account_id,liability_account_id,basis_cap_hours_per_period)
        values(${componentId},${fx.orgId},${code},${code},${role==='employee_deduction'?'deduction':nonCash?'earning':'employer_contribution'},'CA',
        ${nonCash},${nonCash},false,${code==='MDM_TAX'},${treatment},${nonCash?'non_cash':'cash'},${nonCash?clearing:null},${fx.accounts.burdenExpense},${fx.accounts.otherPayable},${basis==='per_hour'?'40':null})`);
      await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,hours_basis,
        months_per_year,periods_per_year,proration,effective_from,run_applicability)
        values(${ruleId},${fx.orgId},${planId},${code},${code},${role},${componentId},${basis},0,'elected_rate',${basis==='per_hour'?'all_paid':null},
        ${basis==='per_month'?12:null},${basis==='per_month'?52:null},'none','2026-01-01',${code.startsWith('MDM')?'regular_only':'all_pay_runs'})`);
      await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,source_decimal,provenance)
        values(${termId},${fx.orgId},${enrollmentId},${ruleId},'fixed',${rate},'2026-01-01',${rate},'{"source":"approved payroll election"}'::jsonb)`);
      rules.set(code,ruleId);
    }
    await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),
      submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),updated_by=${fx.actorId},
      decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active'
      where org_id=${fx.orgId} and id=${enrollmentId}`);
    const source = await recurringBenefitSource(db, { orgId: fx.orgId, employmentId,
      subsidiaryId: fx.subsidiaryId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    assert.deepEqual(source.currencyPrecisions, [{ code: 'CAD', minor_units: 2 }],
      'effective recurring elections use the registered payable currency quantum');
    const run=await createPayRun({orgId:fx.orgId,actorId:fx.actorId,payScheduleId:fx.scheduleId,periodStart:'2026-07-12',periodEnd:'2026-07-18'});
    const calculate=()=>calculatePayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId});
    assert.deepEqual((await calculate()).errors,[]);
    const read=async()=> (await db.execute<{code:string;amount:string;payment_kind:string;kind:string}>(sql`select c.code,l.amount::text,l.payment_kind,l.kind
      from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id join pay_components c on c.org_id=l.org_id and c.id=l.component_id
      where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId}`)).rows;
    const rows=await read(), amounts=new Map(rows.map(l=>[l.code,l.amount]));
    assert.deepEqual(declarations.map(([code])=>[code,amounts.get(code)]),[
      ['RRSP_EE','80.0000'],['RRSP_ER','40.0000'],['RRSP_TOPUP','5.0000'],['MDM_TAX','13.0000'],['MDM_ER','25.0000'],['MDM_EE','10.0000'],['TRUST_EE','2.0000']]);
    assert.ok(rows.filter(l=>['RRSP_ER','MDM_TAX'].includes(l.code)).every(l=>l.kind==='earning'&&l.payment_kind==='non_cash'));
    const stub=(await db.execute<{gross:string;net_pay:string;pensionable:string;insurable:string;vacation_accrued:string}>(sql`select gross::text,net_pay::text,vacation_accrued::text,pensionable_earnings::text as pensionable,insurable_earnings::text as insurable from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`)).rows[0]!;
    assert.equal(stub.gross,'1553.0000'); assert.equal(stub.pensionable,'1553.0000'); assert.equal(stub.insurable,'1500.0000');
    assert.equal(stub.vacation_accrued,'60.5200','vacation includes the declared vacationable premium exactly once');
    const cyclicRule=(await db.execute<Record<string,unknown>>(sql`select * from hrm_benefit_contribution_rules where org_id=${fx.orgId} and id=${rules.get('MDM_TAX')}`)).rows[0]!;
    await assert.rejects(()=>validateBenefitContributionConfiguration(db,fx.orgId,'benefit-contribution-rules',{
      ...Object.fromEntries(Object.entries(cyclicRule).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase()),value])),
      basis:'percent_of_eligible_pay',payBasis:'all_cash_earnings',
    }),/circular vacation-pay basis.*regular cash earnings/);

    assert.equal(sum([stub.net_pay,...rows.filter(l=>l.kind==='deduction').map(l=>l.amount)]),'1500.0000','non-cash taxable value is never additional cash pay');
    const allocations=async()=> (await db.execute<{status:string;amount:string;pay_stub_line_id:string|null}>(sql`select status,amount::text,pay_stub_line_id from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`)).rows;
    assert.equal((await allocations()).length,7); assert.ok((await allocations()).every(a=>a.pay_stub_line_id!==null));
    assert.deepEqual((await calculate()).errors,[]); assert.equal((await allocations()).length,7,'recalculation replaces, rather than duplicates, period allocations');
    await db.execute(sql`update hrm_benefit_contribution_rules set rate=3 where org_id=${fx.orgId} and id=${rules.get('RRSP_EE')}`);
    await assert.rejects(commitPayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId}),/Benefit contribution.*changed after calculation.*recalculate/);
    assert.deepEqual((await calculate()).errors,[]);
    await commitPayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId});
    assert.ok((await allocations()).every(a=>a.status==='committed'));
    await assert.rejects(db.execute(sql`update hrm_benefit_contribution_rules set rate=4 where org_id=${fx.orgId} and id=${rules.get('RRSP_EE')}`),(error: unknown) => {
      const cause=(error as {cause?:{code?:string;message?:string}}).cause;
      assert.equal(cause?.code,'23514'); assert.match(cause?.message ?? '',/committed payroll evidence/); return true;
    });
    await db.execute(sql`update documents set status='approved' where org_id=${fx.orgId} and id=${run.documentId}`);
    const journalId=await postDocument(run.documentId,{control:fx.controlAccounts});
    const posted=(await db.execute<{total:string}>(sql`select sum(amount)::text as total from journal_lines where org_id=${fx.orgId} and entry_id=${journalId}`)).rows[0]!;
    assert.equal(posted.total,'0.0000','native payroll posting balances with non-cash and contribution offsets');
    const simulated=await calculatePayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId,simulate:true});
    assert.deepEqual(simulated.errors,[]); assert.ok((await allocations()).every(a=>a.status==='committed'&&a.pay_stub_line_id!==null));
    await requestDocumentVoid({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId,reason:'Reverse the payroll test period',reversalDate:'2026-07-31'});
    assert.ok((await allocations()).every(a=>a.status==='voided'));
    assert.equal((await db.execute<{balance:string}>(sql`select sum(l.amount)::text as balance from entitlement_ledger l join entitlement_plans p on p.org_id=l.org_id and p.id=l.plan_id
      where l.org_id=${fx.orgId} and l.employee_party_id=${worker} and p.system_key='vacation'`)).rows[0]!.balance,'0.0000','controlled reversal restores the complete vacation bank');

  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('unpaid employer coverage enters the native owe bank and recovers two actual periods when the employee contribution is zero', {skip:!DB}, async()=>{
  const fx=await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const worker=await employee(fx,'Employer-paid coverage employee');
    const employmentId=(await db.execute<{employment_id:string}>(sql`select employment_id from employee_payroll_profiles where org_id=${fx.orgId} and employee_party_id=${worker}`)).rows[0]!.employment_id;
    const clearing=await account(fx.orgId,'1460','Insurance provider clearing','asset_current_other');
    const plan=randomUUID(),enrollment=randomUUID(),bank=randomUUID(),deduction=randomUUID(),recovery=randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,liability_account_id)
      values(${deduction},${fx.orgId},'INS_RECOVERY','Insurance recovery','deduction','CA',false,false,false,false,${fx.accounts.otherPayable})`);
    await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id,created_by,updated_by)
      values(${bank},${fx.orgId},'INS_OWED','Unpaid insurance coverage','money','owe','manual',${deduction},${fx.actorId},${fx.actorId})`);
    await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${plan},${fx.orgId},'INSURANCE','Insurance','health','CAD',${fx.subsidiaryId},'2026-01-01')`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollment},${fx.orgId},${employmentId},${plan},'elected','2026-01-01','CAD')`);
    const declarations=[['RECOVERY','employee_deduction','0'],['TAX_PREMIUM','taxable_non_cash','13'],['EMPLOYER_PREMIUM','employer_contribution','25']] as const;
    for (const [code,kind,rate] of declarations) {
      const component=kind==='employee_deduction'?deduction:randomUUID(),rule=kind==='employee_deduction'?recovery:randomUUID();
      if (kind!=='employee_deduction') await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,payment_kind,non_cash_account_id,expense_account_id,liability_account_id)
        values(${component},${fx.orgId},${code},${code},${kind==='taxable_non_cash'?'earning':'employer_contribution'},'CA',${kind==='taxable_non_cash'},false,false,false,${kind==='taxable_non_cash'?'non_cash':'cash'},${kind==='taxable_non_cash'?clearing:null},${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
      await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,proration,effective_from,run_applicability,unpaid_period_treatment,arrears_plan_id,arrears_recovery_periods)
        values(${rule},${fx.orgId},${plan},${code},${code},${kind},${component},'per_period',0,'elected_rate','none','2026-01-01','regular_only','carry',${kind==='employee_deduction'?bank:null},${kind==='employee_deduction'?2:null})`);
      await db.execute(sql`insert into hrm_benefit_enrollment_terms(org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from)
        values(${fx.orgId},${enrollment},${rule},'fixed',${rate},'2026-01-01')`);
      if (kind!=='employee_deduction') await db.execute(sql`insert into hrm_benefit_recovery_sources(org_id,plan_id,rule_id,premium_rule_id) values(${fx.orgId},${plan},${recovery},${rule})`);
    }
    await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),
      decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active',updated_by=${fx.actorId} where org_id=${fx.orgId} and id=${enrollment}`);
    const calculate=async(start:string,end:string)=>{
      const run=await createPayRun({orgId:fx.orgId,actorId:fx.actorId,payScheduleId:fx.scheduleId,periodStart:start,periodEnd:end,employeePartyIds:[worker]});
      assert.deepEqual((await calculatePayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId})).errors,[]);
      await commitPayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId}); return run.documentId;
    };
    for (const [start,end] of [['2026-07-05','2026-07-11'],['2026-07-12','2026-07-18'],['2026-07-19','2026-07-25']]) await calculate(start!,end!);
    const balance=async()=> (await db.execute<{amount:string}>(sql`select sum(amount)::text as amount from entitlement_ledger where org_id=${fx.orgId} and plan_id=${bank} and employee_party_id=${worker}`)).rows[0]!.amount;
    assert.equal(await balance(),'-114.0000','employer-paid premiums are carried despite the zero employee election');
    const successorRule=randomUUID(),successorEnrollment=randomUUID();
    await db.execute(sql`update hrm_benefit_contribution_rules set effective_to='2026-07-25' where org_id=${fx.orgId} and id=${recovery}`);
    await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,proration,effective_from,run_applicability,unpaid_period_treatment,arrears_plan_id,arrears_recovery_periods)
      select ${successorRule},org_id,plan_id,'RECOVERY_FUTURE',name,kind,pay_component_id,basis,rate,rate_formula,proration,'2026-07-26',run_applicability,unpaid_period_treatment,arrears_plan_id,arrears_recovery_periods
      from hrm_benefit_contribution_rules where org_id=${fx.orgId} and id=${recovery}`);
    await db.execute(sql`insert into hrm_benefit_recovery_sources(org_id,plan_id,rule_id,premium_rule_id)
      select org_id,plan_id,${successorRule},premium_rule_id from hrm_benefit_recovery_sources where org_id=${fx.orgId} and rule_id=${recovery}`);
    await db.execute(sql`update hrm_benefit_enrollments set status='ended',effective_to='2026-07-25',ended_reason='Future coverage election' where org_id=${fx.orgId} and id=${enrollment}`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${successorEnrollment},${fx.orgId},${employmentId},${plan},'elected','2026-07-26','CAD')`);
    await db.execute(sql`insert into hrm_benefit_enrollment_terms(org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from)
      select org_id,${successorEnrollment},case when rule_id=${recovery} then ${successorRule}::uuid else rule_id end,election_mode,elected_rate,'2026-07-26'
      from hrm_benefit_enrollment_terms where org_id=${fx.orgId} and enrollment_id=${enrollment}`);
    await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),
      decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active',updated_by=${fx.actorId} where org_id=${fx.orgId} and id=${successorEnrollment}`);
    assert.equal(await balance(),'-114.0000','an effective-dated successor inherits the native bank without changing prior debt');
    await hours(fx,worker,'2026-07-28','40');
    const returned=await calculate('2026-07-26','2026-08-01');
    const amounts=(await db.execute<{code:string;amount:string}>(sql`select c.code,l.amount::text from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id join pay_components c on c.org_id=l.org_id and c.id=l.component_id where s.org_id=${fx.orgId} and s.pay_run_document_id=${returned} and c.id in (${deduction})`)).rows;
    assert.deepEqual(amounts,[{code:'INS_RECOVERY',amount:'76.0000'}],'recover two prior insured periods without adding current employer premiums to the deduction');
    assert.equal(await balance(),'-38.0000');
    const receipt=(await db.execute<{stub_line_id:string|null}>(sql`select stub_line_id from entitlement_ledger where org_id=${fx.orgId} and plan_id=${bank} and pay_run_document_id=${returned} and kind='repayment'`)).rows[0]!;
    assert.ok(receipt.stub_line_id,'native repayment links to the real payroll deduction');
  } finally {await dropScratchOrgReporting(fx.orgId);}
});

interface Fixture {
  orgId: string;
  subsidiaryId: string;
  actorId: string;
  scheduleId: string;
  accounts: Record<string, string>;
  controlAccounts: {ar:string;ap:string;bank:string};
}

const account = async (
  orgId: string, number: string, name: string, type: string,
): Promise<string> => {
  return seedPostingAccount(orgId, number, name, type);
};

/** A CA org with payroll accounts wired and one biweekly schedule. */
async function payrollOrg(opts: { eht?: { rate: string; annualExemption: string } } = {}): Promise<Fixture> {
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
  await seedOntarioEhtFixture(org.orgId, actorId, opts.eht?.annualExemption);

  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: 'Biweekly', frequency: 'biweekly', periodsPerYear: 26, anchorPeriodEnd: '2026-07-18',
    payDateOffsetDays: 3,
  });
  return {
    orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, scheduleId, accounts, controlAccounts:org.accounts,
  };
}

interface EmployeeOptions {
  currency?: string;
  rate?: string;
  basis?: "hour" | "year";
  annualHours?: string;
  payBasis?: "hourly" | "salary";
  vacationPercent?: string | null;
  scheduleId?: string;
  workerCompGroupId?: string | null;
  terminatedOn?: string | null;
}

async function employee(fx: Fixture, name: string, opts: EmployeeOptions = {}): Promise<string> {
  const id = randomUUID();
  await seedPayrollPerson(fx.orgId, id, name);
  await seedPayrollEmployeeRole(fx.orgId, id, { id: randomUUID(), workerCompGroupId: opts.workerCompGroupId ?? null, terminatedOn: opts.terminatedOn ?? null });
  await seedPayrollWage(fx.orgId, id, fx.actorId, {
    currency: opts.currency ?? "CAD", rate: opts.rate ?? "30", basis: opts.basis ?? "hour",
    annualHours: opts.annualHours ?? "2080", effectiveFrom: '2026-01-01',
  });
  // Hires carry an HRM employment or stub calculation refuses them.
  const employmentId = await seedWorkerEmployment(fx.orgId, id, fx.subsidiaryId);
  await seedPayrollProfile(fx.orgId, id, employmentId, opts.scheduleId ?? fx.scheduleId, fx.actorId, {
    country: 'CA', province: 'ON', payBasis: opts.payBasis ?? "hourly", federalClaimCode: 1,
    provincialClaimCode: 1,
  }, { percentFloor: opts.vacationPercent === undefined ? "4" : opts.vacationPercent, method: 'accrue' });

  return id;
}

async function hours(
  fx: Fixture, employeeId: string, workedOn: string, qty: string, projectId?: string,
): Promise<void> {
  await seedPayrollTime(fx.orgId, employeeId, fx.actorId, {
    workedOn: workedOn, hours: qty, projectId: projectId ?? null, status: 'approved', isBillable: false,
    billingStatus: 'unbilled', costingBasis: 'actual',
  });
}

const ledgerRows = async (orgId: string) => ((await db.execute<{ employee_party_id: string; kind: string; amount: string; pay_run_document_id: string | null }>(sql`
  select employee_party_id, kind, amount::text as amount, pay_run_document_id
    from entitlement_ledger where org_id = ${orgId}
   order by employee_party_id, kind`))).rows;

const stubRows = async (orgId: string, documentId: string) => ((await db.execute<{
    employee_party_id: string; gross: string; vacation_accrued: string;
    factors: Record<string, string>; id: string;
  }>(sql`
  select employee_party_id, gross::text as gross, vacation_accrued::text as vacation_accrued,
         factors, id
    from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`))).rows;

/* ------------------------------------------------------------------ */
/* D1 + D2 — three employees, three banks                              */
/* ------------------------------------------------------------------ */

test(
  "a three-employee run accrues and banks vacation for EVERY employee, and recalculating is idempotent",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const names = ["Ada Bricklayer", "Bo Framer", "Cy Welder"];
      const ids: string[] = [];
      for (const name of names) {
        const id = await employee(fx, name);
        ids.push(id);
        // 80 hours each at $30 → $2,400 gross → 4% = $96.00 vacation.
        for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await hours(fx, id, day, "20");
        }
      }

      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 3);

      // D1: the accrual happens at all — the plan is provisioned beside the
      // components, and is matched on its system key, not its editable code.
      const stubs = await stubRows(fx.orgId, run.documentId);
      assert.equal(stubs.length, 3);
      for (const stub of stubs) assert.equal(stub.vacation_accrued, "96.0000");

      // D2: EVERY employee keeps their ledger movement. The per-employee call
      // used to delete the whole run's rows, so only the last employee had any.
      const banked = await ledgerRows(fx.orgId);
      assert.equal(banked.length, 3, "one accrual per employee, not one per run");
      assert.deepEqual([...new Set(banked.map((r) => r.employee_party_id))].sort(), [...ids].sort());
      for (const row of banked) {
        assert.equal(row.kind, "accrual");
        assert.equal(row.amount, "96.0000");
        assert.equal(row.pay_run_document_id, run.documentId);
      }

      // Recalculation converges: still exactly one movement each, same amount.
      await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      const again = await ledgerRows(fx.orgId);
      assert.equal(again.length, 3);
      assert.equal(sum(again.map((r) => r.amount)), "288.0000");

      // Excluding one employee removes THEIR movement and nobody else's.
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, created_by, updated_by)
        values (${fx.orgId}, ${run.documentId}, ${ids[0]}, 'exclude', ${fx.actorId}, ${fx.actorId})`);
      await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      const afterExclude = await ledgerRows(fx.orgId);
      assert.equal(afterExclude.length, 2);
      assert.ok(!afterExclude.some((r) => r.employee_party_id === ids[0]));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D3 + D4 — a final pay run is scoped, and pays the whole bank twice   */
/* ------------------------------------------------------------------ */

test(
  "a final pay run must name who it pays, and recalculating it keeps the whole banked balance",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const stayA = await employee(fx, "Ada Stays");
      const stayB = await employee(fx, "Bo Stays");
      const leaver = await employee(fx, "Cy Leaves", { terminatedOn: "2026-07-25" });
      for (const id of [stayA, stayB, leaver]) {
        for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await hours(fx, id, day, "20");
        }
      }
      const regular = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });
      await commitPayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });

      // D4: an unscoped final pay run cannot be created at all. Without this
      // the run pays every employee a second full period AND drains every bank.
      await assert.rejects(
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-07-19", periodEnd: "2026-08-01", runType: "termination",
        }),
        /must name the employees it pays/,
      );
      await assert.rejects(
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-07-19", periodEnd: "2026-08-01", runType: "termination",
          employeePartyIds: [randomUUID()],
        }),
        /not on this pay schedule/,
      );

      const final = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19", periodEnd: "2026-08-01", runType: "termination",
        employeePartyIds: [leaver],
      });
      const firstPass = await calculatePayRun({
        orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(firstPass.errors, []);
      assert.equal(firstPass.employees, 1, "only the named employee is on a final pay run");

      const payoutOf = async () => ((await db.execute<{ amount: string }>(sql`
        select l.amount::text as amount
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${final.documentId}
           and l.description like '%payout (accrued balance)'`))).rows.map((r) => r.amount);
      assert.deepEqual(await payoutOf(), ["96.0000"]);

      // D3: the SECOND Calculate used to read the balance net of its own
      // payout, see zero, and quietly drop the departing employee's whole bank.
      await calculatePayRun({ orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId });
      assert.deepEqual(await payoutOf(), ["96.0000"], "the bank is paid out on every recalculation");
      await calculatePayRun({ orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId });
      assert.deepEqual(await payoutOf(), ["96.0000"]);

      // Everyone else is untouched: no stub, and their bank is intact.
      const finalStubs = await stubRows(fx.orgId, final.documentId);
      assert.deepEqual(finalStubs.map((s) => s.employee_party_id), [leaver]);
      const balances = new Map<string, string>();
      for (const row of await ledgerRows(fx.orgId)) {
        balances.set(row.employee_party_id, sum([balances.get(row.employee_party_id) ?? "0", row.amount]));
      }
      assert.equal(balances.get(stayA), "96.0000");
      assert.equal(balances.get(stayB), "96.0000");
      assert.equal(balances.get(leaver), "0.0000", "the leaver's bank is cleared, exactly once");

      // A roster that GROWS after creation cannot sneak onto the run: someone
      // whose employment has not ended is refused by name, never paid.
      const newHire = await employee(fx, "Dee Newhire");
      const grown = await calculatePayRun({
        orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId,
      });
      assert.equal(grown.employees, 1);
      assert.ok(
        grown.errors.some((e) => e.employee === "Dee Newhire" && /employment has ended/.test(e.message)),
        "an unterminated stranger on a final pay run is refused, loudly",
      );
      assert.ok(!(await stubRows(fx.orgId, final.documentId)).some((s) => s.employee_party_id === newHire));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D5 — commit claims only the time the run actually priced             */
/* ------------------------------------------------------------------ */

test(
  "an off-cycle bonus run claims no time, so the regular run still pays the period's hours",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const id = await employee(fx, "Bonnie Bonus");
      for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await hours(fx, id, day, "20");
      }
      const bonus = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18", runType: "bonus",
      });
      const bonusComponent = ((await db.execute<{ id: string }>(sql`
        select id from pay_components where org_id = ${fx.orgId} and code = 'BONUS'
      `))).rows[0]!;
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, component_id, amount, note,
                                         created_by, updated_by)
        values (${fx.orgId}, ${bonus.documentId}, ${id}, 'line', ${bonusComponent.id},
                '500', 'Spot bonus', ${fx.actorId}, ${fx.actorId})`);
      await calculatePayRun({ orgId: fx.orgId, documentId: bonus.documentId, actorId: fx.actorId });
      await commitPayRun({ orgId: fx.orgId, documentId: bonus.documentId, actorId: fx.actorId });

      // The bonus run priced no hours, so it may not claim any. Claiming them
      // made every hourly employee calculate at $0 on the regular run while
      // readiness still reported the hours as present.
      const claimed = ((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from time_entries
         where org_id = ${fx.orgId} and payroll_batch_ref is not null`))).rows[0]!.n;
      assert.equal(claimed, 0, "a bonus run prices no time and therefore claims none");

      const regular = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });
      assert.equal((await stubRows(fx.orgId, regular.documentId))[0]!.gross, "2400.0000");
      await commitPayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });
      const nowClaimed = ((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from time_entries
         where org_id = ${fx.orgId} and payroll_batch_ref = ${regular.documentId}`))).rows[0]!.n;
      assert.equal(nowClaimed, 4, "the run that priced the hours is the run that claims them");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D6 — a finite annual allowance survives two overlapping drafts       */
/* ------------------------------------------------------------------ */

test(
  "two schedules calculated before either commits cannot both claim the Ontario EHT exemption",
  { skip: !DB },
  async () => {
    // Committed-only doctrine: uncommitted drafts consume no exemption room,
    // so the second schedule calculates against the still-open exemption —
    // and the commit-time staleness arm (`employerLevyYtd`) refuses its
    // commit once the first run lands, until it recalculates. The property
    // this pins is unchanged: at most one draft commits with the exemption.
    const fx = await payrollOrg({ eht: { rate: "1.95", annualExemption: "1000" } });
    try {
      // Committing posts the EHT line, so its liability account must be
      // mapped (calculation alone never touches the chart).
      const ehtPayable = await account(fx.orgId, "2340", "EHT payable", "liability_current");
      await setPackSlotAccount(fx.orgId, fx.actorId, "CA", "eht", ehtPayable);
      const secondSchedule = randomUUID();
      await seedPayrollSchedule(fx.orgId, secondSchedule, fx.actorId, {
        name: 'Biweekly two', frequency: 'biweekly', periodsPerYear: 26, anchorPeriodEnd: '2026-07-18',
        payDateOffsetDays: 3,
      });
      const first = await employee(fx, "Ada First");
      const second = await employee(fx, "Bo Second", { scheduleId: secondSchedule });
      for (const id of [first, second]) {
        for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await hours(fx, id, day, "20");
        }
      }

      const runA = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: runA.documentId, actorId: fx.actorId });
      // Deliberately NOT committed — the second schedule is calculated while
      // the first is still sitting in the wizard, which is the normal Friday.
      const runB = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: secondSchedule,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: runB.documentId, actorId: fx.actorId });

      // A is still a draft, so B calculates against the open exemption too:
      // (2,400 − 1,000) × 1.95% = 27.30 on both.
      assert.equal((await stubRows(fx.orgId, runA.documentId))[0]!.factors.EHT, "27.3000");
      assert.equal((await stubRows(fx.orgId, runB.documentId))[0]!.factors.EHT, "27.3000");

      // Recalculating A while B is still a draft must not move A: drafts
      // consume nothing, so there is no double count to pick up.
      await calculatePayRun({ orgId: fx.orgId, documentId: runA.documentId, actorId: fx.actorId });
      assert.equal((await stubRows(fx.orgId, runA.documentId))[0]!.factors.EHT, "27.3000");

      // A commits with the exemption. B's calculation is now stale — the
      // commit refuses until B recalculates against A's committed room.
      await commitPayRun({ orgId: fx.orgId, documentId: runA.documentId, actorId: fx.actorId });
      await assert.rejects(
        commitPayRun({ orgId: fx.orgId, documentId: runB.documentId, actorId: fx.actorId }),
        /recalculate before committing/,
      );
      await calculatePayRun({ orgId: fx.orgId, documentId: runB.documentId, actorId: fx.actorId });
      // The exemption is gone by the second: 2,400 × 1.95% = 46.80.
      assert.equal((await stubRows(fx.orgId, runB.documentId))[0]!.factors.EHT, "46.8000");
      await commitPayRun({ orgId: fx.orgId, documentId: runB.documentId, actorId: fx.actorId });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D7 — 'voided', not 'void'                                            */
/* ------------------------------------------------------------------ */

test(
  "a voided regular run does not block its own replacement for the same period",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await employee(fx, "Vic Void");
      const first = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      // A live run blocks any OVERLAPPING regular run, which is the point.
      await assert.rejects(
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-07-12", periodEnd: "2026-07-25",
        }),
        /already covers/,
      );
      // The documents status enum is 'voided'; the guard compared to 'void',
      // so a voided run went on blocking its own period forever.
      await db.execute(sql`
        update documents
           set status = 'voided', voided_at = now(), voided_by = ${fx.actorId},
               void_reason = 'Opened against the wrong schedule'
         where id = ${first.documentId}`);
      // Voiding releases the storage key while retaining the original run and
      // its reversal evidence. An exact-period replacement is therefore
      // allowed, but it receives a new document identity.
      const replacement = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      assert.ok(replacement.documentId);
      assert.notEqual(replacement.documentId, first.documentId);

      const statuses = await db.execute<{ document_id: string; run_status: string }>(sql`
        select document_id, run_status from pay_runs
         where org_id = ${fx.orgId}
           and document_id in (${first.documentId}, ${replacement.documentId})
         order by document_id
      `);
      assert.equal(statuses.rows.find((row) => row.document_id === first.documentId)?.run_status, "voided");
      assert.equal(statuses.rows.find((row) => row.document_id === replacement.documentId)?.run_status, "draft");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "overlapping concurrent regular-run creates on one schedule yield one payable period",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const attempts = await Promise.allSettled([
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-01-01", periodEnd: "2026-01-15", payDate: "2026-01-20",
        }),
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-01-10", periodEnd: "2026-01-20", payDate: "2026-01-25",
        }),
      ]);
      assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
      const refusal = attempts.find((result) => result.status === "rejected");
      assert.ok(refusal && refusal.status === "rejected");
      assert.match(String(refusal.reason), /already covers/);
      const bonus = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-01-10", periodEnd: "2026-01-20", payDate: "2026-01-25",
        runType: "bonus",
      });
      assert.ok(bonus.documentId, "off-cycle bonus remains permitted within a regular period");
      const runs = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pay_runs
         where org_id = ${fx.orgId} and pay_schedule_id = ${fx.scheduleId}
           and run_type = 'regular' and run_status <> 'voided'
      `);
      assert.equal(runs.rows[0]!.n, 1);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the database refuses overlapping live regular periods even on direct writes",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const first = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-01-01", periodEnd: "2026-01-15", payDate: "2026-01-20",
      });
      const second = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-01-16", periodEnd: "2026-01-31", payDate: "2026-02-05",
      });
      assert.notEqual(first.documentId, second.documentId);
      await assert.rejects(
        db.execute(sql`
          update pay_runs set period_start = '2026-01-10'
           where org_id = ${fx.orgId} and document_id = ${second.documentId}
        `),
        (error: unknown) => {
          let code: string | undefined;
          for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
            const candidate = cause as Error & { code?: unknown };
            if (typeof candidate.code === "string") {
              code = candidate.code;
              break;
            }
          }
          assert.equal(code, "23P01");
          return true;
        },
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-1 — a wage is converted to the currency the run pays in            */
/* ------------------------------------------------------------------ */

test(
  "a foreign-currency wage is converted before it is paid, and refuses to be paid without a rate",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      // The scratch org's entity reports in CAD; this wage row is USD.
      const id = await employee(fx, "Uma Crossborder", { currency: "USD", rate: "60" });
      await hours(fx, id, "2026-07-06", "10");
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const unconverted = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.equal(unconverted.employees, 0);
      assert.match(unconverted.errors[0]!.message, /no spot rate for the wage USD→CAD/);

      await db.execute(sql`
        insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${fx.orgId}, 'USD', 'CAD', '2026-01-01', 'spot', '1.3700000000', 'manual')`);
      const converted = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(converted.errors, []);
      // USD 60.00 × 1.37 = CAD 82.20 an hour, not the raw 60.00 that used to
      // be paid — a 37% overpayment that balanced perfectly in the GL.
      assert.equal((await stubRows(fx.orgId, run.documentId))[0]!.gross, "822.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-5 / M-6 — division stays exact                                     */
/* ------------------------------------------------------------------ */

test(
  "an annual rate divided by annual hours is exact, not a float reciprocal",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      // 125,000 ÷ 1,800 = 69.444444…; the stored 4dp wage is 69.4444, and a
      // float reciprocal rounds it up to 69.4445 — which is then multiplied by
      // every hour on every stub, always in the same direction.
      const id = await employee(fx, "Hank Hourly", {
        basis: "year", rate: "125000", annualHours: "1800", payBasis: "hourly",
      });
      for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await hours(fx, id, day, "20");
      }
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      const hourlyLines = ((await db.execute<{ rate: string; amount: string }>(sql`
        select l.rate::text as rate, l.amount::text as amount
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${run.documentId} and l.hours is not null`))).rows;
      assert.equal(hourlyLines[0]!.rate, "69.4444");
      // Day-evidence lines allocate the exact cent total across worked days,
      // so the total is summed: 69.4444 × 80, not 69.4445 × 80.
      assert.equal(sum(hourlyLines.map((l) => l.amount)), "5555.5500");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-3 — the job split of a levy sums to the levy, in both directions   */
/* ------------------------------------------------------------------ */

test(
  "a WCB split that over-allocates by rounding still sums to exactly the premium",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const groupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, is_active)
        values (${groupId}, ${fx.orgId}, 'CLASS-B', 'Class B', '5', true)`);
      const id = await employee(fx, "Rae Rounding", {
        rate: "33.3330", workerCompGroupId: groupId, vacationPercent: null,
      });
      const jobs: string[] = [];
      for (const name of ["Job A", "Job B", "Job C"]) {
        const projectId = randomUUID();
        jobs.push(projectId);
        await db.execute(sql`
          insert into projects (id, org_id, name, code, is_active, custom)
          values (${projectId}, ${fx.orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
      }
      // Three jobs at 333.33 each, plus one untagged cent: gross 1,000.00, so
      // each independently rounded 5% share is 16.67 and the three of them
      // over-allocate the 50.00 premium by a cent.
      for (const projectId of jobs) await hours(fx, id, "2026-07-06", "10", projectId);
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const bonusComponent = ((await db.execute<{ id: string }>(sql`
        select id from pay_components where org_id = ${fx.orgId} and code = 'BONUS'
      `))).rows[0]!;
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, component_id, amount, note,
                                         created_by, updated_by)
        values (${fx.orgId}, ${run.documentId}, ${id}, 'line', ${bonusComponent.id},
                '0.01', 'Untagged cent', ${fx.actorId}, ${fx.actorId})`);
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      const stub = (await stubRows(fx.orgId, run.documentId))[0]!;
      assert.equal(stub.gross, "1000.0000");
      assert.equal(stub.factors.WCB, "50.0000");
      const wcbLines = ((await db.execute<{ amount: string }>(sql`
        select amount::text as amount from pay_stub_lines
         where stub_id = ${stub.id} and description = 'WCB/WSIB'`))).rows;
      // The stub lines and factors.WCB must agree: the remittance summary sums
      // the lines and the annual-cap tracker reads the factor, so a dropped
      // negative remainder puts the two permanently at odds.
      assert.equal(sum(wcbLines.map((l) => l.amount)), stub.factors.WCB);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-10 — job_costed is a property of the fringe, not of its formula    */
/* ------------------------------------------------------------------ */

test(
  "a percent-of-gross union fringe marked job-costed lands on the jobs",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const agreementId = randomUUID();
      await db.execute(sql`
        insert into union_agreements (id, org_id, name, union_name, local_number, is_active,
                                      created_by, updated_by)
        values (${agreementId}, ${fx.orgId}, 'Local 1', 'IBEW', '1', true,
                ${fx.actorId}, ${fx.actorId})`);
      await upsertUnionFringe(fx.orgId, fx.actorId, {
        agreementId, code: "WELF", name: "Welfare fund", calc: "percent_of_gross",
        value: "10", paidBy: "employer", jobCosted: true,
        expenseAccountId: fx.accounts.burdenExpense,
        liabilityAccountId: fx.accounts.otherPayable!,
      });

      const id = await employee(fx, "Jo Jobcost", { vacationPercent: null });
      await db.execute(sql`
        update employee_payroll_profiles set union_agreement_id = ${agreementId}
         where org_id = ${fx.orgId} and employee_party_id = ${id}`);
      const jobA = randomUUID();
      const jobB = randomUUID();
      for (const [projectId, name] of [[jobA, "Job A"], [jobB, "Job B"]] as const) {
        await db.execute(sql`
          insert into projects (id, org_id, name, code, is_active, custom)
          values (${projectId}, ${fx.orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
      }
      await hours(fx, id, "2026-07-06", "20", jobA); // $600
      await hours(fx, id, "2026-07-08", "20", jobB); // $600

      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      const fringeLines = ((await db.execute<{ amount: string; project_id: string | null }>(sql`
        select l.amount::text as amount, l.project_id
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${run.documentId} and l.description = 'Welfare fund'
         order by l.project_id`))).rows;
      // 10% of 1,200 = 120.00, split by the earnings it is a percent OF.
      assert.equal(fringeLines.length, 2, "the flag's whole purpose is job costing");
      assert.ok(fringeLines.every((l) => l.project_id !== null));
      assert.equal(sum(fringeLines.map((l) => l.amount)), "120.0000");
      assert.equal(cmp(fringeLines[0]!.amount, "60.0000"), 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
