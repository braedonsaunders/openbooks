import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, env } from '../platform/db.ts'
import { acknowledgePayRunRefusals, commitPayRun } from "./run-commit.ts";
import { allocateProportionally } from "./run-allocation.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { parsePayRunCalculationErrors, parsePayRunRefusalAcknowledgement, payRunRefusalDigest } from "./run-calculation-evidence.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { mutatePayRunAdjustment } from './run-adjustments.ts'
import { createRetroPayRun, proposeRetroPay } from './retro-store.ts'
import { PayrollError } from './error.ts'
import { abs, add, cmp, div, neg, sum } from '../money/money.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from '../testing/fixtures.ts'

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
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_method, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
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
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                             pay_basis, federal_claim_code, provincial_claim_code,
                                             vacation_percent, vacation_method, is_active,
                                             created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
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
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                             pay_basis, federal_claim_code, provincial_claim_code,
                                             vacation_method, is_active, created_by, updated_by)
      values (${f.orgId}, ${employeeId}, ${f.scheduleId}, 'CA', 'ON', 'salary', 1, 1,
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

/* Partial-refusal pins: three in-scope employees where two refuse must never
// commit silently. One calculates; the other two are refused by name with the
// engine's own refusal text. A fourth employee, deliberately excluded from the
// run's scope, is not "left out" and appears nowhere in the refusal set. */
async function partialRefusalFixture(label: string) {
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
  const addEmployee = async (name: string, payBasis: string, rateBasis: string | null) => {
    const employeeId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`)
    if (rateBasis) {
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', ${rateBasis}, '2026-01-01', true,
                ${actorId}, ${actorId})`)
    }
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                             pay_basis, federal_claim_code, provincial_claim_code,
                                             vacation_method, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', ${payBasis}, 1, 1,
              'accrue', true, ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, '2026-07-06', '8', 'approved', false,
              'unbilled', 'actual', ${actorId}, ${actorId})`)
    return employeeId
  }
  const paidId = await addEmployee(`${label} Paid`, 'hourly', 'hour')
  const noRateId = await addEmployee(`${label} NoRate`, 'hourly', null)
  const salaryId = await addEmployee(`${label} Salary`, 'salary', 'hour')
  const excludedId = await addEmployee(`${label} Excluded`, 'hourly', 'hour')
  const run = await createPayRun({
    orgId: org.orgId, actorId, payScheduleId: scheduleId,
    periodStart: '2026-07-05', periodEnd: '2026-07-18',
  })
  await mutatePayRunAdjustment({
    orgId: org.orgId, documentId: run.documentId, actorId,
    mutation: { action: 'exclude', employeePartyId: excludedId },
  })
  return { orgId: org.orgId, actorId, scheduleId, documentId: run.documentId, paidId, noRateId, salaryId, excludedId }
}

async function storedRunColumns(orgId: string, documentId: string) {
  return (await db.execute<{ calculation_errors: unknown; refusal_acknowledgement: unknown; run_status: string }>(sql`
    select calculation_errors, refusal_acknowledgement, run_status from pay_runs
     where org_id = ${orgId} and document_id = ${documentId}`)).rows[0]!
}

test('a run with refused in-scope employees cannot commit silently', { skip: !DB }, async () => {
  // The defect: one of three calculated, two refused, and commit posted with
  // zero errors. Commit must refuse instead, naming both employees WITH the
  // refusal text — and the deliberately excluded fourth employee is not
  // "left out", so they appear nowhere.
  const f = await partialRefusalFixture('Silent')
  try {
    const calculated = await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    assert.equal(calculated.employees, 1)
    assert.equal(calculated.errors.length, 2)
    const byName = new Map(calculated.errors.map((entry) => [entry.employee, entry]))
    assert.match(byName.get('Silent NoRate')!.message, /no labor cost rate covers this employee/)
    assert.match(byName.get('Silent Salary')!.message, /no annual labor cost rate/)
    assert.ok(!calculated.errors.some((entry) => entry.employee === 'Silent Excluded'),
      'a deliberately excluded employee is not a refusal')
    // The first calculate persists its exceptions wholesale: commit and the
    // run page read the same refusals the calculate saw.
    const stored = parsePayRunCalculationErrors(
      (await storedRunColumns(f.orgId, f.documentId)).calculation_errors,
    )
    assert.deepEqual(stored, calculated.errors)
    await assert.rejects(
      commitPayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId }),
      (error: unknown) => {
        assert.ok(error instanceof PayrollError)
        assert.match(error.message, /2 in-scope employees were refused/)
        assert.match(error.message, /Silent NoRate/)
        assert.match(error.message, /no labor cost rate covers this employee for the period/)
        assert.match(error.message, /Silent Salary/)
        assert.match(error.message, /salaried employee has no annual labor cost rate/)
        assert.ok(!error.message.includes('Silent Excluded'), 'the excluded employee is not named')
        return true
      },
      'commit names both refused employees with their refusal text',
    )
    const after = await storedRunColumns(f.orgId, f.documentId)
    assert.equal(after.run_status, 'calculated', 'the refused commit writes nothing')
    const lines = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from document_lines
       where org_id = ${f.orgId} and document_id = ${f.documentId}`)).rows[0]?.count
    assert.equal(lines, 0, 'no GL projection is materialized by a refused commit')
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('acknowledged refusals commit and the acknowledgement is recorded', { skip: !DB }, async () => {
  // The only path past the gate besides fixing the input: an explicit
  // acknowledgement that names who is left out and why, retrievable after
  // posting so an auditor can see the decision months later.
  const f = await partialRefusalFixture('Acked')
  try {
    await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    const acknowledgement = await acknowledgePayRunRefusals({
      orgId: f.orgId, documentId: f.documentId, actorId: f.actorId,
    })
    assert.equal(acknowledgement.acknowledgedBy, f.actorId)
    assert.deepEqual(
      acknowledgement.refusals.map((entry) => entry.employee).sort(),
      ['Acked NoRate', 'Acked Salary'],
    )
    assert.ok(acknowledgement.refusals.every((entry) => entry.message.length > 0),
      'the acknowledgement carries the refusal text, not just names')
    const committed = await commitPayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    assert.ok(committed.lines > 0, 'the acknowledged run commits')
    const after = await storedRunColumns(f.orgId, f.documentId)
    assert.equal(after.run_status, 'committed')
    const recordedAck = parsePayRunRefusalAcknowledgement(after.refusal_acknowledgement)
    assert.ok(recordedAck, 'the acknowledgement survives the commit')
    assert.deepEqual(
      recordedAck.refusals.map((entry) => entry.employee).sort(),
      ['Acked NoRate', 'Acked Salary'],
    )
    assert.ok(recordedAck.refusals.every((entry) => entry.message.length > 0))
    const refusals = (parsePayRunCalculationErrors(after.calculation_errors) ?? [])
      .filter((entry) => entry.kind === 'refusal')
    assert.equal(recordedAck.errorsDigest, payRunRefusalDigest(refusals),
      'the recorded acknowledgement binds to the committed refusal set')
    const audit = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from audit_log
       where org_id = ${f.orgId} and table_name = 'pay_runs' and row_id = ${f.documentId}
         and changes->>'operation' = 'acknowledge-refusals'`)).rows[0]?.count
    assert.equal(audit, 1, 'the acknowledgement decision is in the audit log')
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('an acknowledgement does not authorise a different refusal set', { skip: !DB }, async () => {
  // Guardrail: acknowledging "NoRate and Salary are out" and then fixing
  // NoRate must not wave Salary's replacement set through — the old
  // acknowledgement binds to the set it named.
  const f = await partialRefusalFixture('Rebind')
  try {
    await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    await acknowledgePayRunRefusals({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                    is_active, created_by, updated_by)
      values (${f.orgId}, ${f.noRateId}, 'CAD', '30', 'hour', '2026-01-01', true,
              ${f.actorId}, ${f.actorId})`)
    const recalculated = await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    // Wholesale replace: the fixed employee leaves exactly one stored refusal.
    assert.deepEqual(recalculated.errors.map((entry) => entry.employee), ['Rebind Salary'])
    const stored = parsePayRunCalculationErrors(
      (await storedRunColumns(f.orgId, f.documentId)).calculation_errors,
    )
    assert.deepEqual((stored ?? []).map((entry) => entry.employee), ['Rebind Salary'])
    await assert.rejects(
      commitPayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId }),
      /1 in-scope employee was refused.*Rebind Salary/,
      'the stale acknowledgement does not authorise the new refusal set',
    )
    await acknowledgePayRunRefusals({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    await commitPayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    const after = await storedRunColumns(f.orgId, f.documentId)
    assert.equal(after.run_status, 'committed', 'a fresh acknowledgement authorises the current set')
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('a fully fixed run commits with no acknowledgement demanded', { skip: !DB }, async () => {
  // Guardrail: a successful calculate clears the refusal record, so the gate
  // is not a permanent tax — refuse, fix everything, recalculate, commit.
  const f = await partialRefusalFixture('Fixed')
  try {
    await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                    is_active, created_by, updated_by)
      values (${f.orgId}, ${f.noRateId}, 'CAD', '30', 'hour', '2026-01-01', true,
              ${f.actorId}, ${f.actorId})`)
    await db.execute(sql`
      update labor_cost_rates set effective_to = '2026-06-30', updated_at = now()
       where org_id = ${f.orgId} and employee_party_id = ${f.salaryId}
         and effective_from = '2026-01-01'`)
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                    is_active, created_by, updated_by)
      values (${f.orgId}, ${f.salaryId}, 'CAD', '90000', 'year', '2026-07-01', true,
              ${f.actorId}, ${f.actorId})`)
    const recalculated = await calculatePayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    assert.deepEqual(recalculated.errors, [])
    assert.equal(recalculated.employees, 3)
    const after = await storedRunColumns(f.orgId, f.documentId)
    assert.deepEqual(parsePayRunCalculationErrors(after.calculation_errors), [],
      'a successful calculate stores the empty set, not the old refusals')
    await commitPayRun({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId })
    assert.equal((await storedRunColumns(f.orgId, f.documentId)).run_status, 'committed')
    await assert.rejects(
      acknowledgePayRunRefusals({ orgId: f.orgId, documentId: f.documentId, actorId: f.actorId }),
      /already committed/,
      'there is nothing left to acknowledge after the commit',
    )
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('a run where every in-scope employee refuses is not a success', { skip: !DB }, async () => {
  // The "Calculated £0.00 / 0 employees" case: zero stubs with a clean shape
  // must still refuse to commit, and the calculate result itself carries the
  // refusals rather than reading as a clean zero.
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
      values (${scheduleId}, ${org.orgId}, 'AllRefused Schedule', 'biweekly', 26, '2026-07-18',
              3, true, ${actorId}, ${actorId})`)
    for (const name of ['AllRefused A', 'AllRefused B']) {
      const employeeId = randomUUID()
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_method, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                'accrue', true, ${actorId}, ${actorId})`)
    }
    const run = await createPayRun({
      orgId: org.orgId, actorId, payScheduleId: scheduleId,
      periodStart: '2026-07-05', periodEnd: '2026-07-18',
    })
    const calculated = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId })
    assert.equal(calculated.employees, 0)
    assert.equal(calculated.errors.length, 2, 'zero stubs still carries both refusals')
    await assert.rejects(
      commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId }),
      /2 in-scope employees were refused/,
      'an all-refused run cannot commit without acknowledgement',
    )
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})
