import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createScheduleDependency, createScheduleTask, ScheduleError } = await import('./project-schedule')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * Dependency and task-creation inputs land in CHECKed and typed columns. An
 * unknown relationship type, a non-finite or out-of-range lag, or a
 * non-numeric display order must fail closed as domain errors — never escape
 * as PostgreSQL errors (a 500).
 */
test('schedule dependency and task-creation inputs fail closed', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
      const project = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, name, code)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'Dependency inputs project', ${project})`)
      const taskA = await createScheduleTask(org.orgId, project, { name: 'Task A' }, actor, null)
      const taskB = await createScheduleTask(org.orgId, project, { name: 'Task B' }, actor, null)

      await assert.rejects(
        createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'XX' }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /dependency type/i.test(error.message),
      )
      await assert.rejects(
        createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, lagDays: 1e30 }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /lag/i.test(error.message),
      )
      await assert.rejects(
        createScheduleTask(org.orgId, project, { name: 'Bad order', order: 'oops' as unknown as number }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /order/i.test(error.message),
      )
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 0)

      // Legal values still persist.
      await createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'SS', lagDays: -2 }, actor, null)
      const good = await createScheduleTask(org.orgId, project, { name: 'Good order', order: 3 }, actor, null)
      assert.ok(good)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 1)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
