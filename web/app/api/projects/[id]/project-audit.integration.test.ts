import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../../lib/auth'
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectAuditSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectAuditSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const projectRoute = await import('./route')

/**
 * Project header edits move billing caps (contract_value), ownership, and
 * legal-entity scope — the same material surface every other project write
 * audits. The autosave PATCH must leave a before/after audit row.
 */
test('project header edits write an audit row with before and after', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Project editor', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Project editor', email: 'editor@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    const project = randomUUID()
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values (${project},${org.orgId},${org.subsidiaryId},'AUD','Audit job',${org.customerId},'active',true,'{}'::jsonb)`)

    const res = await withOrgContext(org.orgId, () => projectRoute.PATCH(
      new Request('http://audit.local/api', { method: 'PATCH', body: JSON.stringify({ contractValue: '25000', status: 'active' }) }),
      { params: Promise.resolve({ id: project }) },
    ))
    assert.equal(res.status, 200)
    const rows = (await db.execute<{ changes: { contract_value: { before: unknown; after: unknown } } }>(sql`
      select changes from audit_log
       where org_id=${org.orgId} and table_name='projects' and row_id=${project} and action='update'
       order by id desc limit 1`)).rows
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0]!.changes.contract_value, { before: null, after: '25000.0000' })
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
