import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../locale' && context.parentURL?.includes('/pdf-templates/values')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolveLocale(){return "en-CA"}' }
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } = await import('@openbooks/engine/src/payroll-run.ts')
const { setPackSlotAccount, incomeTaxWithholdingSystemKeys } = await import('@openbooks/engine/src/payroll/packs.ts')
const { completeRequestedDocumentVoid, requestDocumentVoid } = await import('@openbooks/engine/src/document-void.ts')
const { loadPdfRecordValues } = await import('./values')

const DB = !!process.env.OPENBOOKS_DB_URL

const parseMoney = (s: unknown): number => Number(String(s ?? '').replace(/[^0-9.]/g, '') || '0')
/** Exact-cent comparison: engine decimals sum in float here, the print rounds. */
const cents = (n: number): number => Math.round(n * 100)

async function account(orgId: string, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
            '[]'::jsonb, '{}'::jsonb, true)`))
  return id
}

/**
 * Committed-scope YTD oracle straight from the persisted stubs + lines. Its
 * component set is the same registry derivation the product query binds, so
 * the two cannot drift: a pack the derivation counts, the oracle counts.
 */
function incomeTaxKeyList() {
  return sql.join(
    incomeTaxWithholdingSystemKeys().map((key) => sql`${key}`),
    sql`, `,
  )
}

async function ytdOracle(orgId: string, employeeId: string, taxYear: number, payDate: string, currency: string) {
  const keys = incomeTaxKeyList()
  const r = (await withOrgContext(orgId, () => db.execute<{ gross: string; net: string; tax: string }>(sql`
    select coalesce(sum(s.gross), 0)::text as gross, coalesce(sum(s.net_pay), 0)::text as net,
           coalesce(sum(income_tax_lines.tax), 0)::text as tax
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents d on d.id = r.document_id and d.org_id = r.org_id and d.kind = 'pay_run'
      left join lateral (
        select coalesce(sum(l.amount), 0) as tax
          from pay_stub_lines l
          join pay_components c on c.id = l.component_id and c.org_id = l.org_id
         where l.org_id = s.org_id and l.stub_id = s.id
           and c.system_key in (${keys})
      ) income_tax_lines on true
     where s.org_id = ${orgId} and s.employee_party_id = ${employeeId}
       and s.tax_year = ${taxYear} and s.pay_date <= ${payDate}
       and s.currency_code = ${currency}
  `)))
  return r.rows[0]!
}

async function incomeTaxLines(orgId: string, stubId: string) {
  const keys = incomeTaxKeyList()
  const r = (await withOrgContext(orgId, () => db.execute<{ system_key: string; amount: string }>(sql`
    select c.system_key, l.amount::text as amount
      from pay_stub_lines l join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${orgId} and l.stub_id = ${stubId}
       and c.system_key in (${keys})
  `)))
  return r.rows
}

interface CaFixture {
  orgId: string
  actorId: string
  scheduleId: string
}

async function caPayrollOrg(): Promise<CaFixture> {
  return withBypassContext(async () => {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  const wageExpense = await account(org.orgId, '6000', 'Wages expense', 'expense')
  const burdenExpense = await account(org.orgId, '6010', 'Payroll burden', 'expense')
  const netPayable = await account(org.orgId, '2300', 'Wages payable', 'liability_current')
  const craPayable = await account(org.orgId, '2310', 'CRA payable', 'liability_current')
  const vacationPayable = await account(org.orgId, '2320', 'Vacation payable', 'liability_current')
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        cppPayableAccountId: craPayable,
        eiPayableAccountId: craPayable,
        taxPayableAccountId: craPayable,
        vacationPayableAccountId: vacationPayable,
        wagesTo: 'expense',
      },
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`)
  await seedPayrollComponents(org.orgId, actorId, 'CA')
  // Quebec source deductions remit to Revenu Quebec, not the CRA vendor, so
  // the qc slot carries its own account rather than the legacy tax mapping.
  await setPackSlotAccount(org.orgId, actorId, 'CA', 'qc_income_tax', craPayable)
  // The health services fund is an employer contribution the QC employer always
  // owes, so it needs a liability account before any QC employee can calculate.
  await setPackSlotAccount(org.orgId, actorId, 'CA', 'hsf', craPayable)
  const scheduleId = randomUUID()
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`)
  return { orgId: org.orgId, actorId, scheduleId }
  })
}

async function caEmployee(fx: CaFixture, name: string, province: string): Promise<string> {
  return withBypassContext(async () => {
  const id = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, true, '{}'::jsonb)`)
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id)
    values (${randomUUID()}, ${fx.orgId}, ${id})`)
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'CAD', '30', 'hour', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`)
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, is_active,
                                           created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'CA', ${province},
            'hourly', 1, 1, '4', 'accrue', true, ${fx.actorId}, ${fx.actorId})`)
  for (const day of ['2026-07-06', '2026-07-08', '2026-07-10', '2026-07-14', '2026-07-20', '2026-07-22', '2026-07-24', '2026-07-28']) {
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                                is_billable, billing_status, costing_basis, created_by, updated_by)
      values (${fx.orgId}, ${id}, ${day}, '20', 'approved',
              false, 'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`)
  }
  return id
  })
}

