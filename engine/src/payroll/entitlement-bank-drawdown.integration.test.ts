import { seedPayrollAccountingConfiguration } from '../testing/fixtures.ts';
import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollTime,
  seedPayrollProfile, seedPayrollWage, createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { cmp } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";
import { entitlementBalances } from "./entitlements-db.ts";
import { validateEntitlementPlanConfiguration } from "./entitlement-plan-config.ts";

/**
 * Bank drawdown on ordinary runs: a plan's payout component withdraws from
 * the bank on any non-termination run, an hours bank funds from
 * negative-hours deposit lines, overdraws refuse naming the balance, and the
 * payout itself accrues nothing further.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string; subsidiaryId: string; actorId: string; scheduleId: string;
  accounts: { burdenExpense: string; otherPayable: string; vacationPayable: string };
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

async function hours(fx: Fixture, partyId: string, days: string[]): Promise<void> {
  for (const day of days) {
    await seedPayrollTime(fx.orgId, partyId, fx.actorId, {
      workedOn: day, hours: '8', projectId: null, status: 'approved', isBillable: false,
      billingStatus: 'unbilled', costingBasis: 'actual',
    });
  }
}

async function earningComponent(fx: Fixture, code: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
    tax_treatment,payment_kind,expense_account_id,liability_account_id)
    values(${id},${fx.orgId},${code},${code},'earning','CA',true,true,true,true,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
  return id;
}

async function opening(fx: Fixture, planId: string, partyId: string, amount: string, hoursValue: string | null): Promise<void> {
  await db.execute(sql`insert into entitlement_ledger(org_id,plan_id,employee_party_id,movement_date,amount,hours,kind,note,created_by,updated_by)
    values(${fx.orgId},${planId},${partyId},'2026-06-01',${amount},${hoursValue},'opening','carried-in test balance',${fx.actorId},${fx.actorId})`);
}

async function balanceOf(fx: Fixture, partyId: string, planId: string, asOf: string): Promise<string> {
  const balances = await entitlementBalances(fx.orgId, partyId, asOf, { executor: db });
  return balances.find((b) => b.plan.id === planId)!.balance;
}

test('a vacation payout on a regular run withdraws from the bank without accruing on the payout', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId } = await employee(fx, 'Vacation Drawdown Employee');
    const plan = (await db.execute<{ id: string; payout_component_id: string }>(sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`)).rows[0]!;
    await opening(fx, plan.id, partyId, '1000', null);
    await hours(fx, partyId, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']);
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'600')`);
    const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.deepEqual(result.errors, []);
    // The stub pays 600 in cash and the ledger withdraws it with the stub line linked.
    const payout = (await db.execute<{ amount: string; stub_line_id: string | null }>(sql`select amount::text as amount,stub_line_id::text
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${plan.id} and kind='payout'`)).rows;
    assert.equal(payout.length, 1);
    assert.equal(payout[0]!.amount, '-600.0000');
    assert.ok(payout[0]!.stub_line_id, 'the withdrawal ties to its stub line');
    // 40 regular hours at 4%: the 600 payout accrues nothing further.
    const stub = (await db.execute<{ vacation_accrued: string }>(sql`select vacation_accrued::text from pay_stubs
      where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`)).rows[0]!;
    assert.equal(stub.vacation_accrued, '48.0000');
    assert.equal(await balanceOf(fx, partyId, plan.id, '2026-07-21'), '448.0000');
    // Recalculating a settled run reproduces the ledger instead of tripping
    // the append-only guard: the run's movements go before its stubs.
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId })).errors, []);
    const repayout = (await db.execute<{ amount: string }>(sql`select amount::text as amount
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${plan.id} and kind='payout'`)).rows;
    assert.equal(repayout.length, 1);
    assert.equal(repayout[0]!.amount, '-600.0000');
    assert.equal(await balanceOf(fx, partyId, plan.id, '2026-07-21'), '448.0000');
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('an overdraw refuses naming the balance unless the plan allows negatives', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId } = await employee(fx, 'Overdraw Employee');
    const plan = (await db.execute<{ id: string; payout_component_id: string }>(sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`)).rows[0]!;
    await opening(fx, plan.id, partyId, '1000', null);
    await hours(fx, partyId, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']);
    const first = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${first.documentId},${partyId},'line',${plan.payout_component_id},'600')`);
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId })).errors, []);
    await hours(fx, partyId, ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']);
    const second = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-19', periodEnd: '2026-07-25' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${second.documentId},${partyId},'line',${plan.payout_component_id},'500')`);
    const refused = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId });
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0]!.message, /Overdraw Employee.*Vacation payout of 500.*exceeds the available 496/);
    // The plan opts into negatives: the same run now calculates, landing below zero.
    await db.execute(sql`update entitlement_plans set allow_negative_balance=true where org_id=${fx.orgId} and id=${plan.id}`);
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId })).errors, []);
    assert.equal(await balanceOf(fx, partyId, plan.id, '2026-07-28'), '-4.0000');
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('an hours bank funds from negative deposit lines and pays from positive ones', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId } = await employee(fx, 'Banked Time Employee');
    const overtime = await earningComponent(fx, 'OTBANK');
    const take = await earningComponent(fx, 'BANKTAKE');
    const store = await earningComponent(fx, 'BANKSTORE');
    const planId = randomUUID();
    await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id,deposit_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'BANKOT','Banked overtime','hours','accrue','manual',${take},${store},${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
    // Week one: 8 overtime hours banked instead of paid (cash nets to zero).
    await hours(fx, partyId, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']);
    const first = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
      values(${fx.orgId},${first.documentId},${partyId},'line',${overtime},'240','8'),
            (${fx.orgId},${first.documentId},${partyId},'line',${store},'-240','-8')`);
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId })).errors, []);
    const deposit = (await db.execute<{ amount: string; hours: string | null }>(sql`select amount::text as amount,hours::text
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${planId} and kind='bank_in'`)).rows;
    assert.equal(deposit.length, 1);
    assert.equal(deposit[0]!.amount, '8.0000');
    assert.equal(cmp(deposit[0]!.hours ?? '0', '8'), 0);
    assert.equal(await balanceOf(fx, partyId, planId, '2026-07-21'), '8.0000');
    // Week two: 5 hours taken as cash; a further 5 would overdraw the 3 left.
    await hours(fx, partyId, ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']);
    const second = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-19', periodEnd: '2026-07-25' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
      values(${fx.orgId},${second.documentId},${partyId},'line',${take},'150','5')`);
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId })).errors, []);
    assert.equal(await balanceOf(fx, partyId, planId, '2026-07-28'), '3.0000');
    await hours(fx, partyId, ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']);
    const third = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-26', periodEnd: '2026-08-01' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
      values(${fx.orgId},${third.documentId},${partyId},'line',${take},'150','5')`);
    const refused = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: third.documentId });
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0]!.message, /Banked Time Employee.*Banked overtime payout of 5.*exceeds the available 3/);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('one payout component settling two plans refuses naming both', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId } = await employee(fx, 'Shared Component Employee');
    const payout = await earningComponent(fx, 'VACPAY3');
    for (const code of ['VACA', 'VACB']) {
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,accrual_value,payout_component_id,deposit_component_id,
        liability_account_id,cap_behavior,is_active,created_by,updated_by)
        values(${randomUUID()},${fx.orgId},${code},${code},'money','accrue','percent_of_earnings','4',${payout},null,${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
    }
    await hours(fx, partyId, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']);
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${payout},'100')`);
    const refused = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0]!.message, /VACPAY3.*VACA, VACB/);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('plan settlement configuration refuses shared or non-earning components', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    const payout = await earningComponent(fx, 'VACPAY2');
    const dues = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
      tax_treatment,payment_kind,expense_account_id,liability_account_id)
      values(${dues},${fx.orgId},'DUES2','Dues','deduction','CA',true,true,true,false,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
    await assert.rejects(
      () => validateEntitlementPlanConfiguration(db, fx.orgId, { payoutComponentId: payout, depositComponentId: payout }),
      /are the same row — choose distinct components so withdrawals and deposits stay attributable/,
    );
    await assert.rejects(
      () => validateEntitlementPlanConfiguration(db, fx.orgId, { payoutComponentId: dues, depositComponentId: null }),
      /DUES2 is not an earning component — only earning components carry bank settlements/,
    );
    await validateEntitlementPlanConfiguration(db, fx.orgId, { payoutComponentId: payout, depositComponentId: null });
  } finally { await dropScratchOrgReporting(fx.orgId); }
});
