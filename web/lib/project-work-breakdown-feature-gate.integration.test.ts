import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { createWorkBreakdownTask } = await import('./project-work-breakdown')
const { ProjectWorkBreakdownError } = await import('./project-work-breakdown-validation')

test('WBS service refuses direct task creation when Projects is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
      const projectId = randomUUID()
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projects}', 'false'::jsonb, true) where id = ${org.orgId}`)
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, name, code)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Disabled Projects job', ${projectId})
      `)

      await assert.rejects(
        createWorkBreakdownTask({
          orgId: org.orgId,
          projectId,
          actorId: actor,
          allowedSubsidiaryIds: null,
          input: { code: null, name: 'Should not persist', status: 'open', estimatedHours: '1', estimatedCost: '10' },
        }),
        (error: unknown) => error instanceof ProjectWorkBreakdownError && error.status === 404 && /projects feature is disabled/i.test(error.message),
      )
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from project_tasks where org_id=${org.orgId}`)).rows[0]!.n,
        0,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
