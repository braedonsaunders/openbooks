import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Generic document endpoints answer a caller who lacks the kind's READ
 * grant exactly as for a nonexistent id — never a 403 naming the grant.
 * A caller who CAN read keeps the actionable 403 for a missing edit
 * grant. Two role sets (no-read vs read-only) × existing/missing ids ×
 * GET, PATCH, actions, correct, void and DELETE. Only the session is
 * stubbed; handler, permission resolution and storage are real.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __documentReadScopeUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__documentReadScopeUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH, DELETE } = await import('./route')
const { POST: act } = await import('../actions/route')
const { POST: correct } = await import('./correct/route')
const { POST: voidDoc } = await import('./void/route')
const DB = !!process.env.OPENBOOKS_DB_URL

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'tester', email: `tester-${id.slice(0, 8)}@scratch.test`, roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId,
    homeOrgId: orgId, homeUserId: id,
  }
}

async function makeDraftBill(orgId: string, subsidiaryId: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${id}, ${orgId}, 'vendor_bill', 'draft', ${'BILL-' + id.slice(0, 8)}, '2026-07-15', ${subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`))
  return id
}

/** A non-superadmin user whose role carries exactly the given grants. */
async function seedUser(orgId: string, key: string, permissions: string[]): Promise<void> {
  const userId = await withBypassContext(() => createScratchUser(orgId, key, key))
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${key}`))
  state.user = sessionUser(userId, orgId)
}

async function getJson(orgId: string, id: string) {
  const response = await withOrgContext(orgId, () =>
    GET(new Request(`http://documents.test/api/documents/${id}`), { params: Promise.resolve({ id }) }))
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

test('GET hides an unreadable bill as missing, symmetrically', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const bill = await makeDraftBill(org.orgId, org.subsidiaryId)
    await seedUser(org.orgId, 'ar_only', ['ar.read'])

    const existing = await getJson(org.orgId, bill)
    assert.equal(existing.status, 404, 'an existing unreadable bill is 404')
    assert.deepEqual(existing.json, { error: 'not found' })

    const missing = await getJson(org.orgId, randomUUID())
    assert.equal(missing.status, 404)
    assert.deepEqual(existing.json, missing.json, 'existing and missing read identically')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a reader still opens the bill', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const bill = await makeDraftBill(org.orgId, org.subsidiaryId)
    await seedUser(org.orgId, 'ap_reader', ['ap.read'])

    const found = await getJson(org.orgId, bill)
    assert.equal(found.status, 200)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('mutations hide unreadable bills as missing; readers keep the edit 403', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const bill = await makeDraftBill(org.orgId, org.subsidiaryId)
    const params = { params: Promise.resolve({ id: bill }) }
    const submit = { action: 'submit', documentId: bill }

    await seedUser(org.orgId, 'ar_only', ['ar.read'])
    const patchDenied = await withOrgContext(org.orgId, () =>
      PATCH(new Request(`http://documents.test/api/documents/${bill}`, { method: 'PATCH' }), params))
    assert.equal(patchDenied.status, 404, 'PATCH without read is 404')
    const actionsDenied = await withOrgContext(org.orgId, () =>
      act(new Request('http://documents.test/api/documents/actions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submit),
      })))
    assert.equal(actionsDenied.status, 404, 'actions without read is 404')
    const correctDenied = await withOrgContext(org.orgId, () =>
      correct(new Request(`http://documents.test/api/documents/${bill}/correct`, { method: 'POST' }), params))
    assert.equal(correctDenied.status, 404, 'correct without read is 404')
    const voidDenied = await withOrgContext(org.orgId, () =>
      voidDoc(new Request(`http://documents.test/api/documents/${bill}/void`, { method: 'POST' }), params))
    assert.equal(voidDenied.status, 404, 'void without read is 404')
    const deleteDenied = await withOrgContext(org.orgId, () =>
      DELETE(new Request(`http://documents.test/api/documents/${bill}`, { method: 'DELETE' }), params))
    assert.equal(deleteDenied.status, 404, 'DELETE without read is 404')

    await seedUser(org.orgId, 'ap_reader', ['ap.read'])
    const patchForbidden = await withOrgContext(org.orgId, () =>
      PATCH(new Request(`http://documents.test/api/documents/${bill}`, { method: 'PATCH' }), params))
    assert.equal(patchForbidden.status, 403, 'a reader keeps the actionable edit refusal')
    assert.match(String((await patchForbidden.json() as { error?: string }).error ?? ''), /ap\.create/)
    const actionsForbidden = await withOrgContext(org.orgId, () =>
      act(new Request('http://documents.test/api/documents/actions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submit),
      })))
    assert.equal(actionsForbidden.status, 403, 'submit keeps the actionable create refusal')
    assert.match(String((await actionsForbidden.json() as { error?: string }).error ?? ''), /ap\.create/)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
