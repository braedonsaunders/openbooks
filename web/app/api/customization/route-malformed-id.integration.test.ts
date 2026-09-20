import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// The customization preference routes bind layoutId/viewId straight into a
// uuid-column probe, so a malformed value escapes as a raw Postgres uuid
// throw (HTTP 500) instead of the same 404 an unknown id returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __customPrefsIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__customPrefsIdState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../lib/customization/gates') return virtual(`
      export async function refuseDisabledRecordType() { return null }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PUT: putForm } = await import('./form-preferences/route.ts')
const { PUT: putList } = await import('./list-preferences/route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  // Inactive: an active user requires a role assignment (storage trigger),
  // and the preferences upsert only needs the user row to exist.
  const actorId = (await db.execute<{ id: string }>(sql`
    insert into users (org_id, email, name, password_hash, is_active)
    values (${org.orgId}, 'prefs@test.local', 'Prefs User', 'x', false)
    returning id`)).rows[0]!.id
  state.orgId = org.orgId
  state.actorId = actorId
  return org
}

async function put(
  handler: (req: Request) => Promise<Response>,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => handler(
      new Request('http://custom.test/api/customization/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

test('form-preferences rejects a malformed layoutId instead of throwing', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await put(putForm, { recordType: 'vendor_bill', layoutId: 'not-a-uuid' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('list-preferences rejects a malformed viewId instead of throwing', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await put(putList, { recordType: 'vendor_bill', viewId: 'not-a-uuid' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('unknown ids still return the not-found contract', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const form = await put(putForm, { recordType: 'vendor_bill', layoutId: randomUUID() })
    assert.equal(form.status, 404, JSON.stringify(form.json))
    const list = await put(putList, { recordType: 'vendor_bill', viewId: randomUUID() })
    assert.equal(list.status, 404, JSON.stringify(list.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('null ids still clear the preference', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const form = await put(putForm, { recordType: 'vendor_bill', layoutId: null })
    assert.equal(form.status, 200, JSON.stringify(form.json))
    const list = await put(putList, { recordType: 'vendor_bill', viewId: null })
    assert.equal(list.status, 200, JSON.stringify(list.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
