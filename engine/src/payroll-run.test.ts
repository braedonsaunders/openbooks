import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, env } from './db.ts'
import { allocateProportionally, calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } from './payroll-run.ts'
import { createRetroPayRun, proposeRetroPay } from './payroll-retro-store.ts'
import { PayrollError } from './payroll-error.ts'
import { abs, add, cmp, div, neg, sum } from './money.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from './test-fixtures.ts'

test('allocateProportionally splits exactly with the remainder on the last bucket', () => {
  const splits = allocateProportionally('100.0000', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '1', target: 'c' },
  ])
  assert.deepEqual(splits.map((split) => split.amount), ['33.3300', '33.3300', '33.3400'])
  assert.equal(sum(splits.map((split) => split.amount)), '100.0000')
})

test('allocateProportionally never emits a negative split on half-cent shares', () => {
  // $0.02 across four equal jobs: every exact share is half a cent. Rounding
  // each share up independently leaves the remainder bucket at -$0.01, which
  // would land on the stub as a negative employer line.
  const splits = allocateProportionally('0.0200', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '1', target: 'c' },
    { weight: '1', target: 'd' },
  ])
  assert.deepEqual(splits.map((split) => split.amount), ['0.0000', '0.0000', '0.0100', '0.0100'])
  assert.equal(sum(splits.map((split) => split.amount)), '0.0200')
})

test('allocateProportionally pays a zero-weight bucket nothing, even last', () => {
  // A job with no hours in the split population must never receive rounding
  // money: the old last-absorbs-remainder design paid it the leftover cents.
  const splits = allocateProportionally('100.0000', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '0', target: 'c' },
  ])
  assert.deepEqual(splits.map((split) => split.amount), ['50.0000', '50.0000', '0.0000'])
  const zeroFirst = allocateProportionally('100.0000', [
    { weight: '0', target: 'a' },
    { weight: '3', target: 'b' },
  ])
  assert.deepEqual(zeroFirst.map((split) => split.amount), ['0.0000', '100.0000'])
})

test('allocateProportionally keeps every share within one cent of its exact target', () => {
  // Seven uneven jobs over a prime total: every exact share is fractional, so
  // this exercises floors, remainders and tie-breaking together.
  const weights = ['1', '2', '3', '4', '5', '6', '7']
  const splits = allocateProportionally('123.4500', weights.map((weight, index) => ({ weight, target: index })))
  assert.equal(sum(splits.map((split) => split.amount)), '123.4500')
  const totalWeight = '28'
  for (const [index, split] of splits.entries()) {
    const exact = div('123.4500', div(totalWeight, weights[index]!))
    const drift = abs(add(split.amount, neg(exact)))
    assert.ok(cmp(drift, '0.01') < 0, `bucket ${index} drifts ${drift} from its exact share`)
    assert.ok(cmp(split.amount, '0') >= 0, `bucket ${index} keeps the amount's sign`)
  }
})

test('allocateProportionally preserves the sign of a negative amount', () => {
  const splits = allocateProportionally('-0.0200', [
    { weight: '1', target: 'a' },
    { weight: '1', target: 'b' },
    { weight: '1', target: 'c' },
    { weight: '1', target: 'd' },
  ])
  for (const split of splits) {
    assert.ok(cmp(split.amount, '0') <= 0, `split keeps the negative sign: ${split.amount}`)
  }
  assert.equal(sum(splits.map((split) => split.amount)), '-0.0200')
})

test('allocateProportionally refuses a sub-cent amount instead of misallocating it', () => {
  // 1.90c over 19 equal jobs: the old dust handling parked the whole 1.90c
  // on the last bucket (ideal share 0.10c), breaking the within-one-cent
  // bound. Both native call sites pass cent-exact stub money, so a sub-cent
  // input is a caller bug and must fail loudly and deterministically.
  const buckets = Array.from({ length: 19 }, (_, index) => ({ weight: '1', target: index }))
  assert.throws(
    () => allocateProportionally('0.0190', buckets),
    (error) => error instanceof PayrollError && /cent-exact/.test(error.message),
  )
})

const DB = !!env.OPENBOOKS_DB_URL

