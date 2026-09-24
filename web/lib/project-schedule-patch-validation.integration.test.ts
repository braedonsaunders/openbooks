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
 * Schedule patch values are interpolated into DATE and UUID columns. An
 * impossible calendar day or a malformed resource id must fail closed as a
 * domain error before any write — never escape as a PostgreSQL error (a 500).
 */
test('schedule task patches refuse impossible dates and malformed resource ids', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
      const projectId = randomUUID(), taskId = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, name, code)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Patch validation project', ${projectId})
      `)
      await db.execute(sql`
        insert into project_tasks (id, org_id, project_id, name, schedule_order)
        values (${taskId}, ${org.orgId}, ${projectId}, 'Patchable task', 1)
      `)

      await assert.rejects(
        updateScheduleTask(org.orgId, projectId, taskId, { startDate: '2026-02-30' }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /valid date/.test(error.message),
      )
      await assert.rejects(
        updateScheduleTask(org.orgId, projectId, taskId, { resourceAssignments: [{ resourceId: 'not-a-uuid', units: 1 }] }, actor, null),
        (error: unknown) => error instanceof ScheduleError && /valid resource/.test(error.message),
      )
      const untouched = (await db.execute<{ start: string | null; n: number }>(sql`
        select schedule_start::text as start,
               (select count(*)::int from schedule_task_assignments where org_id=${org.orgId} and task_id=${taskId}) as n
          from project_tasks where id=${taskId} and org_id=${org.orgId}`)).rows[0]!
      assert.equal(untouched.start, null)
      assert.equal(untouched.n, 0)

      // Real values still apply.
      await updateScheduleTask(org.orgId, projectId, taskId, { startDate: '2026-02-27', endDate: '2026-02-28' }, actor, null)
      assert.equal((await db.execute<{ start: string }>(sql`
        select schedule_start::text as start from project_tasks where id=${taskId} and org_id=${org.orgId}`)).rows[0]!.start, '2026-02-27')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