async function stubIdFor(orgId: string, documentId: string, employeeId: string): Promise<string> {
  const r = (await withOrgContext(orgId, () => db.execute<{ id: string }>(sql`
    select id from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}
     and employee_party_id = ${employeeId}`)))
  assert.ok(r.rows[0], 'engine-generated stub exists')
  return r.rows[0]!.id
}

test('printed YTD income tax counts every jurisdiction the engine actually withheld', { skip: !DB }, async () => {
  const fx = await caPayrollOrg()
  try {
    const ontario = await caEmployee(fx, 'Ontario Hourly', 'ON')
    const quebec = await caEmployee(fx, 'Quebec Hourly', 'QC')
    // A QC employer always owes the health services fund, so a live-but-
    // unconfigured ca_hsf slot refuses that employee by name at calculate.
    // This test is about what a printed stub counts, not about the levy.
    await withBypassContext(() => db.execute(sql`
      insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                           rate_values, created_by, updated_by)
      values (${fx.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"rate": "1.65"}',
              ${fx.actorId}, ${fx.actorId})`))
    const run = await withOrgContext(fx.orgId, () => createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: '2026-07-05', periodEnd: '2026-07-18',
    }))
    const result = await withOrgContext(fx.orgId, () => calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId }))
    assert.deepEqual(result.errors, [])
    await withOrgContext(fx.orgId, () => commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId }))

    for (const [employee, label] of [[ontario, 'Ontario'], [quebec, 'Quebec']] as const) {
      const stubId = await stubIdFor(fx.orgId, run.documentId, employee)
      const lines = await incomeTaxLines(fx.orgId, stubId)
      assert.ok(lines.length > 0, `${label} stub carries persisted income-tax lines`)
      const expected = lines.reduce((total, line) => total + Number(line.amount), 0)

      const record = await withOrgContext(fx.orgId, () => loadPdfRecordValues('pay_stub', fx.orgId, stubId))
      assert.ok(record)
      assert.equal(cents(parseMoney(record.values.ytd_tax)), cents(expected))
      // Gross/net scope is unchanged by the tax fix.
      const oracle = await ytdOracle(fx.orgId, employee, 2026, '2026-07-21', 'CAD')
      assert.equal(cents(parseMoney(record.values.ytd_gross)), cents(Number(oracle.gross)))
      assert.equal(cents(parseMoney(record.values.ytd_net)), cents(Number(oracle.net)))
    }

    // The Quebec stub withholds provincial tax on a real QC line — the old
    // factor list (federal T/TB only) printed the federal slice as the whole.
    const qcStub = await stubIdFor(fx.orgId, run.documentId, quebec)
    const qcLines = await incomeTaxLines(fx.orgId, qcStub)
    const qcProvincial = qcLines.filter((l) => l.system_key === 'qc_income_tax')
      .reduce((total, l) => total + Number(l.amount), 0)
    const qcFederal = qcLines.filter((l) => l.system_key === 'income_tax')
      .reduce((total, l) => total + Number(l.amount), 0)
    assert.ok(qcProvincial > 0, 'the QC fixture is genuinely subject to provincial tax')
    assert.ok(qcFederal > 0, 'the QC fixture is genuinely subject to federal tax')
    const qcRecord = await withOrgContext(fx.orgId, () => loadPdfRecordValues('pay_stub', fx.orgId, qcStub))
    assert.equal(cents(parseMoney(qcRecord!.values.ytd_tax)), cents(qcFederal + qcProvincial))

    // Ontario parity: no provincial line, federal only — the old answer.
    const onStub = await stubIdFor(fx.orgId, run.documentId, ontario)
    const onLines = await incomeTaxLines(fx.orgId, onStub)
    assert.ok(!onLines.some((l) => l.system_key === 'qc_income_tax'))
  } finally {
    await dropScratchOrgReporting(fx.orgId)
  }
})

