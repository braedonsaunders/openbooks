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
const { updateScheduleTask, ScheduleError } = await import('./project-schedule')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * The task outline is a project-bounded tree. A parent pin must name a task
 * in the SAME project, never the task itself, and never a descendant —
 * otherwise the outline silently corrupts (cross-project ghosts, self loops,
 * ancestor cycles) while the module promises project-bounded writes.
 */
test('schedule parent pins stay inside the project tree', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
      const projectA = randomUUID(), projectB = randomUUID()
      for (const [id, code] of [[projectA, 'TREE-A'], [projectB, 'TREE-B']] as const) {
        await db.execute(sql`
          insert into projects (id, org_id, subsidiary_id, name, code)
          values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${id})`)
      }
      const taskA = randomUUID(), taskB = randomUUID(), foreign = randomUUID()
      for (const [id, project, name] of [
        [taskA, projectA, 'Task A'],
        [taskB, projectA, 'Task B'],
        [foreign, projectB, 'Foreign task'],
      ] as const) {
        await db.execute(sql`
          insert into project_tasks (id, org_id, project_id, name, schedule_order)
          values (${id}, ${org.orgId}, ${project}, ${name}, 1)`)
      }
      const parentOf = async (id: string) =>
        (await db.execute<{ parent_id: string | null }>(sql`
          select parent_id from project_tasks where id = ${id} and org_id = ${org.orgId}`)).rows[0]!.parent_id

      // A task cannot parent to itself.
      await assert.rejects(
        updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: taskA }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
      )
      assert.equal(await parentOf(taskA), null)

      // A parent must live in the same project.
      await assert.rejects(
        updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: foreign }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
      )
      assert.equal(await parentOf(taskA), null)

      // A same-project parent applies, but closing the loop back must fail.
      await updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: taskB }, actor, null)
      assert.equal(await parentOf(taskA), taskB)
      await assert.rejects(
        updateScheduleTask(org.orgId, projectA, taskB, { parentTaskId: taskA }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
      )
      assert.equal(await parentOf(taskB), null)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
