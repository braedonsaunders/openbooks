import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __gbRoundtripState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__gbRoundtripState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { setPackSlotAccount } = await import('@openbooks/engine/src/payroll/packs.ts')
const {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} = await import('@openbooks/engine/src/payroll/run.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * THE hole, closed end to end: a GB employee with no P6/P9 coding notice is
 * refused BY NAME, and the SAME employee computes a PAYE line after the
 * notice is filed through POST /api/payroll/certificates. Before this work
 * the notice had no entry surface — the refusal was unreachable through the
 * product and gross-to-net had never been exercised for GB.
 *
 * Tax month 1 (pay date 2026-05-05, the last date whose record is complete by
 * definition) so no starter checklist is needed: the only missing input is
 * the tax code itself. £36,000 a year is £3,000 for the month — comfortably
 * above the monthly allowance, so a computed run prices a positive PAYE line.
 */

const FIRST_START = '2026-04-01'
const FIRST_END = '2026-04-30'
const FIRST_PAY = '2026-05-05'
// A second period needs its own run document: May also proves the cumulative
// path (starter declaration A on file, prior month unpaid), not just month 1.
const SECOND_START = '2026-05-01'
const SECOND_END = '2026-05-31'
const SECOND_PAY = '2026-06-05'

async function gbPayrollOrg() {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
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
    const burdenExpense = await account('6010', 'Payroll burden', 'expense')
    const netPayable = await account('2300', 'Wages payable', 'liability_current')
    const hmrcPayable = await account('2330', 'HMRC PAYE/NIC payable', 'liability_current')
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({
        payroll: {
          wageExpenseAccountId: wageExpense,
          burdenExpenseAccountId: burdenExpense,
          netPayAccountId: netPayable,
          wagesTo: 'expense',
          countries: ['GB'],
        },
      })}::jsonb where id = ${org.orgId}`)
    await seedPayrollComponents(org.orgId, state.actorId, 'GB')
    await setPackSlotAccount(org.orgId, state.actorId, 'GB', 'paye', hmrcPayable)
    await setPackSlotAccount(org.orgId, state.actorId, 'GB', 'nic', hmrcPayable)
    const subsidiaryId = randomUUID()
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                is_elimination, is_active, custom)
      values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'GB Entity', 'GBP', 'GB',
              '{}'::jsonb, false, true, '{}'::jsonb)`)
    const scheduleId = randomUUID()
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, subsidiary_id, is_active,
                                 created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Monthly GB', 'monthly', 12, ${FIRST_END}, 5,
              ${subsidiaryId}, true, ${state.actorId}, ${state.actorId})`)
    const employeeId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'London Hire', ${subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`)
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                    effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, 'GBP', '36000', 'year', 2080, '2026-04-01', true,
              ${state.actorId}, ${state.actorId})`)
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                             province, pay_basis, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${scheduleId}, 'GB', 'ENG', 'salary', true,
              ${state.actorId}, ${state.actorId})`)
    return { org, scheduleId, employeeId }
  })
}

async function runOnce(orgId: string, scheduleId: string, periodStart: string, periodEnd: string, payDate: string) {
  return withBypassContext(async () => {
    const run = await createPayRun({
      orgId, actorId: state.actorId, payScheduleId: scheduleId, periodStart, periodEnd, payDate,
    })
    const result = await calculatePayRun({ orgId, documentId: run.documentId, actorId: state.actorId })
    return { run, result }
  })
}

const fileCertificate = (
  employeePartyId: string, certificateKey: string, answers: Record<string, string>, effectiveFrom: string,
) =>
  withOrgContext(state.orgId, () => POST(new Request('http://payroll.test', {
    method: 'POST',
    body: JSON.stringify({
      employeePartyId, country: 'GB', certificateKey, answers, effectiveFrom,
    }),
  })))

test('a GB employee refused for a missing P6/P9 code calculates after it is filed', { skip: !DB }, async () => {
  const { org, scheduleId, employeeId } = await gbPayrollOrg()
  try {
    // BEFORE: the pack's named refusal — the exact sentence the engine has
    // always produced, now reachable through the product. No stub is paid.
    const before = await runOnce(org.orgId, scheduleId, FIRST_START, FIRST_END, FIRST_PAY)
    assert.equal(before.result.errors.length, 1)
    assert.match(
      before.result.errors[0]!.message,
      /GB PAYE needs the employee's tax code from the P6\/P9 coding notice \(gb_tax_code_notice\): no notice is on file and this pack operates no emergency default/,
    )
    const noStub = await withBypassContext(async () => (await db.execute<{ count: string }>(sql`
      select count(*) as count from pay_stubs
       where org_id = ${org.orgId} and pay_run_document_id = ${before.run.documentId}`)).rows[0]!.count)
    assert.equal(noStub, '0')

    // THE FILINGS, through the new API — the moment five personas are blocked
    // on. The P6/P9 notice carries the code; the starter checklist carries
    // declaration A so the cumulative path past month 1 has its record.
    const filed = await fileCertificate(employeeId, 'gb_tax_code_notice', { tax_code: '1257L' }, '2026-04-06')
    assert.equal(filed.status, 200, await filed.clone().text())
    const starter = await fileCertificate(
      employeeId, 'gb_starter_checklist',
      { starter_declaration: 'A', student_loan_plan: 'none' }, '2026-04-01',
    )
    assert.equal(starter.status, 200, await starter.clone().text())

    // AFTER: the same employee computes. A PAYE deduction line prices above
    // zero and both NIC shares are present — gross-to-net through the product.
    const after = await runOnce(org.orgId, scheduleId, SECOND_START, SECOND_END, SECOND_PAY)
    assert.deepEqual(after.result.errors, [])
    const stub = await withBypassContext(async () => (await db.execute<{ id: string; gross: string }>(sql`
      select id, gross::text as gross from pay_stubs
       where org_id = ${org.orgId} and pay_run_document_id = ${after.run.documentId}
         and employee_party_id = ${employeeId}`)).rows[0])
    assert.ok(stub, 'the employee was paid')
    assert.equal(stub!.gross, '3000.0000')
    const lines = await withBypassContext(async () => (await db.execute<{
      system_key: string; description: string; amount: string;
    }>(sql`
      select c.system_key, l.description, l.amount::text as amount
        from pay_stub_lines l join pay_components c on c.id = l.component_id
       where l.org_id = ${org.orgId} and l.stub_id = ${stub!.id} and l.kind = 'deduction'
       order by l.sequence`)).rows)
    const paye = lines.find((line) => line.system_key === 'paye')
    assert.ok(paye, `a PAYE line exists among: ${lines.map((line) => line.description).join(', ')}`)
    assert.ok(Number(paye!.amount) > 0, `PAYE prices above zero, got ${paye!.amount}`)
    assert.ok(lines.some((line) => line.system_key === 'nic'), 'employee NIC prices alongside PAYE')
    await withBypassContext(async () => {
      await commitPayRun({ orgId: org.orgId, documentId: after.run.documentId, actorId: state.actorId })
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test.after(async () => { await pool.end() })
