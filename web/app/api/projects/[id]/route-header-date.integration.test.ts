import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../../lib/auth'
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectHeaderDateSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectHeaderDateSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const header = await import('./route')

const patch = (orgId: string, id: string, body: Record<string, unknown>) =>
  withOrgContext(orgId, () => header.PATCH(new Request('http://audit.local/api', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }))

/**
 * The header autosave forwards any shape-valid date to the projects row. An
 * impossible calendar day (2026-02-30) must fail closed as a 422 domain error
 * before any write — not reach the DATE columns and surface as a 500 from
 * PostgreSQL.
 */
test('project header PATCH refuses impossible start and end dates', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Project editor', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Project editor', email: 'editor@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const project = randomUUID()
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'HDR-DATE','Header date job',${org.customerId},'active',true)`)

    const badStart = await patch(org.orgId, project, { startsOn: '2026-02-30' })
    assert.equal(badStart.status, 422)
    assert.match((await badStart.json()).error, /Invalid start date/)

    const badEnd = await patch(org.orgId, project, { endsOn: '2026-02-30' })
    assert.equal(badEnd.status, 422)
    assert.match((await badEnd.json()).error, /Invalid end date/)

    const stored = (await db.execute<{ starts_on: string | null; ends_on: string | null }>(sql`
      select starts_on::text as starts_on, ends_on::text as ends_on from projects where id=${project} and org_id=${org.orgId}`)).rows[0]!
    assert.equal(stored.starts_on, null)
    assert.equal(stored.ends_on, null)

    // Real calendar days still save.
    const good = await patch(org.orgId, project, { startsOn: '2026-02-27', endsOn: '2026-02-28' })
    assert.equal(good.status, 200)
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
