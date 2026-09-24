import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// PATCH on schedules and mandates used to answer {ok:true} after its write
// transaction matched zero rows — a missing id, another org's id, or a row
// deleted mid-flight read as a successful save. A write that matches zero
// rows is a failure: both branches now answer 404 like a missing row.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __payOpsPatchMissingRowState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__payOpsPatchMissingRowState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  mandateId: string
  scheduleId: string
}

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const bankAccountId = (await db.execute<{ id: string }>(sql`
    insert into party_bank_accounts (org_id, party_id, bank_name, currency, account_last_four, approved_at, approval_status, is_active)
    values (${org.orgId}, ${org.vendorId}, 'Test Bank', 'CAD', '1234', now()::date, 'approved', true)
    returning id`)).rows[0]!.id
  const mandateId = (await db.execute<{ id: string }>(sql`
    insert into payment_mandates (org_id, party_id, party_bank_account_id, scheme, mandate_reference, status)
    values (${org.orgId}, ${org.vendorId}, ${bankAccountId}, 'custom', 'MAND-MISSING-ROW-1', 'active')
    returning id`)).rows[0]!.id
  const formatId = (await db.execute<{ id: string }>(sql`
    insert into payment_formats (org_id, code, name, rail, direction, is_active)
    values (${org.orgId}, 'MISSINGROW', 'Missing-row format', 'custom', 'credit', true)
    returning id`)).rows[0]!.id
  const profileId = (await db.execute<{ id: string }>(sql`
    insert into payment_bank_profiles (org_id, name, bank_account_id, payment_format_id, currency, is_active)
    values (${org.orgId}, 'Missing-row profile', ${org.accounts.bank}, ${formatId}, 'CAD', true)
    returning id`)).rows[0]!.id
  const scheduleId = (await db.execute<{ id: string }>(sql`
    insert into payment_schedules (org_id, name, payment_bank_profile_id, cron, timezone, action, is_active)
    values (${org.orgId}, 'Missing-row schedule', ${profileId}, '0 9 * * *', 'UTC', 'create_draft', true)
    returning id`)).rows[0]!.id
  return { org, mandateId, scheduleId }
}

async function patch(resource: string, id: string, body: unknown): Promise<Response> {
  return withOrgContext(state.orgId, () => PATCH(
    new Request(`http://payops.test/api/admin/payment-operations/${resource}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ resource, id }) },
  ))
}

test('schedule PATCH on a missing id answers 404, never ok:true', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const response = await patch('schedules', randomUUID(), { name: 'Ghost rename' })
    assert.equal(response.status, 404, `expected 404, got ${response.status}: ${JSON.stringify(await response.clone().json())}`)
    assert.deepEqual(await response.json(), { error: 'not found' })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('mandate PATCH on a missing id answers 404, never ok:true', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const response = await patch('mandates', randomUUID(), { status: 'suspended' })
    assert.equal(response.status, 404, `expected 404, got ${response.status}: ${JSON.stringify(await response.clone().json())}`)
    assert.deepEqual(await response.json(), { error: 'not found' })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test("mandate PATCH on another org's id answers 404 and changes nothing", { skip: !DB }, async () => {
  const { org, mandateId } = await fixture()
  const other = await createScratchOrg()
  try {
    state.orgId = other.orgId
    state.actorId = randomUUID()
    const response = await patch('mandates', mandateId, { status: 'suspended' })
    assert.equal(response.status, 404, `expected 404, got ${response.status}: ${JSON.stringify(await response.clone().json())}`)
    const status = (await db.execute<{ status: string }>(sql`
      select status from payment_mandates where id = ${mandateId} and org_id = ${org.orgId}`)).rows[0]!.status
    assert.equal(status, 'active')
  } finally {
    await dropScratchOrg(org.orgId)
    await dropScratchOrg(other.orgId)
  }
})

test('schedule PATCH on an existing schedule still saves', { skip: !DB }, async () => {
  const { org, scheduleId } = await fixture()
  try {
    const response = await patch('schedules', scheduleId, { name: 'Renamed schedule' })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const name = (await db.execute<{ name: string }>(sql`
      select name from payment_schedules where id = ${scheduleId} and org_id = ${org.orgId}`)).rows[0]!.name
    assert.equal(name, 'Renamed schedule')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
