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
const { createScheduleDependency, createScheduleTask, deleteScheduleBaseline, deleteScheduleDependency, ScheduleError } = await import('./project-schedule')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/** Invalid scheduling inputs fail as domain errors before PostgreSQL writes. */
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

      for (const [attempt, reason] of [
        [() => createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'XX' }, actor, null), /dependency type/i],
        [() => createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, lagDays: 1e30 }, actor, null), /lag/i],
        [() => createScheduleTask(org.orgId, project, { name: 'Bad order', order: 'oops' as unknown as number }, actor, null), /order/i],
      ] as const) {
        await assert.rejects(attempt(), (error: unknown) => error instanceof ScheduleError && reason.test(error.message))
      }
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 0)

      // Legal values still persist.
      await createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'SS', lagDays: -2 }, actor, null)
      await createScheduleTask(org.orgId, project, { name: 'Good order', order: 3 }, actor, null)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 1)

      const otherProject = randomUUID()
      const baseline = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, name, code) values (${otherProject}, ${org.orgId}, ${org.subsidiaryId}, 'Other project', ${otherProject})`)
      await db.execute(sql`insert into schedule_baselines (id, org_id, project_id, name) values (${baseline}, ${org.orgId}, ${otherProject}, 'Other project baseline')`)
      await db.execute(sql`insert into schedule_baseline_tasks (org_id, baseline_id, task_id, task_name) values (${org.orgId}, ${baseline}, ${taskA}, 'Pinned snapshot')`)
      await assert.rejects(deleteScheduleBaseline(org.orgId, project, baseline, null),
        (error: unknown) => error instanceof ScheduleError && error.status === 404)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_baseline_tasks where baseline_id=${baseline}`)).rows[0]!.n, 1)
      await assert.rejects(deleteScheduleDependency(org.orgId, project, randomUUID(), null),
        (error: unknown) => error instanceof ScheduleError && error.status === 404)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
