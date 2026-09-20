import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { sql } from 'drizzle-orm'
registerHooks({ resolve(s, c, n) { if (s === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true }; return n(s, c) } })
const { db, pool } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { incomeTaxWithholdingSystemKeys } = await import('@openbooks/engine/src/payroll/packs.ts')
const { REPORT_ENTITY_MAP } = await import('@openbooks/reports')
const { compileCustomQuery } = await import('@openbooks/reports')
const { reportEntityCatalog } = await import('./custom-record-report-catalog')

/**
 * The payroll register printed 0.00 income tax for every pack whose engine
 * factor labels are not the CA/US ones (Poland: 498 zl withheld, 0.00 on
 * the register). The register must aggregate the pack-declared withholding
 * set from the stub lines instead, while CA/US stubs whose old expression
 * was already complete report byte-identical totals.
 */
test('payroll register income tax: non-CA/US packs counted, CA/US parity', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const orgId = org.orgId
    const liveKeys = incomeTaxWithholdingSystemKeys()
    assert.ok(liveKeys.includes('pit'), 'a new pack is covered on the day it registers')

    // The shipped wiring binds the live pack set into the executed catalog.
    const userId = randomUUID()
    const catalog = await reportEntityCatalog({
      user: { id: userId, email: 'register-fixture@example.test', name: 'Register fixture', orgId, roles: [], isSuperAdmin: false, homeUserId: userId, homeOrgId: orgId, productionOrgId: orgId, envKind: 'production' as const },
      permissions: new Set(['records.read']),
      allowedSubsidiaryIds: null,
    } as never)
    assert.match(catalog.pay_stubs!.columns.find((c) => c.key === 'income_tax')!.expr, /income_tax_lines/)
    assert.ok(catalog.pay_stubs!.from.includes(`'pit'`), 'executed catalog inlines the live key set')

    const employee = async (name: string) => {
      const id = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`)
      return id
    }
    const component = async (code: string, name: string, kind: string, systemKey: string, country: string) => {
      const id = randomUUID()
      await db.execute(sql`insert into pay_components (id, org_id, code, name, kind, system_key, country, sequence)
        values (${id}, ${orgId}, ${code}, ${name}, ${kind}, ${systemKey}, ${country}, 100)`)
      return id
    }
    // One shared run; each stub carries production-shaped data: line amounts
    // equal the computed withholding the factors trace (run-stub-records
    // writes both from the same calculation; quebec.integration asserts
    // income_tax line == T4127 totalTax == T + TB).
    const scheduleId = randomUUID()
    await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
      values (${scheduleId}, ${orgId}, 'Monthly', 'monthly', 12, '2026-01-31')`)
    const docId = randomUUID()
    await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, currency, status)
      values (${docId}, ${orgId}, 'pay_run', 'PR-REG-001', '2026-07-31', 'CAD', 'draft')`)
    await db.execute(sql`insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
      values (${docId}, ${orgId}, ${scheduleId}, '2026-07-01', '2026-07-31', '2026-07-31', 2026, 'committed')`)

    const stub = async (
      name: string, province: string, currency: string, gross: string, net: string,
      factors: Record<string, string>, lines: { componentId: string; kind: string; description: string; amount: string }[],
    ) => {
      const stubId = randomUUID()
      await db.execute(sql`insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, currency_code, gross, net_pay, employer_cost, factors)
        values (${stubId}, ${orgId}, ${docId}, ${await employee(name)}, ${province},
                12, '2026-07-31', 2026, ${currency}, ${gross}, ${net}, ${gross}, ${JSON.stringify(factors)}::jsonb)`)
      let sequence = 100
      for (const line of lines) {
        await db.execute(sql`insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount, sequence)
          values (${orgId}, ${stubId}, ${line.componentId}, ${line.kind}, ${line.description}, ${line.amount}, ${sequence})`)
        sequence += 10
      }
      return name
    }

    const pl = {
      pit: await component('PIT', 'Zaliczka na podatek dochodowy (PIT)', 'deduction', 'pit', 'PL'),
      emeryt: await component('EMERYT', 'Skladka emerytalna (pracownik)', 'deduction', 'zus_emeryt', 'PL'),
    }
    const ca = {
      tax: await component('TAX', 'Income tax', 'deduction', 'income_tax', 'CA'),
      qctax: await component('QCTAX', 'Quebec income tax', 'deduction', 'qc_income_tax', 'CA'),
      cpp: await component('CPP', 'CPP', 'deduction', 'cpp', 'CA'),
      ei: await component('EI', 'EI', 'deduction', 'ei', 'CA'),
      qpip: await component('QPIP', 'QPIP', 'deduction', 'qpip', 'CA'),
    }
    const us = {
      fit: await component('FIT', 'Federal income tax', 'deduction', 'fit', 'US'),
      sit: await component('SIT', 'State income tax', 'deduction', 'state_income_tax', 'US'),
      ss: await component('SS', 'Social Security', 'deduction', 'ss', 'US'),
      med: await component('MED', 'Medicare', 'deduction', 'medicare', 'US'),
    }
    const L = (componentId: string, description: string, amount: string) =>
      ({ componentId, kind: 'deduction', description, amount })

    // Poland, the reported case: 498.00 withheld, no CA/US factor anywhere.
    await stub('Jan Kowalski', 'MZ', 'PLN', '10000.0000', '7000.0000', {},
      [L(pl.pit, 'Zaliczka na podatek dochodowy (PIT)', '498.0000'),
       L(pl.emeryt, 'Skladka emerytalna (pracownik)', '1500.0000')])
    // Ontario, periodic only: the old expression was complete here.
    await stub('Alice Ontario', 'ON', 'CAD', '5000.0000', '3500.0000',
      { C: '250.0000', EI: '80.0000', T: '1234.5600' },
      [L(ca.tax, 'Income tax', '1234.5600'), L(ca.cpp, 'CPP', '250.0000'), L(ca.ei, 'EI', '80.0000')])
    // Ontario with a bonus: T + TB both withheld on one federal line.
    await stub('Bob Bonus', 'ON', 'CAD', '8000.0000', '5000.0000',
      { C: '300.0000', EI: '90.0000', T: '1500.0000', TB: '400.0000' },
      [L(ca.tax, 'Income tax', '1900.0000'), L(ca.cpp, 'CPP', '300.0000'), L(ca.ei, 'EI', '90.0000')])
    // US federal only: the old expression was complete here.
    await stub('Carol Federal', 'CA', 'USD', '6000.0000', '4500.0000',
      { SS: '372.0000', MED: '87.0000', FIT: '800.0000' },
      [L(us.fit, 'Federal income tax', '800.0000'), L(us.ss, 'Social Security', '372.0000'),
       L(us.med, 'Medicare', '87.0000')])
    // Quebec: provincial tax was never in the old expression (only T).
    await stub('Danielle Quebec', 'QC', 'CAD', '5000.0000', '3200.0000',
      { C: '250.0000', EI: '65.0000', T: '900.0000', QC_A: '4800.0000' },
      [L(ca.tax, 'Income tax', '900.0000'), L(ca.qctax, 'Quebec income tax', '600.0000'),
       L(ca.cpp, 'CPP', '250.0000'), L(ca.ei, 'EI', '65.0000'), L(ca.qpip, 'QPIP', '30.0000')])
    // US with state tax: SIT_CA was never in the old expression (only FIT).
    await stub('Eddie State', 'CA', 'USD', '6000.0000', '4200.0000',
      { SS: '372.0000', MED: '87.0000', FIT: '800.0000', SIT_CA: '300.0000' },
      [L(us.fit, 'Federal income tax', '800.0000'), L(us.sit, 'California PIT', '300.0000'),
       L(us.ss, 'Social Security', '372.0000'), L(us.med, 'Medicare', '87.0000')])

    const query = {
      entity: 'pay_stubs', mode: 'rows' as const,
      columns: ['employee', 'gross', 'cpp_fica', 'ei', 'income_tax', 'net_pay', 'employer_cost'],
      breakouts: [], measures: [], filters: null, groupBy: null,
      sorts: [{ column: 'employee', direction: 'asc' as const }], limit: 100,
    }
    const run = async (entity: (typeof REPORT_ENTITY_MAP)[string]) => {
      const compiled = compileCustomQuery(entity, { ...query }, orgId, { maxRows: 100 })
      return (await pool.query(compiled.text, compiled.values as unknown[])).rows as Record<string, string>[]
    }
    const legacy = await run(REPORT_ENTITY_MAP.pay_stubs!)
    const bound = await run(catalog.pay_stubs!)
    const row = (rows: Record<string, string>[], name: string) => rows.find((r) => r.employee === name)!

    // The reported defect, pinned: legacy prints 0.00 beside withheld PIT.
    assert.equal(Number(row(legacy, 'Jan Kowalski').income_tax), 0)
    assert.equal(Number(row(bound, 'Jan Kowalski').income_tax), 498)
    // CA/US parity where the old expression was complete: same totals.
    for (const name of ['Alice Ontario', 'Bob Bonus', 'Carol Federal']) {
      assert.equal(Number(row(bound, name).income_tax), Number(row(legacy, name).income_tax), `${name} parity`)
    }
    assert.equal(Number(row(bound, 'Alice Ontario').income_tax), 1234.56)
    assert.equal(Number(row(bound, 'Bob Bonus').income_tax), 1900)
    assert.equal(Number(row(bound, 'Carol Federal').income_tax), 800)
    // Intended corrections, loud not silent: provincial/state withholding the
    // old expression dropped now joins the federal figure, exactly as the
    // payslip YTD counts both.
    assert.equal(Number(row(legacy, 'Danielle Quebec').income_tax), 900)
    assert.equal(Number(row(bound, 'Danielle Quebec').income_tax), 1500)
    assert.equal(Number(row(legacy, 'Eddie State').income_tax), 800)
    assert.equal(Number(row(bound, 'Eddie State').income_tax), 1100)
    // Untouched columns are identical on every stub, including zeros.
    for (const rows of [legacy, bound]) assert.equal(rows.length, 6)
    for (const r of legacy) {
      const b = row(bound, r.employee!)
      for (const column of ['gross', 'cpp_fica', 'ei', 'net_pay', 'employer_cost']) {
        assert.equal(Number(b[column]), Number(r[column]), `${r.employee}.${column} untouched`)
      }
    }
    assert.equal(Number(row(bound, 'Danielle Quebec').cpp_fica), 250, 'QPIP stays out of CPP/FICA')
    assert.equal(Number(row(bound, 'Danielle Quebec').ei), 65)

    // Summarize mode (employee-totals built-in shape) sums the bound column.
    const summaryQuery = {
      entity: 'pay_stubs', mode: 'summarize' as const, columns: [] as string[],
      breakouts: [{ column: 'employee' }],
      measures: [{ fn: 'sum' as const, column: 'income_tax', label: 'Income tax withheld' }],
      filters: null, groupBy: null, limit: 100,
    }
    const summaryCompiled = compileCustomQuery(catalog.pay_stubs!, summaryQuery, orgId, { maxRows: 100 })
    const summary = await pool.query(summaryCompiled.text, summaryCompiled.values as unknown[])
    const totals = Object.fromEntries(summary.rows.map((r) => [r.d0, Number(r.m0)]))
    assert.equal(totals['Jan Kowalski'], 498)
    assert.equal(totals['Alice Ontario'], 1234.56)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