test('a voided pay run leaves printed YTD through the real void path', { skip: !DB }, async () => {
  const fx = await caPayrollOrg()
  try {
    const employee = await caEmployee(fx, 'Voided Hourly', 'ON')
    const run1 = await withOrgContext(fx.orgId, () => createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: '2026-07-05', periodEnd: '2026-07-18',
    }))
    assert.deepEqual((await withOrgContext(fx.orgId, () => calculatePayRun({ orgId: fx.orgId, documentId: run1.documentId, actorId: fx.actorId }))).errors, [])
    await withOrgContext(fx.orgId, () => commitPayRun({ orgId: fx.orgId, documentId: run1.documentId, actorId: fx.actorId }))
    const stub1 = await stubIdFor(fx.orgId, run1.documentId, employee)
    const before = await withOrgContext(fx.orgId, () => loadPdfRecordValues('pay_stub', fx.orgId, stub1))
    assert.ok(before)
    assert.ok(parseMoney(before.values.ytd_tax) > 0)

    const run2 = await withOrgContext(fx.orgId, () => createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: '2026-07-19', periodEnd: '2026-08-01',
    }))
    assert.deepEqual((await withOrgContext(fx.orgId, () => calculatePayRun({ orgId: fx.orgId, documentId: run2.documentId, actorId: fx.actorId }))).errors, [])
    await withOrgContext(fx.orgId, () => commitPayRun({ orgId: fx.orgId, documentId: run2.documentId, actorId: fx.actorId }))
    const stub2 = await stubIdFor(fx.orgId, run2.documentId, employee)
    const during = await withOrgContext(fx.orgId, () => loadPdfRecordValues('pay_stub', fx.orgId, stub2))
    assert.ok(during)
    assert.ok(cents(parseMoney(during!.values.ytd_tax)) > cents(parseMoney(before!.values.ytd_tax)))

    // Fixture approval, as the void tests seed it: the approval flow owns the
    // draft→approved write; the void itself (including the run_status flip the
    // YTD scope reads) goes through the real void API below.
    await withBypassContext(() => db.execute(sql`update documents set status = 'approved', updated_at = now()
      where id = ${run2.documentId} and org_id = ${fx.orgId}`))
    await withOrgContext(fx.orgId, () => requestDocumentVoid({
      documentId: run2.documentId, orgId: fx.orgId, actorId: fx.actorId,
      reason: 'duplicate pay run entered in error', reversalDate: '2026-08-03',
    }))
    await withOrgContext(fx.orgId, () => completeRequestedDocumentVoid(run2.documentId, fx.orgId))

    // stub2 still loads (its row is history), but its YTD now counts the
    // surviving committed run only — identical to the pre-run-2 print.
    const after = await withOrgContext(fx.orgId, () => loadPdfRecordValues('pay_stub', fx.orgId, stub2))
    assert.ok(after)
    assert.equal(cents(parseMoney(after.values.ytd_tax)), cents(parseMoney(before!.values.ytd_tax)))
    assert.equal(cents(parseMoney(after.values.ytd_gross)), cents(parseMoney(before!.values.ytd_gross)))
  } finally {
    await dropScratchOrgReporting(fx.orgId)
  }
})

