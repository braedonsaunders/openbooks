import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __percentCompleteExplicit: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__percentCompleteExplicit.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PUT } = await import('./route')

/**
 * An omitted percentComplete with a matching expected token used to fall
 * through to the write as undefined and persist a JSON null — silently
 * clearing an existing override and resyncing revenue on a value nobody
 * typed. The key is now required: clearing is an explicit null, a missing
 * key is a 422, and neither path touches the stored override.
 */
test('an omitted percentComplete refuses instead of clearing the override', async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Recognition owner', 'admin')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projects}', 'true'::jsonb, true) where id = ${org.orgId}`)
    session.user = { id: actor, orgId: org.orgId, name: 'Owner', email: 'owner@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const project = randomUUID()
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values (${project},${org.orgId},${org.subsidiaryId},'PCT-E','Explicit job',${org.customerId},'active',true,'{"percentCompleteOverride": 62}'::jsonb)`)
    const put = (body: object) => withOrgContext(org.orgId, () => PUT(new Request(`http://pct.local/api/projects/${project}/percent-complete`, {
      method: 'PUT', body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: project }) }))
    const liveOverride = async () => (await db.execute<{ override: string | null }>(sql`
      select nullif(custom->>'percentCompleteOverride', '') as override
        from projects where org_id = ${org.orgId} and id = ${project}`)).rows[0]!.override

    // The exact shape that used to clear: a matching expected token, no value.
    const missing = await put({ expectedPercentComplete: 62 })
    assert.equal(missing.status, 422, await missing.clone().text())
    assert.match(await missing.clone().text(), /percentComplete is required/)
    assert.equal(await liveOverride(), '62')

    // An empty body refuses the same way.
    assert.equal((await put({})).status, 422)
    assert.equal(await liveOverride(), '62')

    // An explicit null still clears with intent.
    const clear = await put({ percentComplete: null, expectedPercentComplete: 62 })
    assert.equal(clear.status, 200, await clear.clone().text())
    assert.equal(await liveOverride(), null)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

/**
 * The override resyncs revenue, so the change must leave the same
 * before/after audit row every other material project write does — with the
 * actor, in the same transaction as the write it evidences.
 */
test('a percent-complete override writes a before/after audit row', async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Recognition owner', 'admin')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projects}', 'true'::jsonb, true) where id = ${org.orgId}`)
    session.user = { id: actor, orgId: org.orgId, name: 'Owner', email: 'owner@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const project = randomUUID()
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values (${project},${org.orgId},${org.subsidiaryId},'PCT-A','Audit job',${org.customerId},'active',true,'{"percentCompleteOverride": 62}'::jsonb)`)
    const res = await withOrgContext(org.orgId, () => PUT(new Request(`http://pct.local/api/projects/${project}/percent-complete`, {
      method: 'PUT', body: JSON.stringify({ percentComplete: 70, expectedPercentComplete: 62 }),
    }), { params: Promise.resolve({ id: project }) }))
    assert.equal(res.status, 200, await res.clone().text())
    const rows = (await db.execute<{ changes: { percentCompleteOverride: { before: unknown; after: unknown } }; actor_id: string }>(sql`
      select changes, actor_id from audit_log
       where org_id = ${org.orgId} and table_name = 'projects' and row_id = ${project} and action = 'update'
       order by id desc limit 1`)).rows
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0]!.changes.percentCompleteOverride, { before: 62, after: 70 })
    assert.equal(rows[0]!.actor_id, actor)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
