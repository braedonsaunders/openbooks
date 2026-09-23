import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectCustomConcurrencySession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectCustomConcurrencySession.user}' }
  if (specifier === '../../../../lib/projects-gate') return { shortCircuit: true, url: 'data:text/javascript,export async function guardProjectsFeature(){return null}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, pool, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route')

/**
 * Two concurrent PATCHes for distinct custom keys used to merge against the
 * same pre-lock custom bag, so the second writer overwrote the first. The
 * merge now runs under the row lock: this test holds the project row in a
 * separate session, fires a PATCH (which blocks on the lock), commits a
 * competing custom bag from the holder, and asserts the PATCH merged against
 * the committed bag instead of overwriting it.
 */
test('concurrent custom PATCHes merge under the row lock instead of losing keys', async () => {
  const org = await createScratchOrg()
  const holder = await pool.connect()
  try {
    const actor = await createScratchUser(org.orgId, 'Project custom race', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Project custom race', email: 'project-race@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const projectId = randomUUID()
    await db.execute(sql`insert into projects (id, org_id, name, custom) values (${projectId}, ${org.orgId}, 'Custom race project', '{}'::jsonb)`)
    await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${org.orgId}, 'projects', 'key_a', 'Key A', 'text', '{}'::jsonb, false, true, ${actor}, ${actor}),
        (${randomUUID()}, ${org.orgId}, 'projects', 'key_b', 'Key B', 'text', '{}'::jsonb, false, true, ${actor}, ${actor})
    `)
    // Hold the project row lock in a separate session.
    await holder.query('BEGIN')
    await holder.query("select set_config('app.bypass_rls', 'on', false)")
    await holder.query('select custom from projects where id = $1 for update', [projectId])
    // Fire the PATCH; it blocks on the held row lock once it reaches its
    // locked read — everything before that (including any pre-lock custom
    // read) has already run by the time we observe the block below.
    const pending = withOrgContext(org.orgId, () => PATCH(
      new Request(`http://race.local/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ custom: { key_b: 'from-patch' } }) }),
      { params: Promise.resolve({ id: projectId }) },
    ))
    // A waiter on a held row lock shows in pg_stat_activity with its query
    // text (pending tuple locks are not reliably visible in pg_locks), so
    // the PATCH backend blocked inside its locked read is observable here.
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
    // Commit the competing bag from the holder, then let the PATCH proceed.
    await holder.query('update projects set custom = $2::jsonb where id = $1', [projectId, JSON.stringify({ key_a: 'from-holder' })])
    await holder.query('COMMIT')
    const response = await pending
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
    const stored = (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from projects where id=${projectId} and org_id=${org.orgId}`)).rows[0]?.custom
    assert.deepEqual(stored, { key_a: 'from-holder', key_b: 'from-patch' })
  } finally {
    try { await holder.query('ROLLBACK') } catch { /* already committed */ }
    holder.release()
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
