import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectFlagsSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectFlagsSession.user}' }
  if (specifier === '../../../../lib/projects-gate') return { shortCircuit: true, url: 'data:text/javascript,export async function guardProjectsFeature(){return null}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const patchRequest = (id: string, body: unknown) => new Request(`http://flags.local/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

test('project PATCH refuses non-boolean flag values instead of a storage 500', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Project flags', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Project flags', email: 'project-flags@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const projectId = randomUUID()
    await db.execute(sql`insert into projects (id, org_id, name, is_active, custom) values (${projectId}, ${org.orgId}, 'Flag project', true, '{}'::jsonb)`)
    await withOrgContext(org.orgId, async () => {
      // 'off' is truthy JS but valid PG boolean false: today it silently
      // deactivates the project with a 200. 'maybe' is invalid PG boolean
      // and surfaces a raw storage 500. Both must be a 400 with no write.
      for (const body of [{ isActive: 'off' }, { subsidiaryIncludeChildren: 'maybe' }]) {
        const response = await PATCH(patchRequest(projectId, body), params(projectId))
        assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(await response.clone().json())}`)
      }
      const stored = (await db.execute<{ is_active: boolean }>(sql`select is_active from projects where id=${projectId} and org_id=${org.orgId}`)).rows[0]
      assert.equal(stored?.is_active, true, 'refused writes leave stored flags unchanged')
      const ok = await PATCH(patchRequest(projectId, { isActive: true }), params(projectId))
      assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()))
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
