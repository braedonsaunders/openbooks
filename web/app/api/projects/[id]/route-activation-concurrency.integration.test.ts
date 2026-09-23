import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectActivationConcurrencySession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectActivationConcurrencySession.user}' }
  if (specifier === '../../../../lib/projects-gate') return { shortCircuit: true, url: 'data:text/javascript,export async function guardProjectsFeature(){return null}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, pool, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route')

/**
 * Activation validated the name on a pre-lock read, so a concurrent
 * blank-name PATCH landing before the row lock produced an active nameless
 * project. The name is now re-validated on the locked row: this test holds
 * the row, fires an activation (which blocks on the lock), blanks the name
 * from the holder, and asserts the activation refuses instead of activating
 * a nameless project.
 */
test('activation re-validates the name under the row lock', async () => {
  const org = await createScratchOrg()
  const holder = await pool.connect()
  try {
    const actor = await createScratchUser(org.orgId, 'Project activation race', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Project activation race', email: 'project-activate@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const projectId = randomUUID()
    await db.execute(sql`insert into projects (id, org_id, name, is_active) values (${projectId}, ${org.orgId}, 'Real name', false)`)
    // Hold the project row lock in a separate session.
    await holder.query('BEGIN')
    await holder.query("select set_config('app.bypass_rls', 'on', false)")
    await holder.query('select name from projects where id = $1 for update', [projectId])
    // Fire the activation; it blocks on the held row lock once it reaches
    // its locked read — the entry name check has already passed on the
    // pre-lock "Real name" by the time we observe the block below.
    const pending = withOrgContext(org.orgId, () => PATCH(
      new Request(`http://race.local/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) }),
      { params: Promise.resolve({ id: projectId }) },
    ))
    const deadline = Date.now() + 15000
    for (;;) {
      const waiting = await db.execute<{ waiting: boolean }>(sql`
        select exists(
          select 1 from pg_stat_activity
           where wait_event_type = 'Lock' and query ilike '%from projects%for update%'
        ) as waiting`)
      if (waiting.rows[0]?.waiting) break
      if (Date.now() > deadline) throw new Error('PATCH never blocked on the project row lock')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Blank the name from the holder, then let the activation proceed.
    await holder.query('update projects set name = $2 where id = $1', [projectId, ''])
    await holder.query('COMMIT')
    const response = await pending
    assert.equal(response.status, 422, JSON.stringify(await response.json()))
    const stored = (await db.execute<{ name: string; is_active: boolean }>(sql`select name, is_active from projects where id=${projectId} and org_id=${org.orgId}`)).rows[0]
    assert.equal(stored?.is_active, false, 'a nameless project must not activate')
  } finally {
    try { await holder.query('ROLLBACK') } catch { /* already committed */ }
    holder.release()
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
