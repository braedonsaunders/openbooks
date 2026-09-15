import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// PATCH must enforce the same status/action allowlists POST documents. An
// unknown mandate status silently disables direct-debit collection (only
// 'active' mandates join payment runs); an unknown schedule action silently
// degrades to draft behaviour so auto-submit never fires. Both must be 400.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __payOpsPatchAllowlistState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__payOpsPatchAllowlistState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
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
    values (${org.orgId}, ${org.vendorId}, ${bankAccountId}, 'custom', 'MAND-ALLOWLIST-1', 'active')
    returning id`)).rows[0]!.id
  const formatId = (await db.execute<{ id: string }>(sql`
    insert into payment_formats (org_id, code, name, rail, direction, is_active)
    values (${org.orgId}, 'ALLOWLIST', 'Allowlist format', 'custom', 'credit', true)
    returning id`)).rows[0]!.id
  const profileId = (await db.execute<{ id: string }>(sql`
    insert into payment_bank_profiles (org_id, name, bank_account_id, payment_format_id, currency, is_active)
    values (${org.orgId}, 'Allowlist profile', ${org.accounts.bank}, ${formatId}, 'CAD', true)
    returning id`)).rows[0]!.id
  const scheduleId = (await db.execute<{ id: string }>(sql`
    insert into payment_schedules (org_id, name, payment_bank_profile_id, cron, timezone, action, is_active)
    values (${org.orgId}, 'Allowlist schedule', ${profileId}, '0 9 * * *', 'UTC', 'create_draft', true)
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

async function mandateStatus(id: string, orgId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from payment_mandates where id = ${id} and org_id = ${orgId}`)).rows[0]!.status
}

async function scheduleAction(id: string, orgId: string): Promise<string> {
  return (await db.execute<{ action: string }>(sql`
    select action from payment_schedules where id = ${id} and org_id = ${orgId}`)).rows[0]!.action
}

test('mandate PATCH rejects an unknown status instead of storing it', { skip: !DB }, async () => {
  const { org, mandateId } = await fixture()
  try {
    const response = await patch('mandates', mandateId, { status: 'actvie' })
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(await response.clone().json())}`)
    assert.equal(await mandateStatus(mandateId, org.orgId), 'active', 'refused write must leave the stored status alone')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('mandate PATCH still accepts a known status', { skip: !DB }, async () => {
  const { org, mandateId } = await fixture()
  try {
    const response = await patch('mandates', mandateId, { status: 'suspended' })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal(await mandateStatus(mandateId, org.orgId), 'suspended')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('schedule PATCH rejects an unknown action instead of storing it', { skip: !DB }, async () => {
  const { org, scheduleId } = await fixture()
  try {
    const response = await patch('schedules', scheduleId, { action: 'submit_for_approva' })
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(await response.clone().json())}`)
    assert.equal(await scheduleAction(scheduleId, org.orgId), 'create_draft', 'refused write must leave the stored action alone')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('schedule PATCH still accepts a known action', { skip: !DB }, async () => {
  const { org, scheduleId } = await fixture()
  try {
    const response = await patch('schedules', scheduleId, { action: 'submit_for_approval' })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal(await scheduleAction(scheduleId, org.orgId), 'submit_for_approval')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
