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
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadPdfRecordValues } = await import('./values')

const DB = !!process.env.OPENBOOKS_DB_URL

const parseMoney = (s: unknown): number => Number(String(s ?? '').replace(/[^0-9.]/g, '') || '0')
/** Exact-cent comparison: engine decimals sum in float here, the print rounds. */
const cents = (n: number): number => Math.round(n * 100)

/**
 * One committed stub with caller-supplied persisted deduction lines, bypassing
 * pack compute: the defect under test is in the YTD subquery's component set,
 * not in any pack's withholding arithmetic, so the lines are seeded the way a
 * pack's engine would have persisted them.
 */
async function seedStub(
  orgId: string,
  subId: string,
  opts: { currency: string; gross: string; net: string; province: string; lines: [string, string][] },
): Promise<string> {
  return withBypassContext(async () => {
    const employee = randomUUID()
    const docId = randomUUID()
    const stubId = randomUUID()
    const scheduleId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employee}, ${orgId}, 'person', ${`Emp ${stubId.slice(0, 8)}`}, true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active)
      values (${scheduleId}, ${orgId}, ${`Sched ${scheduleId.slice(0, 8)}`}, 'monthly', 12,
              '2026-07-31', 3, true)`)
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id,
                             document_date, currency, fx_rate)
      values (${docId}, ${orgId}, 'pay_run', 'approved', ${`PAY-${docId.slice(0, 8)}`}, ${subId},
              ${employee}, '2026-07-31', ${opts.currency}, 1)`)
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                            pay_date, tax_year, run_status)
      values (${docId}, ${orgId}, ${scheduleId}, '2026-07-01', '2026-07-31',
              '2026-07-31', 2026, 'committed')`)
    await db.execute(sql`
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                             periods_per_year, pay_date, tax_year, currency_code, gross, net_pay)
      values (${stubId}, ${orgId}, ${docId}, ${employee}, ${opts.province},
              12, '2026-07-31', 2026, ${opts.currency}, ${opts.gross}, ${opts.net})`)
    for (const [systemKey, amount] of opts.lines) {
      await db.execute(sql`
        insert into pay_components (id, org_id, code, name, kind, system_key, sequence)
        values (${randomUUID()}, ${orgId}, ${systemKey}, ${systemKey}, 'deduction', ${systemKey}, 110)
        on conflict do nothing`)
      const comp = (await db.execute<{ id: string }>(sql`
        select id from pay_components where org_id = ${orgId} and system_key = ${systemKey}`)).rows[0]!
      await db.execute(sql`
        insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount, sequence)
        values (${orgId}, ${stubId}, ${comp.id}, 'deduction', ${systemKey}, ${amount}, 110)`)
    }
    return stubId
  })
}

async function printedYtdTax(orgId: string, stubId: string): Promise<{ tax: number; gross: number; net: number }> {
  const record = await withOrgContext(orgId, () => loadPdfRecordValues('pay_stub', orgId, stubId))
  assert.ok(record)
  return {
    tax: parseMoney(record.values.ytd_tax),
    gross: parseMoney(record.values.ytd_gross),
    net: parseMoney(record.values.ytd_net),
  }
}

test('a non-CA/US payslip prints YTD tax equal to the income tax actually withheld', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    // The persona's AU observation: gross 4615.38, PAYG 1114.00, net 3501.38 —
    // the old CA/US key list printed YTD tax 0.00 here.
    const au = await seedStub(org.orgId, org.subsidiaryId, {
      currency: 'AUD', gross: '4615.38', net: '3501.38', province: 'NSW',
      lines: [['payg_withholding', '1114.00']],
    })
    const auYtd = await printedYtdTax(org.orgId, au)
    assert.equal(cents(auYtd.tax), cents(1114.00))
    assert.equal(cents(auYtd.gross), cents(4615.38))
    assert.equal(cents(auYtd.net), cents(3501.38))

    // Italy was UNDERSTATED rather than zero: IRPEF counted, both addizionali
    // did not. All three are income taxes on the same base and all count.
    const it = await seedStub(org.orgId, org.subsidiaryId, {
      currency: 'EUR', gross: '5000.00', net: '3500.00', province: 'MI',
      lines: [['income_tax', '800.00'], ['regional_surtax', '100.00'], ['municipal_surtax', '40.00']],
    })
    assert.equal(cents((await printedYtdTax(org.orgId, it)).tax), cents(940.00))
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('employee social contributions stay out of printed YTD tax', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    // GB: PAYE counts; employee NIC is a deduction remitted to an authority
    // but it is not income tax, so it must not inflate the figure.
    const gb = await seedStub(org.orgId, org.subsidiaryId, {
      currency: 'GBP', gross: '4600.00', net: '3300.00', province: 'ENG',
      lines: [['paye', '952.00'], ['nic', '348.00']],
    })
    assert.equal(cents((await printedYtdTax(org.orgId, gb)).tax), cents(952.00))
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('the already-correct CA pack prints a byte-identical YTD figure', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const ca = await seedStub(org.orgId, org.subsidiaryId, {
      currency: 'CAD', gross: '4000.00', net: '3500.00', province: 'ON',
      lines: [['income_tax', '500.00']],
    })
    const ytd = await printedYtdTax(org.orgId, ca)
    assert.equal(cents(ytd.tax), cents(500.00))
    assert.equal(cents(ytd.gross), cents(4000.00))
    assert.equal(cents(ytd.net), cents(3500.00))
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})
