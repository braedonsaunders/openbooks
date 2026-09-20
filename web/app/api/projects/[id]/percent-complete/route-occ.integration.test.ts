import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __percentCompleteOCC: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__percentCompleteOCC.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PUT } = await import('./route')

/**
 * Two tabs setting one project's percent-complete override: the second PUT
 * carries the override value it rendered before the first PUT committed, so
 * it must fail with a 409 instead of silently re-basing revenue recognition
 * on a stale number. Single-scalar compare-and-swap on the displayed value —
 * no token plumbing, no false conflicts, exact intent preservation.
 */
test('a stale percent-complete override refuses instead of re-basing recognition', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Recognition owner', 'admin')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projects}', 'true'::jsonb, true) where id = ${org.orgId}`)
    session.user = { id: actor, orgId: org.orgId, name: 'Owner', email: 'owner@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const project = randomUUID()
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values (${project},${org.orgId},${org.subsidiaryId},'PCT-1','CAS job',${org.customerId},'active',true,'{}'::jsonb)`)
    const put = (body: object) => withOrgContext(org.orgId, () => PUT(new Request(`http://pct.local/api/projects/${project}/percent-complete`, {
      method: 'PUT', body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: project }) }))
    const liveOverride = async () => (await db.execute<{ override: string | null }>(sql`
      select nullif(custom->>'percentCompleteOverride', '') as override
        from projects where org_id = ${org.orgId} and id = ${project}`)).rows[0]!.override

    // Tab A sets 70 from the empty (null) override it rendered.
    const tabA = await put({ percentComplete: 70, expectedPercentComplete: null })
    assert.equal(tabA.status, 200, await tabA.clone().text())
    assert.equal(await liveOverride(), '70')
    // Tab B still renders the empty override: it must lose loudly, and the
    // live override must stay exactly what tab A wrote.
    const tabB = await put({ percentComplete: 80, expectedPercentComplete: null })
    assert.equal(tabB.status, 409)
    assert.equal(await liveOverride(), '70')
    // A tab that re-read after tab A saves cleanly.
    const tabC = await put({ percentComplete: 80, expectedPercentComplete: 70 })
    assert.equal(tabC.status, 200, await tabC.clone().text())
    assert.equal(await liveOverride(), '80')
    // A missing token is rejected before any work happens.
    assert.equal((await put({ percentComplete: 90 })).status, 409)
    assert.equal(await liveOverride(), '80')
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