/* Calculation-path pins: one minimal hourly fixture serves the run-type,
// pay-rate, and net-pay guards below. A second salaried employee covers the
// unusable-rate refusal. */
async function hourlyCalcFixture(label: string, days: { workedOn: string; hours: string }[]) {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID()
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`)
    return id
  }
  const wageExpense = await account('6000', 'Wages expense', 'expense')
  const netPayable = await account('2300', 'Wages payable', 'liability_current')
  const craPayable = await account('2310', 'CRA remittances payable', 'liability_current')
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        netPayAccountId: netPayable,
        cppPayableAccountId: craPayable,
        eiPayableAccountId: craPayable,
        taxPayableAccountId: craPayable,
        wagesTo: 'expense',
      },
    })}::jsonb where id = ${org.orgId}`)
  await seedPayrollComponents(org.orgId, actorId, 'CA')
  const scheduleId = randomUUID()
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, ${`${label} Schedule`}, 'biweekly', 26, '2026-07-18',
            3, true, ${actorId}, ${actorId})`)
  const employeeId = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', ${`${label} Employee`}, true, '{}'::jsonb)`)
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true,
            ${actorId}, ${actorId})`)
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_method, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 1, 1,
            'accrue', true, ${actorId}, ${actorId})`)
  for (const day of days) {
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${day.workedOn}, ${day.hours}, 'approved', false,
              'unbilled', 'actual', ${actorId}, ${actorId})`)
  }
  const run = await createPayRun({
    orgId: org.orgId, actorId, payScheduleId: scheduleId,
    periodStart: '2026-07-05', periodEnd: '2026-07-18',
  })
  return { orgId: org.orgId, actorId, employeeId, scheduleId, documentId: run.documentId }
}

test('a retro run settles quantified back pay; a regular run never does', { skip: !DB }, async () => {
  // Run-type pin: only a retro run pulls quantified retro earnings onto the
  // stub (CA taxes them non-periodically, factor B). Treating a retro run as
  // regular silently drops the back pay; treating a regular run as retro
  // would pull another run's settlement onto this cheque.
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  try {
    const account = async (number: string, name: string, type: string) => {
      const id = randomUUID()
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
                '[]'::jsonb, '{}'::jsonb, true)`)
      return id
    }
    const wageExpense = await account('6000', 'Wages expense', 'expense')
    const netPayable = await account('2300', 'Wages payable', 'liability_current')
    const craPayable = await account('2310', 'CRA remittances payable', 'liability_current')
    const vacationPayable = await account('2320', 'Vacation payable', 'liability_current')
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({
        payroll: {
          wageExpenseAccountId: wageExpense,
          netPayAccountId: netPayable,
          cppPayableAccountId: craPayable,
          eiPayableAccountId: craPayable,
          taxPayableAccountId: craPayable,
          vacationPayableAccountId: vacationPayable,
          wagesTo: 'expense',
        },
      })}::jsonb where id = ${org.orgId}`)
    await seedPayrollComponents(org.orgId, actorId, 'CA')
    const scheduleId = randomUUID()
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-18', 3, true,
              ${actorId}, ${actorId})`)
    const employeeId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Retro Rita', true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                    effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2025-06-01', true,
              ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                             pay_basis, federal_claim_code, provincial_claim_code,
                                             vacation_percent, vacation_method, is_active,
                                             created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 1, 1,
              '4', 'accrue', true, ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, '2026-01-06', '8', 'approved', false,
              'unbilled', 'actual', ${actorId}, ${actorId})`)
    const source = await createPayRun({
      orgId: org.orgId, actorId, payScheduleId: scheduleId,
      periodStart: '2026-01-05', periodEnd: '2026-01-18', payDate: '2026-01-21',
    })
    const first = await calculatePayRun({ orgId: org.orgId, documentId: source.documentId, actorId })
    assert.deepEqual(first.errors, [])
    assert.equal(first.gross, '240.0000', '8 h x $30.00')
    await commitPayRun({ orgId: org.orgId, documentId: source.documentId, actorId })

    // Backdated raise to $33.00/h over the paid period: 8 h x $3.00 = $24.00.
    await db.execute(sql`
      update labor_cost_rates set effective_to = '2025-12-31', updated_at = now()
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}
         and effective_from = '2025-06-01'`)
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                    effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, 'CAD', '33', 'hour', '2026-01-01', true,
              ${actorId}, ${actorId})`)
    const proposal = await proposeRetroPay({
      orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: '2026-08-20',
    })
    assert.equal(proposal.payableTotal, '24.0000')
    const retro = await createRetroPayRun({
      orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: '2026-08-20',
    })
    const calculated = await calculatePayRun({ orgId: org.orgId, documentId: retro.documentId, actorId })
    assert.deepEqual(calculated.errors, [])
    assert.equal(calculated.gross, '24.0000', 'the retro cheque IS the difference')
    const stub = (await db.execute<{ gross: string; factors: Record<string, string> }>(sql`
      select gross, factors from pay_stubs
       where org_id = ${org.orgId} and pay_run_document_id = ${retro.documentId}`))
    assert.equal(stub.rows[0]!.gross, '24.0000')
    assert.equal(stub.rows[0]!.factors.B, '24.0000', 'CA taxes retro pay non-periodically')
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('a fixed deduction larger than earnings fails the stub instead of paying negative', { skip: !DB }, async () => {
  // Net-pay pin: $30.00 of earnings against a $250.00 assigned deduction must
  // surface a per-employee negative-net error, never a negative cheque. Never
  // refusing (the relaxed comparison) would persist and post a -$220 stub.
  const f = await hourlyCalcFixture('Garnished', [{ workedOn: '2026-07-06', hours: '1' }])
  try {
    const componentId = randomUUID()
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, is_active, created_by, updated_by)
      values (${componentId}, ${f.orgId}, 'GARN', 'Garnishment', 'deduction', true,
              ${f.actorId}, ${f.actorId})`)
    await db.execute(sql`
      insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                           effective_from, is_active, created_by, updated_by)
      values (${f.orgId}, ${f.employeeId}, ${componentId}, '250', '2026-01-01', true,
              ${f.actorId}, ${f.actorId})`)
    const calculated = await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    assert.equal(calculated.errors.length, 1)
    assert.match(calculated.errors[0]!.message, /net pay is negative/)
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('a salaried employee holding only an hourly rate is refused before calculation', { skip: !DB }, async () => {
  // Pay-rate pin: salary basis needs an annual rate. Calculating anyway would
  // divide an hourly wage as if it were a salary (or crash on the missing
  // annual figure); refusing the usable-rate gate the other way would block
  // every correctly-rated run, which the passing calculations above already
  // disprove on every run.
  const f = await hourlyCalcFixture('Salaried', [])
  try {
    const employeeId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${f.orgId}, 'person', 'Salaried Sam', true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                    is_active, created_by, updated_by)
      values (${f.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true,
              ${f.actorId}, ${f.actorId})`)
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                             pay_basis, federal_claim_code, provincial_claim_code,
                                             vacation_method, is_active, created_by, updated_by)
      values (${f.orgId}, ${employeeId}, ${f.scheduleId}, 'ON', 'salary', 1, 1,
              'accrue', true, ${f.actorId}, ${f.actorId})`)
    const calculated = await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    const refusal = calculated.errors.find((e) => e.employee === 'Salaried Sam')
    assert.ok(refusal, 'the unusable rate is a per-employee calculation error')
    assert.match(refusal!.message, /no annual labor cost rate/)
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test(
  'createPayRun enforces a restricted subsidiary scope inside its transaction',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    const actorId = (await seedFlowActors(org.orgId)).adminId
    const childSubsidiaryId = randomUUID()
    const scheduleId = randomUUID()
    try {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country,
                                  tax_ids, is_elimination, is_active, custom)
        values (${childSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Child Co', 'CAD', 'CA',
                '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year,
                                   anchor_period_end, pay_date_offset_days, subsidiary_id,
                                   is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Child biweekly', 'biweekly', 26,
                '2026-07-18', 3, ${childSubsidiaryId}, true, ${actorId}, ${actorId})`)

      await assert.rejects(
        createPayRun({
          orgId: org.orgId,
          actorId,
          payScheduleId: scheduleId,
          periodStart: '2026-07-05',
          periodEnd: '2026-07-18',
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        }),
        /pay schedule not found/,
        'a schedule outside the caller scope is opaque to the direct engine caller',
      )

      const concurrent = await Promise.allSettled([
        createPayRun({
          orgId: org.orgId,
          actorId,
          payScheduleId: scheduleId,
          periodStart: '2026-07-05',
          periodEnd: '2026-07-18',
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        }),
        createPayRun({
          orgId: org.orgId,
          actorId,
          payScheduleId: scheduleId,
          periodStart: '2026-07-05',
          periodEnd: '2026-07-18',
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        }),
      ])
      assert.deepEqual(
        concurrent.map((result) => result.status),
        ['rejected', 'rejected'],
        'concurrent out-of-scope callers are both refused before either can write',
      )

      const writes = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from documents
         where org_id = ${org.orgId} and kind = 'pay_run'`)
      assert.equal(writes.rows[0]?.count, 0, 'the rejected scope check writes no run')

      const allowed = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: '2026-07-05',
        periodEnd: '2026-07-18',
        allowedSubsidiaryIds: new Set([childSubsidiaryId]),
      })
      assert.ok(allowed.documentId, 'an in-scope schedule remains creatable')
    } finally {
      await dropScratchOrgReporting(org.orgId)
    }
  },
)
