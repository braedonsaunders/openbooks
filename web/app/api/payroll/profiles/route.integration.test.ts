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
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { PAYROLL_COUNTRY_PACKS } = await import('@openbooks/engine/src/payroll/packs.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { GET, POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * The countries the profile editor may offer, snapshotted once before any
 * test runs so a pack registered mid-file could never inflate it. (Nothing
 * in this file registers packs; the snapshot makes the derivation explicit.)
 */
const EXPECTED_COUNTRIES: readonly string[] = Object.keys(PAYROLL_COUNTRY_PACKS)

async function fixture() {
  // Scratch seeding runs under an explicit bypass boundary: importing the
  // route registers the web request-org resolver, which denies outside a
  // Next request store, so ambient setup would hit RLS (and reads would
  // silently return zero rows).
  return withBypassContext(async () => {
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
  })
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () => POST(new Request('http://payroll.test', { method: 'POST', body: JSON.stringify(body) })))
const get = (query = '') =>
  withOrgContext(state.orgId, () => GET(new Request(`http://payroll.test${query}`)))

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
    const rows = await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*) as count from employee_payroll_profiles where org_id = ${org.orgId}`))
    assert.equal(rows.rows[0]!.count, '0')
    // In-range values, including the column maximums at the route's own 2dp
    // contract (4dp money was already refused before this change), still save.
    const ok = await post({ ...base, federalClaimAmount: '999999999999999.99', vacationPercent: '999.9999' })
    assert.equal(ok.status, 200, await ok.clone().text())
    const saved = await withOrgContext(org.orgId, () => db.execute<{ federal_claim_amount: string; vacation_percent: string }>(sql`
      select federal_claim_amount::text, vacation_percent::text from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}`))
    assert.deepEqual(saved.rows[0], { federal_claim_amount: '999999999999999.9900', vacation_percent: '999.9999' })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile GET serves the packs declared subdivisions and withholding shapes', { skip: !DB }, async () => {
  // The editor renders whatever the installed packs declare: countries from
  // the registry, subdivision lists and labels from each pack's regions
  // coverage, withholding fields from its column-mapped certificates.
  const { org } = await fixture()
  try {
    const response = await get()
    assert.equal(response.status, 200, await response.clone().text())
    const body = (await response.json()) as {
      countries: string[]
      packProfiles: Record<string, {
        subdivisionLabel: string
        subdivisions: string[]
        supportedSubdivisions: string[]
        certificates: { key: string; form: string; scope: { level: string; region?: string } }[]
        exemptionFlags: { column: string }[]
      }>
    }
    // The contract is that the editor renders whatever the installed packs
    // declare — the registry's keys, in registry order — not a CA/US union.
    // This pinned ['CA', 'US'] and went red the day the registry opened past
    // two countries: a stale pin, not a regression. Derive it; the GET is the
    // runtime registration assertion, so every registered pack must also
    // declare its profile shape below.
    assert.deepEqual(body.countries, EXPECTED_COUNTRIES)
    assert.deepEqual(Object.keys(body.packProfiles), EXPECTED_COUNTRIES)
    for (const [country, profile] of Object.entries(body.packProfiles)) {
      assert.equal(typeof profile.subdivisionLabel, 'string', `${country} declares a subdivision label`)
      assert.ok(profile.subdivisionLabel.length > 0, `${country} subdivision label is non-empty`)
      assert.ok(Array.isArray(profile.subdivisions), `${country} declares subdivisions`)
      // Anchor the loop: an installable pack that supports no subdivision
      // would make every assertion below vacuous. installable-region-coverage
      // pins the same fact at the pack level; this pins it at the wire.
      assert.ok(
        profile.supportedSubdivisions.length > 0,
        `${country} serves at least one supported subdivision`,
      )
      for (const code of profile.supportedSubdivisions) {
        assert.ok(profile.subdivisions.includes(code), `${country} supports only a known subdivision: ${code}`)
      }
      assert.ok(Array.isArray(profile.certificates), `${country} declares certificates`)
      assert.ok(Array.isArray(profile.exemptionFlags), `${country} declares exemption flags`)
    }
    const ca = body.packProfiles['CA']!
    assert.equal(ca.subdivisionLabel, 'province')
    assert.ok(ca.subdivisions.includes('ON') && ca.subdivisions.includes('ZZ'))
    assert.deepEqual(ca.supportedSubdivisions, ca.subdivisions)
    assert.ok(ca.certificates.some((c) => c.key === 'ca_td1' && c.scope.level === 'country'))
    assert.ok(ca.certificates.some((c) => c.key === 'ca_td1_ON' && c.scope.region === 'ON'))
    assert.deepEqual(ca.exemptionFlags, [])
    const us = body.packProfiles['US']!
    assert.equal(us.subdivisionLabel, 'state')
    assert.ok(us.subdivisions.includes('CA') && us.subdivisions.includes('NY'))
    assert.ok(us.supportedSubdivisions.length < us.subdivisions.length)
    assert.ok(us.certificates.some((c) => c.key === 'us_w4'))
    assert.deepEqual(us.exemptionFlags.map((f) => f.column).sort(), ['fica_exempt', 'futa_exempt'])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST validates withholding answers against the pack declaration', { skip: !DB }, async () => {
  // Choice sets and count bands come from the pack's declared certificate
  // fields: the W-4's statuses and 0–99 allowances, the TD1's 0–10 codes.
  // An answer for a column the pack does not declare is refused.
  const { org, employeeId, scheduleId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, payScheduleId: scheduleId, payBasis: 'hourly' }
    const list = (await (await get()).json()) as {
      packProfiles: Record<string, { supportedSubdivisions: string[] }>
    }
    const usState = list.packProfiles['US']!.supportedSubdivisions[0]!
    for (const [label, patch, status, message] of [
      ['US filing status', { country: 'US', province: usState, filingStatus: 'single' }, 200, null],
      ['unknown status', { country: 'US', province: usState, filingStatus: 'separate' }, 422, /invalid filingStatus/],
      ['CA filing status', { country: 'CA', province: 'ON', filingStatus: 'single' }, 422, /invalid filingStatus/],
      ['CA claim code', { country: 'CA', province: 'ON', federalClaimCode: 5 }, 200, null],
      ['CA claim code band', { country: 'CA', province: 'ON', federalClaimCode: 11 }, 422, /claim code must be 0–10/],
      ['US claim code', { country: 'US', province: usState, federalClaimCode: 1 }, 422, /not declared/],
      ['US allowances', { country: 'US', province: usState, w4Allowances: 5 }, 200, null],
      ['US allowances band', { country: 'US', province: usState, w4Allowances: 100 }, 422, /invalid w4Allowances/],
      ['CA allowances', { country: 'CA', province: 'ON', w4Allowances: 1 }, 422, /invalid w4Allowances/],
    ] as const) {
      const response = await post({ ...base, ...patch })
      assert.equal(response.status, status, `${label}: ${await response.clone().text()}`)
      if (message) assert.match(((await response.json()) as { error: string }).error, message)
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test.after(async () => { await pool.end() })
