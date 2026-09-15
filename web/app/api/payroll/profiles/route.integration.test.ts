import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __payrollProfileState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__payrollProfileState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
  const employeeId = randomUUID()
  const scheduleId = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Sloppy Hire', true, '{}'::jsonb)`)
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, terminated_on)
    values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`)
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${state.actorId}, ${state.actorId})`)
  return { org, employeeId, scheduleId }
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () => POST(new Request('http://payroll.test', { method: 'POST', body: JSON.stringify(body) })))

test('profile POST refuses money and percent fields wider than their columns', { skip: !DB }, async () => {
  // Claim amounts are numeric(19,4) and vacation_percent numeric(7,4): pasted
  // figures wider than that cleared the exact-decimal check and died in the
  // upsert with a storage error. Fail closed with the named 422 instead.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, country: 'CA', province: 'ON', payBasis: 'hourly' }
    for (const [label, patch, message] of [
      ['claim amount', { federalClaimAmount: '99999999999999999999' }, /invalid federalClaimAmount/],
      ['vacation percent', { vacationPercent: '1234' }, /invalid vacationPercent/],
    ] as const) {
      const response = await post({ ...base, ...patch })
      assert.equal(response.status, 422, `${label}: ${await response.clone().text()}`)
      assert.match(((await response.json()) as { error: string }).error, message)
    }
    const rows = await db.execute<{ count: string }>(sql`
      select count(*) as count from employee_payroll_profiles where org_id = ${org.orgId}`)
    assert.equal(rows.rows[0]!.count, '0')
    // In-range values, including the column maximums at the route's own 2dp
    // contract (4dp money was already refused before this change), still save.
    const ok = await post({ ...base, federalClaimAmount: '999999999999999.99', vacationPercent: '999.9999' })
    assert.equal(ok.status, 200, await ok.clone().text())
    const saved = await db.execute<{ federal_claim_amount: string; vacation_percent: string }>(sql`
      select federal_claim_amount::text, vacation_percent::text from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`)
    assert.deepEqual(saved.rows[0], { federal_claim_amount: '999999999999999.9900', vacation_percent: '999.9999' })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test.after(async () => { await pool.end() })
