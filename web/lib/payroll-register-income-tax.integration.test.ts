import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { sql } from 'drizzle-orm'
registerHooks({ resolve(s, c, n) { if (s === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true }; return n(s, c) } })
const { db, pool } = await import('@openbooks/engine/src/platform/db.ts')
const { withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PAYROLL_COUNTRY_PACKS, eiColumnSystemKeys, employeeSocialInsuranceSystemKeys, packStatutoryComponents } = await import('@openbooks/engine/src/payroll/packs.ts')
const { REPORT_ENTITY_MAP } = await import('@openbooks/reports')
const { compileCustomQuery } = await import('@openbooks/reports')
const { reportEntityCatalog } = await import('./custom-record-report-catalog')

const catalogFor = (orgId: string) => {
  const userId = randomUUID()
  return reportEntityCatalog({
    user: { id: userId, email: 'register-fixture@example.test', name: 'Register fixture', orgId, roles: [], isSuperAdmin: false, homeUserId: userId, homeOrgId: orgId, productionOrgId: orgId, envKind: 'production' as const },
    permissions: new Set(['records.read']),
    allowedSubsidiaryIds: null,
  } as never)
}

/**
 * The payroll register read employee social insurance out of the stub
 * factors JSON as C + C2 + SS + MED + MED2 (cpp_fica) and EI (ei) — Canadian
 * and US engine internals. Eleven packs reported 0.00 beside a net that
 * reflected their contributions, and QPIP appeared in NEITHER bucket: real
 * withheld money with no column. Both columns now aggregate the
 * pack-declared set (every deduction assessed on earnings) from the stub
 * lines — `ei` the stated EI-family pair, `cpp_fica` every other key by
 * structural complement — with both columns and both labels untouched.
 */
