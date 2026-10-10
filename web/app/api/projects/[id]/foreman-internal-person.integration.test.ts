import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { SessionUser } from '../../../../lib/auth'

const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectForemanSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectForemanSession.user}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const header = await import('./route')

const patch = (orgId: string, id: string, body: Record<string, unknown>) =>
  withOrgContext(orgId, () => header.PATCH(new Request('http://audit.local/api', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }))

async function seedParty(orgId: string, kind: string, displayName: string, subsidiaryId: string | null): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active)
    values (${id}, ${orgId}, ${kind}, ${displayName}, ${subsidiaryId}, true)
  `)
  return id
}

/**
 * The header autosave enforces the same internal-person rule as create: a
 * non-employee person runs the crew, while customers, vendors, and other
 * orgs' parties refuse naming the foreman.
 */
test('project header PATCH moves the foreman to an internal person and refuses outsiders', async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Project editor', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Project editor', email: 'editor@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const project = randomUUID()
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'FORE-JOB','Foreman job','active',true)`)

    const partner = await seedParty(org.orgId, 'person', 'Dana Partner', org.subsidiaryId)
    const moved = await patch(org.orgId, project, { foremanId: partner })
    assert.equal(moved.status, 200, JSON.stringify(await moved.clone().json()))
    const stored = (await db.execute<{ foreman_id: string | null }>(sql`
      select foreman_id from projects where id=${project} and org_id=${org.orgId}`)).rows[0]?.foreman_id
    assert.equal(stored, partner)

    const vendor = await seedParty(org.orgId, 'vendor', 'Vera Vendor', org.subsidiaryId)
    const refused = await patch(org.orgId, project, { foremanId: vendor })
    assert.equal(refused.status, 422)
    assert.match(((await refused.json()) as { error: string }).error, /must be an active employee or internal person/)
    const unchanged = (await db.execute<{ foreman_id: string | null }>(sql`
      select foreman_id from projects where id=${project} and org_id=${org.orgId}`)).rows[0]?.foreman_id
    assert.equal(unchanged, partner, "a refused foreman leaves the stored link alone")
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
