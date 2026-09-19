import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __payrollCertificateState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__payrollCertificateState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../lib/authz') return virtual(`
      export function guardSubsidiaryScope() { return null; }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db } = await import('@openbooks/engine/src/db.ts')
const { withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { GET, POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * The pack-declared certificate entry surface: every row-backed withholding
 * form any pack declares is storable here, validated against the declaration
 * — the surface the NL opgaaf and SV facts (and the DE ELStAM, the FR PAS
 * option) are entered through. No country, form or field is named below
 * except the pack under test.
 */

async function fixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
    const employeeId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Dutch Hire', true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, terminated_on)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`)
    return { org, employeeId }
  })
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () => POST(new Request('http://payroll.test', { method: 'POST', body: JSON.stringify(body) })))
const get = (employee: string) =>
  withOrgContext(state.orgId, () => GET(new Request(`http://payroll.test?employee=${employee}`)))

test('certificates GET serves every pack\'s row-backed forms and no column-backed ones', { skip: !DB }, async () => {
  const { org, employeeId } = await fixture()
  try {
    const response = await get(employeeId)
    assert.equal(response.status, 200, await response.clone().text())
    const body = (await response.json()) as {
      countries: string[]
      declarations: Record<string, { certificates: { key: string; storage: string }[] }>
      stored: unknown[]
    }
    assert.ok(body.countries.includes('NL'))
    const nl = body.declarations['NL']!.certificates.map((certificate) => certificate.key).sort()
    assert.deepEqual(nl, ['nl_loonheffingen', 'nl_premies'])
    // Column-backed certificates stay on the profile editor: serving them
    // here would offer two writable sources for one answer.
    for (const declaration of Object.values(body.declarations)) {
      for (const certificate of declaration.certificates) {
        assert.equal(certificate.storage, 'certificate_rows', certificate.key)
      }
    }
    assert.deepEqual(body.stored, [])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('certificates POST stores NL answers and a second save supersedes the first', { skip: !DB }, async () => {
  const { org, employeeId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, country: 'NL', effectiveFrom: '2026-01-01' }
    const first = await post({
      ...base,
      certificateKey: 'nl_premies',
      answers: { awf_laag: 'true', aof_hoog: 'false', whk_percent: '1.25' },
    })
    assert.equal(first.status, 200, await first.clone().text())
    const second = await post({
      ...base,
      certificateKey: 'nl_premies',
      effectiveFrom: '2026-06-01',
      answers: { awf_laag: 'true', aof_hoog: 'false', whk_percent: '2.00' },
    })
    assert.equal(second.status, 200, await second.clone().text())
    const rows = await withOrgContext(org.orgId, () => db.execute<{
      answers: Record<string, string>; effective_from: string; superseded_on: string | null
    }>(sql`
      select answers, effective_from::text as effective_from, superseded_on::text as superseded_on
        from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${employeeId}
         and certificate_key = 'nl_premies'
       order by effective_from`))
    assert.equal(rows.rows.length, 2)
    assert.deepEqual(rows.rows[0]!.answers, { awf_laag: 'true', aof_hoog: 'false', whk_percent: '1.25' })
    assert.equal(rows.rows[0]!.superseded_on, '2026-06-01')
    assert.deepEqual(rows.rows[1]!.answers, { awf_laag: 'true', aof_hoog: 'false', whk_percent: '2.00' })
    assert.equal(rows.rows[1]!.superseded_on, null)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('certificates POST refuses what the pack does not declare', { skip: !DB }, async () => {
  const { org, employeeId } = await fixture()
  try {
    const base = { employeePartyId: employeeId, country: 'NL', certificateKey: 'nl_premies', effectiveFrom: '2026-01-01' }
    // The phantom profile-column shape the NL engine used to read: not a
    // declared field, so refused rather than stored where nothing reads it.
    const phantom = await post({ ...base, answers: { nl_whk_percent: '1.25' } })
    assert.equal(phantom.status, 422, await phantom.clone().text())
    assert.match(((await phantom.json()) as { error: string }).error, /not a field/)
    // A Whk beschikking above 100% is not a premium percentage.
    const whk = await post({ ...base, answers: { whk_percent: '101' } })
    assert.equal(whk.status, 422, await whk.clone().text())
    // An unknown form for a known pack.
    const form = await post({ ...base, certificateKey: 'nl_elstam', answers: {} })
    assert.equal(form.status, 422, await form.clone().text())
    // A region on a country-level form.
    const region = await post({ ...base, region: 'NL', answers: { whk_percent: '1.25' } })
    assert.equal(region.status, 422, await region.clone().text())
    // Nothing was stored by any of the refusals.
    const rows = await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*) as count from employee_tax_certificates where org_id = ${org.orgId}`))
    assert.equal(rows.rows[0]!.count, '0')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
