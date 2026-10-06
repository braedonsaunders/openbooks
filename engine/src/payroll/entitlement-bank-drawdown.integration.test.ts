import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { seedHourlyPayrollTime as hours, seedHourlyPayrollOrg as payrollOrg, seedHourlyPayrollEmployee as employee, type HourlyPayrollFixture as Fixture } from "../testing/payroll-hourly-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { cmp } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { entitlementBalances } from "./entitlements-db.ts";
import { validateEntitlementPlanConfiguration } from "./entitlement-plan-config.ts";
import { mutatePayRunAdjustment, preflightPayRunAdjustment } from "./run-adjustments.ts";

/**
 * Bank drawdown on ordinary runs: a plan's payout component withdraws from
 * the bank on any non-termination run, an hours bank funds from
 * negative-hours deposit lines, overdraws refuse naming the balance, and the
 * a payout never replenishes its own bank.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

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

test('vacation paid as earned needs no bank balance while additional bank withdrawals still refuse', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    const { partyId, employmentId } = await employee(fx, 'Vacation Cash Employee');
    const plan = (await db.execute<{ id: string; payout_component_id: string }>(sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`)).rows[0]!;
    await db.execute(sql`update payroll_vacation_terms set method='pay_each_period',updated_by=${fx.actorId},updated_at=now()
      where org_id=${fx.orgId} and employment_id=${employmentId}`);
    await hours(fx, partyId, ['2026-07-13']);
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.deepEqual(result.errors, [], 'newly earned vacation is payable without a carried bank balance');
      const stubs = (await db.execute(sql`select gross::text,vacation_accrued::text from pay_stubs
        where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`)).rows;
      assert.deepEqual(stubs, [{ gross: '249.6000', vacation_accrued: '0.0000' }]);
      const movements = (await db.execute(sql`select id from entitlement_ledger where org_id=${fx.orgId}
        and plan_id=${plan.id} and employee_party_id=${partyId}`)).rows;
      assert.equal(movements.length, 0, 'current-period cash vacation neither accrues nor withdraws a bank');
    }
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'10')`);
    const refused = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0]!.message, /Vacation Cash Employee.*payout of 10\.0000 exceeds the available 0\.0000/);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('a zero vacation replacement preserves supplied cash earnings without regenerating vacation pay', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    const { partyId, employmentId } = await employee(fx, 'Vacation Replacement Employee');
    const plan = (await db.execute<{ id: string; payout_component_id: string }>(sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`)).rows[0]!;
    await db.execute(sql`update payroll_vacation_terms set method='pay_each_period',updated_by=${fx.actorId},updated_at=now()
      where org_id=${fx.orgId} and employment_id=${employmentId}`);
    const suppliedVacation = await earningComponent(fx, 'EARNED-VACATION');
    await db.execute(sql`update pay_components set vacationable=false where org_id=${fx.orgId} and id=${suppliedVacation}`);
    await hours(fx, partyId, ['2026-07-13']);
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,replace_component)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'0',true),
      (${fx.orgId},${run.documentId},${partyId},'line',${suppliedVacation},'9.60',false)`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.deepEqual(result.errors, []);
      const stub = (await db.execute(sql`select gross::text,vacation_accrued::text from pay_stubs
        where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`)).rows[0];
      assert.deepEqual(stub, { gross: '249.6000', vacation_accrued: '0.0000' }, 'the supplied vacation amount is paid exactly once');
      const generated = (await db.execute(sql`select l.id from pay_stub_lines l join pay_stubs s on s.id=l.stub_id and s.org_id=l.org_id
        where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.component_id=${plan.payout_component_id}`)).rows;
      assert.equal(generated.length, 0, 'zero replacement remains authoritative for the later vacation phase');
      const movements = (await db.execute(sql`select id from entitlement_ledger where org_id=${fx.orgId}
        and plan_id=${plan.id} and employee_party_id=${partyId}`)).rows;
      assert.equal(movements.length, 0);
    }
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('banked wages retain their declared vacation eligibility without replenishing their own bank', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    const { partyId } = await employee(fx, 'Deferred Wage Employee');
    const payoutComponent = await earningComponent(fx, 'DEFERREDWAGE');
    const accrualComponent = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,expense_account_id,liability_account_id)
      values(${accrualComponent},${fx.orgId},'DEFERREDACCR','Deferred wage accrual','employer_contribution','CA',
        ${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
    const bankId = randomUUID();
    await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,accrual_value,accrual_component_id,payout_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${bankId},${fx.orgId},'DEFERRED','Deferred wages','money','accrue','percent_of_earnings','4',${accrualComponent},${payoutComponent},
        ${fx.accounts.otherPayable},'warn',true,${fx.actorId},${fx.actorId})`);
    await opening(fx, bankId, partyId, '500', null);
    await hours(fx, partyId, ['2026-07-13']);
    const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: '2026-07-12', periodEnd: '2026-07-18' });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${payoutComponent},'240')`);
    for (const eligible of [true, false, true]) {
      await db.execute(sql`update pay_components set vacationable=${eligible} where org_id=${fx.orgId} and id=${payoutComponent}`);
      const result = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.deepEqual(result.errors, []);
      const stub = (await db.execute<{ gross: string; vacation_accrued: string }>(sql`select gross::text,vacation_accrued::text
        from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`)).rows[0]!;
      assert.equal(stub.gross, '480.0000');
      assert.equal(stub.vacation_accrued, eligible ? '19.2000' : '9.6000',
        'vacation accrues on deferred wages precisely when their earning component declares eligibility');
      assert.equal(await balanceOf(fx, partyId, bankId, '2026-07-21'), '269.6000',
        'the wage bank accrues only on new regular wages, never on its own withdrawal');
      const payouts = (await db.execute(sql`select amount::text from entitlement_ledger
        where org_id=${fx.orgId} and plan_id=${bankId} and pay_run_document_id=${run.documentId} and kind='payout'`)).rows;
      assert.deepEqual(payouts, [{ amount: '-240.0000' }], 'recalculation preserves one exact withdrawal');
    }
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('a vacation payout on a regular run withdraws from the bank without accruing on the payout', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId } = await employee(fx, 'Vacation Drawdown Employee');
    const plan = (await db.execute<{ id: string; payout_component_id: string }>(sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`)).rows[0]!;
    await db.execute(sql`update pay_components set expense_account_id=${fx.accounts.vacationPayable}
      where org_id=${fx.orgId} and id=${plan.payout_component_id}`);
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
    await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    const bankDebit = (await db.execute<{ amount: string; custom: { payrollExpense: boolean } }>(sql`
      select amount::text, custom from document_lines where org_id=${fx.orgId}
        and document_id=${run.documentId} and account_id=${fx.accounts.vacationPayable}
        and amount > 0`)).rows;
    assert.equal(bankDebit.length, 1);
    assert.equal(bankDebit[0]!.amount, '600.0000');
    assert.equal(bankDebit[0]!.custom.payrollExpense, false, 'withdrawing an accrued liability must not enter payroll expense allocation');
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
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52,subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.scheduleId}`);
    const { partyId } = await employee(fx, 'Banked Time Employee', fx.subsidiaryId);
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
    const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId,
      allowedSubsidiaryIds: new Set([fx.subsidiaryId]) };
    const depositInput = { ...input, mutation: { action: 'add' as const, employeePartyId: partyId,
      componentId: store, amount: '-240', hours: '-8', note: 'Overtime transferred to the bank', idempotencyKey: randomUUID() } };
    await assert.rejects(() => preflightPayRunAdjustment({ ...depositInput,
      mutation: { ...depositInput.mutation, componentId: overtime, amount: '240' } }), /non-negative/);
    await assert.rejects(() => preflightPayRunAdjustment({ ...depositInput,
      mutation: { ...depositInput.mutation, componentId: overtime } }), /OTBANK.*no active entitlement bank/);
    await assert.rejects(() => preflightPayRunAdjustment({ ...depositInput,
      mutation: { ...depositInput.mutation, componentId: take } }), /BANKTAKE.*BANKOT.*deposit component/);
    await assert.rejects(() => preflightPayRunAdjustment({ ...depositInput,
      mutation: { ...depositInput.mutation, amount: '-0.001' } }), /negative cash amount/);
    await assert.rejects(() => preflightPayRunAdjustment({ ...depositInput,
      mutation: { ...depositInput.mutation, note: '' } }), /supporting reason/);
    await db.execute(sql`update entitlement_plans set direction='owe' where org_id=${fx.orgId} and id=${planId}`);
    await assert.rejects(() => preflightPayRunAdjustment(depositInput), /BANKSTORE.*BANKOT.*accrued bank/);
    await db.execute(sql`update entitlement_plans set direction='accrue' where org_id=${fx.orgId} and id=${planId}`);
    await db.execute(sql`update pay_runs set run_type='termination' where org_id=${fx.orgId} and document_id=${first.documentId}`);
    await assert.rejects(() => preflightPayRunAdjustment(depositInput), /BANKSTORE.*termination run.*ordinary editable run/);
    await db.execute(sql`update pay_runs set run_type='regular' where org_id=${fx.orgId} and document_id=${first.documentId}`);
    const conflictingPlan = randomUUID();
    await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,deposit_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${conflictingPlan},${fx.orgId},'BANKALT','Alternate overtime bank','hours','accrue','manual',${store},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
    await assert.rejects(() => preflightPayRunAdjustment(depositInput), /BANKSTORE.*multiple entitlement banks \(BANKALT, BANKOT\)/);
    await db.execute(sql`delete from entitlement_plans where org_id=${fx.orgId} and id=${conflictingPlan}`);
    assert.deepEqual(await preflightPayRunAdjustment(depositInput), { replayed: false });
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from pay_run_adjustments
      where org_id=${fx.orgId} and pay_run_document_id=${first.documentId}`)).rows[0]!.count, 0);
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log
      where org_id=${fx.orgId} and table_name='pay_run_adjustments' and row_id=${depositInput.mutation.idempotencyKey}`)).rows[0]!.count, 0);
    await mutatePayRunAdjustment({ ...input, mutation: { action: 'add', employeePartyId: partyId,
      componentId: overtime, amount: '240', hours: '8' } });
    assert.deepEqual(await mutatePayRunAdjustment(depositInput), { changed: true, replayed: false });
    // A money bank retains signed cash and source hours, but its ledger unit is money.
    const cash = await earningComponent(fx, 'BANKCASH');
    const cashPlan = randomUUID();
    await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${cashPlan},${fx.orgId},'CASHBANK','Banked cash','money','accrue','manual',${cash},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
    await mutatePayRunAdjustment({ ...input, mutation: { action: 'add', employeePartyId: partyId,
      componentId: cash, amount: '-60', hours: '-2', note: 'Cash earnings transferred to the money bank' } });
    // Replays keep the original input; fresh writes and calculation recheck the bank.
    await db.execute(sql`update entitlement_plans set is_active=false where org_id=${fx.orgId} and id=${planId}`);
    assert.deepEqual(await mutatePayRunAdjustment(depositInput), { changed: false, replayed: true });
    await assert.rejects(() => preflightPayRunAdjustment({ ...depositInput,
      mutation: { ...depositInput.mutation, idempotencyKey: randomUUID() } }), /BANKSTORE.*no active entitlement bank/);
    const retired = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId });
    assert.equal(retired.errors.length, 1);
    assert.match(retired.errors[0]!.message, /BANKSTORE.*no active entitlement bank/);
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from entitlement_ledger
      where org_id=${fx.orgId} and plan_id=${planId}`)).rows[0]!.count, 0);
    await db.execute(sql`update entitlement_plans set is_active=true where org_id=${fx.orgId} and id=${planId}`);
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log
      where org_id=${fx.orgId} and table_name='pay_run_adjustments' and row_id=${depositInput.mutation.idempotencyKey}`)).rows[0]!.count, 1);
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId })).errors, []);
    const deposit = (await db.execute<{ amount: string; hours: string | null }>(sql`select amount::text as amount,hours::text
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${planId} and kind='bank_in'`)).rows;
    assert.equal(deposit.length, 1);
    assert.equal(deposit[0]!.amount, '8.0000');
    assert.equal(cmp(deposit[0]!.hours ?? '0', '8'), 0);
    assert.equal(await balanceOf(fx, partyId, planId, '2026-07-21'), '8.0000');
    const cashDeposit = (await db.execute<{ amount: string; hours: string | null }>(sql`select amount::text, hours::text
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${cashPlan} and kind='bank_in'`)).rows;
    assert.equal(cashDeposit.length, 1);
    assert.equal(cashDeposit[0]!.amount, '60.0000');
    assert.equal(cashDeposit[0]!.hours, null);
    // Week two: 5 hours taken as cash; a further 5 would overdraw the 3 left.
    await hours(fx, partyId, ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']);
    const second = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-19', periodEnd: '2026-07-25' });
    await mutatePayRunAdjustment({ ...input, documentId: second.documentId, mutation: { action: 'add', employeePartyId: partyId,
      componentId: take, amount: '150', hours: '5' } });
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId })).errors, []);
    assert.equal(await balanceOf(fx, partyId, planId, '2026-07-28'), '3.0000');
    await hours(fx, partyId, ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']);
    const third = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: '2026-07-26', periodEnd: '2026-08-01' });
    await mutatePayRunAdjustment({ ...input, documentId: third.documentId, mutation: { action: 'add', employeePartyId: partyId,
      componentId: take, amount: '150', hours: '5' } });
    const refused = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: third.documentId });
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0]!.message, /Banked Time Employee.*Banked overtime payout of 5.*exceeds the available 3/);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test('one payout component settling two plans refuses naming both', { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52,subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.scheduleId}`);
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
