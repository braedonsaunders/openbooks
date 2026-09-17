import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __statementSendSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__statementSendSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext, registerRequestOrgResolver } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { randomUUID } = await import('node:crypto')
const send = await import('./route')
// This route's chain pulls in web/lib/request-org, which registers its
// Next-request resolver at import time and clobbers the test bypass the
// runner preload installed. Re-register last so fixtures keep authority;
// explicit withOrgContext blocks still take precedence per call.
registerRequestOrgResolver(() => ({ orgId: null, bypass: true }))

async function setup() {
  const org = await createScratchOrg()
  const actor = await createScratchUser(org.orgId, 'AR clerk', 'reviewer')
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
  session.user = { id: actor, orgId: org.orgId, name: 'AR clerk', email: 'ar@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  return org
}

/**
 * F-t02-010: statements go out from the customer/vendor drawer. The send
 * endpoint must prefill the party email, fail closed with a readable reason
 * when no transport is configured (never a 500, never a silent send), and
 * reject an explicitly invalid address before any render work.
 */
test('statement send prefills, validates, and fails closed without transport', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await setup()
  try {
    const params = Promise.resolve({ id: org.customerId })
    const prefill = await withOrgContext(org.orgId, () =>
      send.GET(new Request('http://audit.local/api?side=ar'), { params } as never))
    assert.equal(prefill.status, 200, JSON.stringify(await prefill.clone().json()))
    assert.deepEqual(await prefill.json(), { to: null, partyName: 'Acme Customer' })

    const missing = await withOrgContext(org.orgId, () =>
      send.GET(new Request('http://audit.local/api?side=ar'), { params: Promise.resolve({ id: randomUUID() }) } as never))
    assert.equal(missing.status, 404)

    const badTo = await withOrgContext(org.orgId, () =>
      send.POST(new Request('http://audit.local/api?side=ar', { method: 'POST', body: JSON.stringify({ to: 'not-an-email' }) }), { params } as never))
    assert.equal(badTo.status, 400)

    const unconfigured = await withOrgContext(org.orgId, () =>
      send.POST(new Request('http://audit.local/api?side=ar', { method: 'POST', body: JSON.stringify({ to: 'billing@example.com' }) }), { params } as never))
    assert.equal(unconfigured.status, 422)
    assert.match((await unconfigured.json() as { error: string }).error, /not configured/i)
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