test('payroll register social buckets: eleven packs counted, QPIP folded into EI', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const orgId = org.orgId
    assert.deepEqual(eiColumnSystemKeys(), ['ei', 'qpip'])
    const liveSocial = employeeSocialInsuranceSystemKeys()
    for (const key of ['qpip', 'zus_emeryt', 'nic', 'ss', 'inps']) {
      assert.ok(liveSocial.includes(key), `${key} is counted on the day its pack registers`)
    }

    // The shipped wiring binds the live pack sets into the executed catalog.
    // Reads run tenant-scoped (withOrgContext): the register must work under
    // real RLS, and fixture writes run in trusted bypass (withBypass) —
    // importing the catalog pulls the web request-org resolver, which denies
    // outside a request, so bare pooled writes would die on RLS here.
    const catalog = await withOrgContext(orgId, () => catalogFor(orgId))
    assert.match(catalog.pay_stubs!.columns.find((c) => c.key === 'cpp_fica')!.expr, /cpp_fica_lines/)
    assert.match(catalog.pay_stubs!.columns.find((c) => c.key === 'ei')!.expr, /ei_lines/)
    assert.equal(catalog.pay_stubs!.columns.find((c) => c.key === 'cpp_fica')!.label, 'CPP / FICA (employee)')
    assert.equal(catalog.pay_stubs!.columns.find((c) => c.key === 'ei')!.label, 'EI (employee)')
    assert.ok(catalog.pay_stubs!.from.includes(`'pit'`), 'executed catalog inlines the live key set')
    assert.ok(catalog.pay_stubs!.from.includes(`'qpip'`), 'QPIP rides the executed derivation')

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
    await withBypass(async () => {
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
      cppEr: await component('CPP-ER', 'CPP (employer)', 'employer_contribution', 'cpp', 'CA'),
      ei: await component('EI', 'EI', 'deduction', 'ei', 'CA'),
      eiEr: await component('EI-ER', 'EI (employer)', 'employer_contribution', 'ei', 'CA'),
      qpip: await component('QPIP', 'QPIP', 'deduction', 'qpip', 'CA'),
    }
    const us = {
      fit: await component('FIT', 'Federal income tax', 'deduction', 'fit', 'US'),
      sit: await component('SIT', 'State income tax', 'deduction', 'state_income_tax', 'US'),
      ss: await component('SS', 'Social Security', 'deduction', 'ss', 'US'),
      med: await component('MED', 'Medicare', 'deduction', 'medicare', 'US'),
    }
    const L = (componentId: string, description: string, amount: string, kind = 'deduction') =>
      ({ componentId, kind, description, amount })

    // Poland: ZUS contributions beside a net that reflects them, no CA/US
    // factor anywhere — the old buckets printed 0.00 and 0.00.
    await stub('Jan Kowalski', 'MZ', 'PLN', '10000.0000', '7000.0000', {},
      [L(pl.pit, 'Zaliczka na podatek dochodowy (PIT)', '498.0000'),
       L(pl.emeryt, 'Skladka emerytalna (pracownik)', '1500.0000')])
    // Ontario, periodic only: the old buckets were already complete here.
    await stub('Alice Ontario', 'ON', 'CAD', '5000.0000', '3500.0000',
      { C: '250.0000', EI: '80.0000', T: '1234.5600' },
      [L(ca.tax, 'Income tax', '1234.5600'), L(ca.cpp, 'CPP', '250.0000'), L(ca.ei, 'EI', '80.0000')])
    // Ontario with a bonus.
    await stub('Bob Bonus', 'ON', 'CAD', '8000.0000', '5000.0000',
      { C: '300.0000', EI: '90.0000', T: '1500.0000', TB: '400.0000' },
      [L(ca.tax, 'Income tax', '1900.0000'), L(ca.cpp, 'CPP', '300.0000'), L(ca.ei, 'EI', '90.0000')])
    // US federal only: the old buckets were already complete here.
    await stub('Carol Federal', 'CA', 'USD', '6000.0000', '4500.0000',
      { SS: '372.0000', MED: '87.0000', FIT: '800.0000' },
      [L(us.fit, 'Federal income tax', '800.0000'), L(us.ss, 'Social Security', '372.0000'),
       L(us.med, 'Medicare', '87.0000')])
    // Quebec: QPIP was in NO register column at all (250 + 65 = 315 shown of
    // 345 withheld). The employer-share lines ride the same system keys as
    // production pushStatutory posts them and must stay out of both totals.
    await stub('Danielle Quebec', 'QC', 'CAD', '5000.0000', '3200.0000',
      { C: '250.0000', EI: '65.0000', T: '900.0000', QC_A: '4800.0000' },
      [L(ca.tax, 'Income tax', '900.0000'), L(ca.qctax, 'Quebec income tax', '600.0000'),
       L(ca.cpp, 'CPP', '250.0000'), L(ca.cppEr, 'CPP (employer)', '111.1100', 'employer_contribution'),
       L(ca.ei, 'EI', '65.0000'), L(ca.eiEr, 'EI (employer)', '22.2200', 'employer_contribution'),
       L(ca.qpip, 'QPIP', '30.0000')])
    // US with state tax.
    await stub('Eddie State', 'CA', 'USD', '6000.0000', '4200.0000',
      { SS: '372.0000', MED: '87.0000', FIT: '800.0000', SIT_CA: '300.0000' },
      [L(us.fit, 'Federal income tax', '800.0000'), L(us.sit, 'California PIT', '300.0000'),
       L(us.ss, 'Social Security', '372.0000'), L(us.med, 'Medicare', '87.0000')])
    })

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
    const legacy = await withOrgContext(orgId, () => run(REPORT_ENTITY_MAP.pay_stubs!))
    const bound = await withOrgContext(orgId, () => run(catalog.pay_stubs!))
    const row = (rows: Record<string, string>[], name: string) => rows.find((r) => r.employee === name)!

    // Income-tax column (from 6d006fd95, pinned again here): parity where the
    // old expression was complete, corrections where it dropped provincial /
    // state withholding.
    assert.equal(Number(row(legacy, 'Jan Kowalski').income_tax), 0)
    assert.equal(Number(row(bound, 'Jan Kowalski').income_tax), 498)
    for (const name of ['Alice Ontario', 'Bob Bonus', 'Carol Federal']) {
      assert.equal(Number(row(bound, name).income_tax), Number(row(legacy, name).income_tax), `${name} parity`)
    }
    assert.equal(Number(row(legacy, 'Danielle Quebec').income_tax), 900)
    assert.equal(Number(row(bound, 'Danielle Quebec').income_tax), 1500)
    assert.equal(Number(row(legacy, 'Eddie State').income_tax), 800)
    assert.equal(Number(row(bound, 'Eddie State').income_tax), 1100)

    // Social buckets before/after, every figure announced. Columns and
    // labels are unchanged; only the derivation moves.
    //
    //   Jan Kowalski    cpp_fica   0.00 -> 1500.00   ZUS, previously invisible
    //                   ei         0.00 ->    0.00
    //   Alice Ontario   cpp_fica 250.00 ->  250.00   parity (CPP)
    //                   ei        80.00 ->   80.00   parity
    //   Bob Bonus       cpp_fica 300.00 ->  300.00   parity
    //                   ei        90.00 ->   90.00   parity
    //   Carol Federal   cpp_fica 459.00 ->  459.00   parity (372 SS + 87 MED)
    //                   ei         0.00 ->    0.00
    //   Danielle Quebec cpp_fica 250.00 ->  250.00   parity (QPIP is not CPP)
    //                   ei        65.00 ->   95.00   +30.00 QPIP newly counted
    //   Eddie State     cpp_fica 459.00 ->  459.00   parity
    //                   ei         0.00 ->    0.00
    for (const [name, cppFica, ei, boundCpp, boundEi] of [
      ['Jan Kowalski', 0, 0, 1500, 0],
      ['Alice Ontario', 250, 80, 250, 80],
      ['Bob Bonus', 300, 90, 300, 90],
      ['Carol Federal', 459, 0, 459, 0],
      ['Danielle Quebec', 250, 65, 250, 95],
      ['Eddie State', 459, 0, 459, 0],
    ] as const) {
      assert.equal(Number(row(legacy, name).cpp_fica), cppFica, `${name} legacy cpp_fica`)
      assert.equal(Number(row(legacy, name).ei), ei, `${name} legacy ei`)
      assert.equal(Number(row(bound, name).cpp_fica), boundCpp, `${name} bound cpp_fica`)
      assert.equal(Number(row(bound, name).ei), boundEi, `${name} bound ei`)
    }
    // QPIP, named explicitly: 30.00 withheld, present in no legacy column
    // (250 + 65 = 315 of 345 withheld), present in the EI column now. The
    // employer shares on the same keys (111.11 + 22.22) stay out of both.
    assert.equal(
      Number(row(legacy, 'Danielle Quebec').cpp_fica) + Number(row(legacy, 'Danielle Quebec').ei),
      315,
    )
    assert.equal(Number(row(bound, 'Danielle Quebec').cpp_fica) + Number(row(bound, 'Danielle Quebec').ei), 345)

    // Still untouched on every stub: gross, income tax parity cases above,
    // net, employer cost.
    for (const rows of [legacy, bound]) assert.equal(rows.length, 6)
    for (const r of legacy) {
      const b = row(bound, r.employee!)
      for (const column of ['gross', 'net_pay', 'employer_cost']) {
        assert.equal(Number(b[column]), Number(r[column]), `${r.employee}.${column} untouched`)
      }
    }

    // Summarize mode (employee-totals built-in shape) sums the bound columns.
    const summaryQuery = {
      entity: 'pay_stubs', mode: 'summarize' as const, columns: [] as string[],
      breakouts: [{ column: 'employee' }],
      measures: [
        { fn: 'sum' as const, column: 'income_tax', label: 'Income tax withheld' },
        { fn: 'sum' as const, column: 'cpp_fica', label: 'CPP / FICA (employee)' },
        { fn: 'sum' as const, column: 'ei', label: 'EI (employee)' },
      ],
      filters: null, groupBy: null, limit: 100,
    }
    const summaryCompiled = compileCustomQuery(catalog.pay_stubs!, summaryQuery, orgId, { maxRows: 100 })
    const summary = await withOrgContext(orgId, () => pool.query(summaryCompiled.text, summaryCompiled.values as unknown[]))
    const totals = Object.fromEntries(summary.rows.map((r) => [r.d0, [Number(r.m0), Number(r.m1), Number(r.m2)]]))
    assert.deepEqual(totals['Jan Kowalski'], [498, 1500, 0])
    assert.deepEqual(totals['Alice Ontario'], [1234.56, 250, 80])
    assert.deepEqual(totals['Danielle Quebec'], [1500, 250, 95])
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

