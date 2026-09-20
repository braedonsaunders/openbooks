import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partyPlaceholderSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__partyPlaceholderSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const { PATCH, GET } = await import('./route')

/**
 * F-t12-007/F-t12-008: a new lead/prospect first save 422d with "a reason
 * between 5 and 500 characters is required for status and hold changes"
 * because the drawer sent isActive:true against the is_active=false draft.
 * The create path must send no status/hold change: naming a placeholder
 * draft without isActive completes (activates) it reason-free, while an
 * explicit isActive flip still demands the reason.
 */
test('naming a New-lead placeholder draft without isActive activates it reason-free', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'CRM rep', 'reviewer'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
    session.user = { id: actor, orgId: org.orgId, name: 'CRM rep', email: 'crm@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const draftId = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, created_by, updated_by)
      values (${draftId}, ${org.orgId}, 'company', 'New lead', false, ${actor}, ${actor})`))
    const params = { params: Promise.resolve({ id: draftId }) }

    const loaded = await withOrgContext(org.orgId, () => GET(new Request('http://audit.local/api'), params as never))
    assert.equal(loaded.status, 200, JSON.stringify(await loaded.clone().json()))
    const token = ((await loaded.json()) as { party: { updated_at: string } }).party.updated_at

    const completed = await withOrgContext(org.orgId, () => PATCH(new Request('http://audit.local/api', {
      method: 'PATCH', body: JSON.stringify({ displayName: 'T12 Test Lead 2', expectedUpdatedAt: token }),
    }), params as never))
    assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()))
    const stored = (await withBypassContext(() => db.execute<{ display_name: string; is_active: boolean }>(sql`
      select display_name, is_active from parties where id = ${draftId}`))).rows[0]!
    assert.equal(stored.display_name, 'T12 Test Lead 2')
    assert.equal(stored.is_active, true)

    // The guard the old client tripped stays: an explicit status flip with
    // no reason is still refused.
    const draft2 = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, created_by, updated_by)
      values (${draft2}, ${org.orgId}, 'company', 'New lead', false, ${actor}, ${actor})`))
    const params2 = { params: Promise.resolve({ id: draft2 }) }
    const loaded2 = await withOrgContext(org.orgId, () => GET(new Request('http://audit.local/api'), params2 as never))
    const token2 = ((await loaded2.json()) as { party: { updated_at: string } }).party.updated_at
    const refused = await withOrgContext(org.orgId, () => PATCH(new Request('http://audit.local/api', {
      method: 'PATCH', body: JSON.stringify({ displayName: 'T12 Test Lead 3', isActive: true, expectedUpdatedAt: token2 }),
    }), params2 as never))
    assert.equal(refused.status, 422)
    assert.match((await refused.json() as { error: string }).error, /reason between 5 and 500/i)
  } finally { session.user = null; await withBypassContext(() => dropScratchOrg(org.orgId)) }
})
