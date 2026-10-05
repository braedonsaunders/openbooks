import { seedPayrollAccountingConfiguration } from '../testing/fixtures.ts';
import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollTime,
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
import { validateEmployeePayComponentAssignment } from "./assigned-components.ts";

/** Recurring per-employee pay-component assignments: write-time refusals and run pricing. */

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

async function userComponent(fx: Fixture, code: string, kind: string, basis = 'fixed_amount', value: string | null = '25'): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
    tax_treatment,payment_kind,basis,value,expense_account_id,liability_account_id)
    values(${id},${fx.orgId},${code},${code},${kind},'CA',true,true,true,false,'none','cash',${basis},${value},${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
  return id;
}

async function assign(fx: Fixture, partyId: string, employmentId: string | null, componentId: string, value: string | null, from: string, to: string | null): Promise<string> {
  await validateEmployeePayComponentAssignment(db, fx.orgId, {
    employeePartyId: partyId, employmentId, componentId, value, effectiveFrom: from, effectiveTo: to,
  });
  const id = randomUUID();
  await db.execute(sql`insert into employee_pay_components(id,org_id,employee_party_id,employment_id,component_id,value,
    effective_from,effective_to,is_active,created_by,updated_by)
    values(${id},${fx.orgId},${partyId},${employmentId},${componentId},${value},${from}::date,${to}::date,true,${fx.actorId},${fx.actorId})`);
  return id;
}

test('a validated fixed deduction prices on the regular run at its override', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId, employmentId } = await employee(fx, 'Assignment Employee');
    const coveralls = await userComponent(fx, 'COVERALLS', 'deduction');
    await assign(fx, partyId, employmentId, coveralls, '25', '2026-01-01', null);
    for (const day of ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']) {
      await seedPayrollTime(fx.orgId, partyId, fx.actorId, {
        workedOn: day, hours: '8', projectId: null, status: 'approved', isBillable: false,
        billingStatus: 'unbilled', costingBasis: 'actual',
      });
    }
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.deepEqual(result.errors, []);
    const lines = (await db.execute<{ code: string; amount: string; kind: string }>(sql`select c.code,l.amount::text as amount,l.kind
      from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id join pay_components c on c.org_id=l.org_id and c.id=l.component_id
      where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and c.code='COVERALLS'`)).rows;
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.amount, '25.0000');
    assert.equal(lines[0]!.kind, 'deduction');
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('assignment writes refuse statutory components, overlaps, and Benefits-delivered components by name', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    const { partyId, employmentId } = await employee(fx, 'Refused Assignment Employee');
    const statutory = (await db.execute<{ id: string; code: string }>(sql`select id,code from pay_components
      where org_id=${fx.orgId} and system_key is not null and kind='deduction' limit 1`)).rows[0]!;
    await assert.rejects(
      () => validateEmployeePayComponentAssignment(db, fx.orgId, {
        employeePartyId: partyId, employmentId, componentId: statutory.id, value: '5', effectiveFrom: '2026-01-01', effectiveTo: null,
      }),
      /is statutory.*statutory amounts are always recomputed.*assign a user-defined component instead/,
    );
    const dues = await userComponent(fx, 'DUESX', 'deduction');
    await assign(fx, partyId, employmentId, dues, '10', '2026-01-01', '2026-06-30');
    // An overlapping window refuses naming the existing one; an adjacent window passes.
    await assert.rejects(
      () => validateEmployeePayComponentAssignment(db, fx.orgId, {
        employeePartyId: partyId, employmentId, componentId: dues, value: '10', effectiveFrom: '2026-06-01', effectiveTo: null,
      }),
      /already holds DUESX for 2026-01-01 to 2026-06-30 — end that assignment/,
    );
    await validateEmployeePayComponentAssignment(db, fx.orgId, {
      employeePartyId: partyId, employmentId, componentId: dues, value: '12', effectiveFrom: '2026-07-01', effectiveTo: null,
    });
    // A party-wide row would double-pay beside the employment-scoped one.
    await assert.rejects(
      () => validateEmployeePayComponentAssignment(db, fx.orgId, {
        employeePartyId: partyId, employmentId: null, componentId: dues, value: '10', effectiveFrom: '2026-03-01', effectiveTo: null,
      }),
      /already holds DUESX/,
    );
    // A component the Benefits election already delivers refuses naming the rule.
    const planId = randomUUID(), enrollmentId = randomUUID(), ruleId = randomUUID();
    await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${planId},${fx.orgId},'DUESPLAN','Dues plan','other','CAD',${fx.subsidiaryId},'2026-01-01')`);
    await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
    await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,
      proration,effective_from,run_applicability)
      values(${ruleId},${fx.orgId},${planId},'DUES_RULE','Dues rule','employee_deduction',${dues},'per_period',0,'elected_rate','none','2026-01-01','all_pay_runs')`);
    await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,source_decimal,provenance)
      values(${randomUUID()},${fx.orgId},${enrollmentId},${ruleId},'fixed','10','2026-01-01','10','{"source":"approved payroll election"}'::jsonb)`);
    await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${fx.actorId},submitted_at=now(),
      submission_snapshot=public.benefit_enrollment_submission_source(org_id,id),updated_by=${fx.actorId},
      decision_snapshot=jsonb_build_object('outcome','approved','mode','not_required','approvalMode','none','planId',plan_id),status='active'
      where org_id=${fx.orgId} and id=${enrollmentId}`);
    await assert.rejects(
      () => validateEmployeePayComponentAssignment(db, fx.orgId, {
        employeePartyId: partyId, employmentId, componentId: dues, value: '10', effectiveFrom: '2026-07-01', effectiveTo: null,
      }),
      /already delivered to .* by benefit rule DUES_RULE \(plan DUESPLAN\)/,
    );
    // A US-only component cannot pay a CA-payroll employee.
    const usOnly = await userComponent(fx, 'USONLY', 'deduction');
    await db.execute(sql`update pay_components set country='US' where org_id=${fx.orgId} and id=${usOnly}`);
    await assert.rejects(
      () => validateEmployeePayComponentAssignment(db, fx.orgId, {
        employeePartyId: partyId, employmentId, componentId: usOnly, value: '7', effectiveFrom: '2026-01-01', effectiveTo: null,
      }),
      /belongs to the US payroll while .* pays under CA/,
    );
    // Reversed windows and foreign employments refuse before any write.
    await assert.rejects(
      () => validateEmployeePayComponentAssignment(db, fx.orgId, {
        employeePartyId: partyId, employmentId, componentId: dues, value: '10', effectiveFrom: '2026-07-01', effectiveTo: '2026-06-01',
      }),
      /ends .* before it starts/,
    );
    await assert.rejects(
      () => validateEmployeePayComponentAssignment(db, fx.orgId, {
        employeePartyId: partyId, employmentId: randomUUID(), componentId: dues, value: '10', effectiveFrom: '2026-07-01', effectiveTo: null,
      }),
      /holds no such employment/,
    );
  } finally { await dropScratchOrgReporting(fx.orgId); }
});