test('a US state-tax stub prints FIT plus state withholding in YTD tax', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
    const wageExpense = await account(org.orgId, '6000', 'Wages expense', 'expense')
    const burdenExpense = await account(org.orgId, '6010', 'Payroll burden', 'expense')
    const netPayable = await account(org.orgId, '2300', 'Wages payable', 'liability_current')
    const irsPayable = await account(org.orgId, '2330', 'Federal payroll taxes payable', 'liability_current')
    const statePayable = await account(org.orgId, '2360', 'State income tax payable', 'liability_current')
    const subsidiaryId = randomUUID()
    const scheduleId = randomUUID()
    const employee = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            wagesTo: 'expense',
            countries: ['US'],
          },
          features: { payroll: true },
        })}::jsonb where id = ${org.orgId}`)
      await seedPayrollComponents(org.orgId, actorId, 'US')
      for (const slot of ['fit', 'fica', 'futa', 'suta']) {
        await setPackSlotAccount(org.orgId, actorId, 'US', slot, irsPayable)
      }
      await setPackSlotAccount(org.orgId, actorId, 'US', 'state_income_tax', statePayable)
      await setPackSlotAccount(org.orgId, actorId, 'US', 'local_income_tax', statePayable)
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
                '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, subsidiary_id, is_active,
                                   created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, '2026-07-18', 3,
                ${subsidiaryId}, true, ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employee}, ${org.orgId}, 'person', 'Cali Coder', ${subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employee})`)
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employee}, 'USD', '52000', 'year', 2080, '2026-01-01', true,
                ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                               province, pay_basis, filing_status,
                                               is_active, created_by, updated_by)
        values (${org.orgId}, ${employee}, ${scheduleId}, 'US', 'CA',
                'salary', 'single', true, ${actorId}, ${actorId})`)
      // SUI is experience-rated, so a live-but-unconfigured us_sui slot refuses
      // this employee by name at calculate. This test is about what a printed
      // stub counts as income tax, not about the employer levy — give the
      // employer a rate so the run reaches the assertion. The employee carries
      // no filing account, so the rate resolves on the state alone.
      await db.execute(sql`
        insert into payroll_statutory_rates (org_id, country, rate_key, region, filing_account_id,
                                             tax_year, rate_values, created_by, updated_by)
        values (${org.orgId}, 'US', 'us_sui', 'CA', null, 2026,
                '{"rate": "0.034", "wageBase": "7000.00"}'::jsonb, ${actorId}, ${actorId})`)
    })

    const run = await withOrgContext(org.orgId, () => createPayRun({
      orgId: org.orgId, actorId, payScheduleId: scheduleId,
      periodStart: '2026-07-05', periodEnd: '2026-07-18',
    }))
    assert.deepEqual((await withOrgContext(org.orgId, () => calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId }))).errors, [])
    await withOrgContext(org.orgId, () => commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId }))
    const stubId = await stubIdFor(org.orgId, run.documentId, employee)

    // Engine-persisted reality, not hand keys: the state line exists and the
    // federal line exists, and the printed YTD is exactly their sum.
    const lines = await incomeTaxLines(org.orgId, stubId)
    const federal = lines.filter((l) => l.system_key === 'fit').reduce((t, l) => t + Number(l.amount), 0)
    const state = lines.filter((l) => l.system_key === 'state_income_tax').reduce((t, l) => t + Number(l.amount), 0)
    assert.ok(state > 0, 'the CA fixture genuinely withholds California PIT')
    assert.ok(federal > 0, 'the CA fixture genuinely withholds federal FIT')
    const record = await withOrgContext(org.orgId, () => loadPdfRecordValues('pay_stub', org.orgId, stubId))
    assert.ok(record)
    assert.equal(cents(parseMoney(record.values.ytd_tax)), cents(federal + state))
    const oracle = await ytdOracle(org.orgId, employee, 2026, '2026-07-21', 'USD')
    assert.equal(cents(parseMoney(record.values.ytd_gross)), cents(Number(oracle.gross)))
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})
