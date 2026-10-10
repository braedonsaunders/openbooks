import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Estimates carry their own grants, apart from the receivables book: a
 * field owner with estimates.create prices quotes without gaining invoice
 * creation, while converting a quote still mints the downstream document
 * under the receivables book's own authority (ar.create).
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __estimatePermsSession: session })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual(`export async function currentUser(){return globalThis.__estimatePermsSession.user}`)
    }
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: postDraft } = await import('./route')
const { GET: getQuote } = await import('../[id]/route')
const { POST: postConvert } = await import('../[id]/convert/route')

async function setup(roleKey: string, permissions: string[]) {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Estimator', roleKey))
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${org.orgId} and key=${roleKey}`))
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb)
    where id = ${org.orgId}`))
  const asUser = () => {
    session.user = {
      id: actor, orgId: org.orgId, name: 'Estimator', email: 'estimator@scratch.test',
      roles: [], isSuperAdmin: false, envKind: 'production' as const,
      productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
    }
  }
  asUser()
  const close = async () => { session.user = null; await dropScratchOrg(org.orgId) }
  return { org, actor, asUser, close }
}

function draft(key: string) {
  return withOrgContext(session.user!.orgId, () =>
    postDraft(new Request('http://orders.test/api/estimates/draft', {
      method: 'POST', headers: { 'Idempotency-Key': key },
    })))
}

function read(id: string) {
  return withOrgContext(session.user!.orgId, () =>
    getQuote(new Request(`http://orders.test/api/estimates/${id}`, { method: 'GET' }), {
      params: Promise.resolve({ id }),
    } as never))
}

function convert(id: string, targetKind: string) {
  return withOrgContext(session.user!.orgId, () =>
    postConvert(new Request(`http://orders.test/api/estimates/${id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind }),
    }), { params: Promise.resolve({ id }) } as never))
}

test('estimates.create prices quotes without the receivables book', async () => {
  const f = await setup('estimator', ['estimates.read', 'estimates.create'])
  try {
    const created = await draft(randomUUID())
    assert.equal(created.status, 201, await created.clone().text())
    const { id } = await created.json() as { id: string }
    assert.equal((await read(id)).status, 200)
    // Minting the invoice keeps the receivables book's own authority.
    const invoice = await convert(id, 'customer_invoice')
    assert.equal(invoice.status, 403, await invoice.clone().text())
    assert.match(await invoice.text(), /ar\.create/)
  } finally { await f.close() }
})

test('receivables grants alone open no estimate surface', async () => {
  const f = await setup('arclerk', ['ar.read', 'ar.create'])
  try {
    assert.equal((await draft(randomUUID())).status, 403)
    assert.equal((await read(randomUUID())).status, 403)
  } finally { await f.close() }
})