const COVERAGE_CURRENCY: Record<string, string> = {
  CA: 'CAD', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', IE: 'EUR', AU: 'AUD',
  IT: 'EUR', NL: 'EUR', ES: 'EUR', SG: 'SGD', JP: 'JPY', PL: 'PLN', BR: 'BRL',
}

/**
 * Per-pack "no declared deduction is invisible": for every registered pack,
 * a stub carrying one line per statutory component the pack declares —
 * posted with the declared kind, at a distinct whole-dollar amount — must
 * have every deduction dollar appear in some register column. The
 * expectation is re-derived from the declarations per component (never by
 * calling the key-set functions under test), so a pack added later fails
 * this test rather than silently reporting zero; the register binds the
 * live key sets, so a derivation that stops following the declarations
 * fails it too. The EI rule under test: ei/ei-family lines in `ei`,
 * every other earnings-assessed deduction in `cpp_fica`.
 */
test('payroll register: every statutory employee deduction appears in some column, per pack', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const orgId = org.orgId
    const catalog = await withOrgContext(orgId, () => catalogFor(orgId))
    const boundEntity = catalog.pay_stubs!
    assert.match(boundEntity.columns.find((c) => c.key === 'cpp_fica')!.expr, /cpp_fica_lines/)
    assert.match(boundEntity.columns.find((c) => c.key === 'ei')!.expr, /ei_lines/)
    assert.match(boundEntity.columns.find((c) => c.key === 'income_tax')!.expr, /income_tax_lines/)
    // The shipped wiring inlines every declared deduction key: a key the
    // SQL does not name is a column that cannot see it.
    const declaredDeductionKeys = new Set<string>()
    for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
      for (const component of packStatutoryComponents(pack.country)) {
        if (component.kind === 'deduction') declaredDeductionKeys.add(component.systemKey)
      }
    }
    assert.ok(declaredDeductionKeys.size > 0)
    for (const key of declaredDeductionKeys) {
      assert.ok(boundEntity.from.includes(`'${key}'`), `executed SQL names ${key}`)
    }
    // …and every named key sits in exactly one of the two social joins:
    // double-named money would double-count, unnamed money would vanish.
    // Income-ness comes from the declarations, not the function under test.
    const incomeKeys = new Set<string>()
    for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
      for (const component of packStatutoryComponents(pack.country)) {
        if (component.kind === 'deduction' && component.assessedOn === 'taxable_income') {
          incomeKeys.add(component.systemKey)
        }
      }
    }
    const cppJoin = boundEntity.from.slice(0, boundEntity.from.indexOf(') cpp_fica_lines on true'))
    const eiJoin = boundEntity.from.slice(boundEntity.from.indexOf(') cpp_fica_lines on true'))
    for (const key of declaredDeductionKeys) {
      if (!incomeKeys.has(key)) {
        assert.ok(
          cppJoin.includes(`'${key}'`) !== eiJoin.includes(`'${key}'`),
          `${key} sits in exactly one social join`,
        )
      }
    }

    let dollars = 0
    const expectedByEmployee: Record<string, { income: number; cpp: number; ei: number; deductions: number }> = {}
    const scheduleId = randomUUID()
    await withBypass(async () => {
    await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
      values (${scheduleId}, ${orgId}, 'Monthly', 'monthly', 12, '2026-01-31')`)
    const docId = randomUUID()
    await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, currency, status)
      values (${docId}, ${orgId}, 'pay_run', 'PR-REG-COVERAGE', '2026-07-31', 'CAD', 'draft')`)
    await db.execute(sql`insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
      values (${docId}, ${orgId}, ${scheduleId}, '2026-07-01', '2026-07-31', '2026-07-31', 2026, 'committed')`)

    // One stub per pack; every statutory component gets a line at a distinct
    // whole-dollar amount with the kind the pack declares for it — the shape
    // pushStatutory posts in production, including employer shares under
    // shared keys and refundable credits.
    for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
      const country = pack.country
      const name = `Coverage ${country}`
      const expected = { income: 0, cpp: 0, ei: 0, deductions: 0 }
      const partyId = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`)
      const stubId = randomUUID()
      await db.execute(sql`insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, currency_code, gross, net_pay, employer_cost, factors)
        values (${stubId}, ${orgId}, ${docId}, ${partyId}, ${country},
                12, '2026-07-31', 2026, ${COVERAGE_CURRENCY[country]}, '100000.0000', '60000.0000', '100000.0000', '{}'::jsonb)`)
      let sequence = 100
      for (const component of packStatutoryComponents(country)) {
        dollars += 1
        const componentId = randomUUID()
        await db.execute(sql`insert into pay_components (id, org_id, code, name, kind, system_key, country, sequence)
          values (${componentId}, ${orgId}, ${`${country}_${component.code}`}, ${component.name}, ${component.kind}, ${component.systemKey}, ${country}, 100)`)
        await db.execute(sql`insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount, sequence)
          values (${orgId}, ${stubId}, ${componentId}, ${component.kind}, ${component.name}, ${`${dollars}.0000`}, ${sequence})`)
        sequence += 10
        // Re-derived from the declarations, not from the functions under
        // test: this is the independent expectation the wiring must meet.
        // The EI rule as the register applies it: the ei/qpip pair lands in
        // `ei`, every other earnings-assessed deduction in `cpp_fica`.
        if (component.kind === 'deduction') {
          expected.deductions += dollars
          if (component.assessedOn === 'taxable_income') expected.income += dollars
          else if (component.systemKey === 'ei' || component.systemKey === 'qpip') expected.ei += dollars
          else expected.cpp += dollars
        }
      }
      expectedByEmployee[name] = expected
    }
    })

    const query = {
      entity: 'pay_stubs', mode: 'rows' as const,
      columns: ['employee', 'income_tax', 'cpp_fica', 'ei'],
      breakouts: [], measures: [], filters: null, groupBy: null,
      sorts: [{ column: 'employee', direction: 'asc' as const }], limit: 100,
    }
    const run = async (entity: (typeof REPORT_ENTITY_MAP)[string]) => {
      const compiled = compileCustomQuery(entity, { ...query }, orgId, { maxRows: 100 })
      return (await pool.query(compiled.text, compiled.values as unknown[])).rows as Record<string, string>[]
    }
    const bound = await withOrgContext(orgId, () => run(boundEntity))
    assert.equal(bound.length, Object.keys(PAYROLL_COUNTRY_PACKS).length)
    for (const [name, expected] of Object.entries(expectedByEmployee)) {
      const found = bound.find((r) => r.employee === name)!
      assert.equal(Number(found.income_tax), expected.income, `${name}: income_tax`)
      assert.equal(Number(found.cpp_fica), expected.cpp, `${name}: cpp_fica`)
      assert.equal(Number(found.ei), expected.ei, `${name}: ei`)
      // The assertion that would have caught all three defects: every
      // declared deduction dollar is visible in some register column, and
      // the three buckets partition it exactly (a shared key double-counted
      // would exceed the total here).
      assert.equal(
        Number(found.income_tax) + Number(found.cpp_fica) + Number(found.ei),
        expected.deductions,
        `${name}: no declared deduction invisible, none double-counted`,
      )
    }
    // Australia and the Netherlands correctly have no employee social
    // insurance: their packs declare no earnings-assessed deduction, so the
    // expected figures re-derived above are 0 — correctly nil, not silently
    // zero. Only Canada has EI-family lines; every other pack's social total
    // sits entirely in cpp_fica by the stated rule.
    for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
      const expected = expectedByEmployee[`Coverage ${country}`]!
      if (country === 'AU' || country === 'NL') {
        assert.equal(expected.cpp, 0, `${country} declares no employee social insurance`)
        assert.equal(expected.ei, 0, `${country} declares no employee social insurance`)
      } else {
        assert.ok(expected.cpp + expected.ei > 0, `${country} has a positive employee social total`)
      }
      if (country === 'CA') assert.ok(expected.ei > 0, 'CA has EI-family lines')
      else assert.equal(expected.ei, 0, `only CA packs EI-family lines, not ${country}`)
    }

    // Red-proof, generalized: the legacy factor expressions see NOTHING on
    // these stubs (no CA/US labels anywhere), while the bound register sees
    // every dollar the packs declare.
    const legacyQuery = { ...query, columns: ['employee', 'income_tax', 'cpp_fica', 'ei'] }
    const legacyCompiled = compileCustomQuery(REPORT_ENTITY_MAP.pay_stubs!, { ...legacyQuery }, orgId, { maxRows: 100 })
    const legacy = (await withOrgContext(orgId, () => pool.query(legacyCompiled.text, legacyCompiled.values as unknown[]))).rows as Record<string, string>[]
    for (const r of legacy) {
      assert.equal(Number(r.income_tax), 0, `${r.employee}: legacy income_tax blind`)
      assert.equal(Number(r.cpp_fica), 0, `${r.employee}: legacy cpp_fica blind`)
      assert.equal(Number(r.ei), 0, `${r.employee}: legacy ei blind`)
    }
    const boundDeductions = bound.reduce((sum, r) => sum + Number(r.income_tax) + Number(r.cpp_fica) + Number(r.ei), 0)
    const expectedDeductions = Object.values(expectedByEmployee).reduce((sum, e) => sum + e.deductions, 0)
    assert.ok(expectedDeductions > 0)
    assert.equal(boundDeductions, expectedDeductions)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
