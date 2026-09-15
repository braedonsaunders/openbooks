import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { db, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { createScheduleTask, ScheduleError } = await import('./project-schedule')

test('project schedule service refuses direct task creation when scheduling is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
      const projectId = randomUUID()
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projectScheduling}', 'false'::jsonb, true) where id = ${org.orgId}`)
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, name, code)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Schedule gate project', ${projectId})
      `)

      await assert.rejects(
        createScheduleTask(org.orgId, projectId, { name: 'Should not persist' }, actor),
        (error: unknown) => error instanceof ScheduleError && error.status === 404 && /project scheduling feature is disabled/i.test(error.message),
      )
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from project_tasks where org_id=${org.orgId} and project_id=${projectId}`)).rows[0]!.n,
        0,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
