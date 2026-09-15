import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectCustomPreservationSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectCustomPreservationSession.user}' }
  if (specifier === '../../../../lib/projects-gate') return { shortCircuit: true, url: 'data:text/javascript,export async function guardProjectsFeature(){return null}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { PATCH } = await import('./route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const patchRequest = (id: string, body: unknown) => new Request(`http://audit.local/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

test('project PATCH preserves omitted required custom fields on a partial edit', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Project custom fields', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Project custom fields', email: 'project-custom@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const projectId = randomUUID()
    await db.execute(sql`insert into projects (id, org_id, name, custom) values (${projectId}, ${org.orgId}, 'Custom-field project', '{"required_code":"R-1"}'::jsonb)`)
    await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${org.orgId}, 'projects', 'required_code', 'Required code', 'text', '{}'::jsonb, true, true, ${actor}, ${actor}),
        (${randomUUID()}, ${org.orgId}, 'projects', 'optional_note', 'Optional note', 'text', '{}'::jsonb, false, true, ${actor}, ${actor})
    `)
    await withOrgContext(org.orgId, async () => {
      const response = await PATCH(patchRequest(projectId, { custom: { optional_note: 'updated' } }), params(projectId))
      assert.equal(response.status, 200, JSON.stringify(await response.json()))
      const stored = (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from projects where id=${projectId} and org_id=${org.orgId}`)).rows[0]?.custom
      assert.deepEqual(stored, { required_code: 'R-1', optional_note: 'updated' })
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
